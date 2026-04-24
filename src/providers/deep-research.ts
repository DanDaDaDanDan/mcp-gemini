/**
 * Deep Research provider using Google's Deep Research Agent API
 *
 * Uses the @google/genai SDK's native interactions API (client.interactions).
 * Supports both "deep-research" (fast) and "deep-research-max" (comprehensive)
 * agents introduced in April 2026, along with visualizations, collaborative
 * planning, MCP servers, file search, code execution, and multimodal inputs.
 */

import { GoogleGenAI } from "@google/genai";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type {
  DeepResearchOptions,
  DeepResearchResult,
  ModelInfo,
  DeepResearchProvider,
  SupportedResearchModel,
  ResearchImage,
  ResearchTool,
  McpServerConfig,
} from "../types.js";
import {
  RESEARCH_MODEL_IDS,
  DEFAULT_RESEARCH_MODEL,
} from "../types.js";
import { buildInlineAttachments } from "../attachments.js";
import { logger } from "../logger.js";

// Default timeout: 120 minutes (research can take up to 60 min, most complete in ~20)
const DEFAULT_TIMEOUT_MS = 120 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10 * 1000;

// Web tools that `disable_web: true` should strip
const WEB_TOOLS: ResearchTool[] = ["google_search", "url_context"];

/**
 * Convert an inline-data attachment into an Interactions-API typed content part,
 * or (for text-like MIME types) an inlined text part. The Deep Research
 * DocumentContent type only accepts application/pdf, so text/* and
 * application/json attachments must be inlined as text instead.
 */
function toInteractionContent(
  mimeType: string,
  base64: string,
  filenameHint?: string
): { type: "image" | "document" | "audio" | "video"; data: string; mime_type: string }
  | { type: "text"; text: string } {
  if (mimeType.startsWith("image/")) {
    return { type: "image", data: base64, mime_type: mimeType };
  }
  if (mimeType.startsWith("audio/")) {
    return { type: "audio", data: base64, mime_type: mimeType };
  }
  if (mimeType.startsWith("video/")) {
    return { type: "video", data: base64, mime_type: mimeType };
  }
  if (mimeType === "application/pdf") {
    return { type: "document", data: base64, mime_type: mimeType };
  }
  // text/* and other textual mimes — inline as text.
  const decoded = Buffer.from(base64, "base64").toString("utf-8");
  const label = filenameHint ? `Attached file: ${filenameHint} (${mimeType})` : `Attached file (${mimeType})`;
  return { type: "text", text: `[${label}]\n${decoded}\n[End of attached file]` };
}

export class GeminiDeepResearchProvider implements DeepResearchProvider {
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("Gemini API key is required");
    }
    this.client = new GoogleGenAI({ apiKey });
    logger.info("Deep Research provider initialized", {
      models: Object.keys(RESEARCH_MODEL_IDS),
      defaultModel: DEFAULT_RESEARCH_MODEL,
    });
  }

  async research(options: DeepResearchOptions): Promise<DeepResearchResult> {
    const {
      query,
      model = DEFAULT_RESEARCH_MODEL,
      visualization = "auto",
      thinkingSummaries = "auto",
      collaborativePlanning = false,
      tools = ["google_search", "url_context"],
      disableWeb = false,
      attachments = [],
      previousInteractionId,
      mcpServers = [],
      fileSearchStoreNames = [],
      outputDir,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    } = options;

    const startTime = Date.now();

    logger.debugLog("Starting deep research", {
      model,
      queryLength: query.length,
      visualization,
      thinkingSummaries,
      collaborativePlanning,
      tools,
      disableWeb,
      attachmentCount: attachments.length,
      mcpServerCount: mcpServers.length,
      hasPreviousInteraction: !!previousInteractionId,
      timeoutMs,
      pollIntervalMs,
    });

    const interactionId = await this.startResearch({
      query,
      model,
      visualization,
      thinkingSummaries,
      collaborativePlanning,
      tools,
      disableWeb,
      attachments,
      previousInteractionId,
      mcpServers,
      fileSearchStoreNames,
    });
    logger.info("Deep research started", { interactionId, model });

    // On the first turn of a collaborative_planning interaction, the API
    // completes with the research plan as the response body. Treat that as
    // our "requires_action" status so callers know to resume with
    // previous_interaction_id, not consume the plan as a final report.
    const isPlanTurn = collaborativePlanning && !previousInteractionId;

    const result = await this.pollForCompletion(
      interactionId,
      model,
      timeoutMs,
      pollIntervalMs,
      startTime,
      outputDir,
      isPlanTurn
    );

    const durationMs = Date.now() - startTime;
    logger.info("Deep research settled", {
      interactionId,
      status: result.status,
      durationMs,
      resultLength: result.text.length,
      imageCount: result.images?.length ?? 0,
    });

    return {
      ...result,
      interactionId,
      durationMs,
    };
  }

  /**
   * Build the agent_config + tools array and call interactions.create.
   */
  private async startResearch(opts: {
    query: string;
    model: SupportedResearchModel;
    visualization: "auto" | "off";
    thinkingSummaries: "auto" | "none";
    collaborativePlanning: boolean;
    tools: ResearchTool[];
    disableWeb: boolean;
    attachments: NonNullable<DeepResearchOptions["attachments"]>;
    previousInteractionId?: string;
    mcpServers: McpServerConfig[];
    fileSearchStoreNames: string[];
  }): Promise<string> {
    const agentId = RESEARCH_MODEL_IDS[opts.model];
    if (!agentId) {
      throw new Error(
        `VALIDATION_ERROR: Unknown research model "${opts.model}". Supported: ${Object.keys(RESEARCH_MODEL_IDS).join(", ")}`
      );
    }

    // Build input as a typed-content array. The Interactions API uses a
    // discriminated union per content part: { type: "text"|"image"|"document"|
    // "audio"|"video", ... }. String input also works when no attachments.
    let input: any = opts.query;
    if (opts.attachments.length > 0) {
      const rawParts = await buildInlineAttachments(opts.attachments);
      const typedParts = rawParts.map((p) =>
        toInteractionContent(p.inlineData.mimeType, p.inlineData.data, p.filename)
      );
      input = [{ type: "text", text: opts.query }, ...typedParts];
    }

    // Build tools array, filtering web tools when disableWeb is set.
    const activeTools = opts.disableWeb
      ? opts.tools.filter((t) => !WEB_TOOLS.includes(t))
      : opts.tools;

    // Each tool entry is a discriminated union: { type: "<name>", ...config }.
    const toolsArray: any[] = [];
    for (const tool of activeTools) {
      if (tool === "google_search") toolsArray.push({ type: "google_search" });
      else if (tool === "url_context") toolsArray.push({ type: "url_context" });
      else if (tool === "code_execution") toolsArray.push({ type: "code_execution" });
      else if (tool === "file_search") {
        const entry: any = { type: "file_search" };
        if (opts.fileSearchStoreNames.length > 0) {
          entry.file_search_store_names = opts.fileSearchStoreNames;
        }
        toolsArray.push(entry);
      }
    }
    for (const server of opts.mcpServers) {
      const entry: any = { type: "mcp_server", name: server.name, url: server.url };
      if (server.headers) entry.headers = server.headers;
      toolsArray.push(entry);
    }

    const agentConfig: any = {
      type: "deep-research",
      thinking_summaries: opts.thinkingSummaries,
      visualization: opts.visualization,
    };
    if (opts.collaborativePlanning) {
      agentConfig.collaborative_planning = true;
    }

    const request: any = {
      input,
      agent: agentId,
      background: true,
      agent_config: agentConfig,
    };
    if (toolsArray.length > 0) request.tools = toolsArray;
    if (opts.previousInteractionId) {
      request.previous_interaction_id = opts.previousInteractionId;
    }

    logger.debugLog("Deep research API request", {
      agent: agentId,
      queryPreview: opts.query.substring(0, 200) + (opts.query.length > 200 ? "..." : ""),
      toolCount: toolsArray.length,
      agentConfig,
      hasPreviousInteraction: !!opts.previousInteractionId,
    });

    try {
      const interaction = await this.client.interactions.create(request);

      logger.debugLog("Deep research started successfully", {
        interactionId: interaction.id,
        status: interaction.status,
      });

      if (!interaction.id) {
        throw new Error("API_ERROR: No interaction ID returned from API");
      }

      return interaction.id;
    } catch (error: any) {
      const message = error.message || String(error);

      logger.error("Deep research API error", {
        errorMessage: message,
        errorStatus: error.status,
      });

      if (
        error.status === 401 ||
        error.status === 403 ||
        message.includes("API_KEY_INVALID") ||
        message.includes("API key")
      ) {
        throw new Error(`AUTH_ERROR: ${message}`);
      } else if (error.status === 429 || message.includes("rate") || message.includes("quota")) {
        throw new Error(`RATE_LIMIT: ${message}`);
      } else if (message.startsWith("API_ERROR:")) {
        throw error;
      } else {
        throw new Error(`API_ERROR: ${message}`);
      }
    }
  }

  /**
   * Poll for research completion using the SDK.
   */
  private async pollForCompletion(
    interactionId: string,
    model: SupportedResearchModel,
    timeoutMs: number,
    pollIntervalMs: number,
    startTime: number,
    outputDir?: string,
    isPlanTurn: boolean = false
  ): Promise<{
    text: string;
    status: "completed" | "failed" | "requires_action";
    model: SupportedResearchModel;
    images?: ResearchImage[];
    plan?: string;
  }> {
    while (true) {
      const elapsed = Date.now() - startTime;

      if (elapsed > timeoutMs) {
        const minutes = Math.round(elapsed / 1000 / 60);
        throw new Error(
          `TIMEOUT: Research timed out after ${minutes} minutes. ` +
            `The research may still be running - interaction ID: ${interactionId}`
        );
      }

      logger.debugLog("Polling research status", {
        interactionId,
        elapsedMs: elapsed,
        elapsedMinutes: Math.round((elapsed / 1000 / 60) * 10) / 10,
      });

      const interaction = await this.client.interactions.get(interactionId);

      logger.debugLog("Research poll response", {
        interactionId,
        status: interaction.status,
        elapsedMs: elapsed,
        hasOutputs: !!interaction.outputs,
        outputCount: interaction.outputs?.length,
      });

      if (interaction.status === "completed") {
        const text = this.extractText(interaction.outputs);
        const images = this.extractImages(interaction.outputs, interactionId, outputDir);

        if (!text && (!images || images.length === 0)) {
          throw new Error("API_ERROR: Research completed but no output text or images found");
        }

        // First turn of a collaborative-planning interaction completes with the
        // plan itself — re-surface as requires_action so callers know to resume.
        if (isPlanTurn) {
          return { text, status: "requires_action", model, plan: text };
        }
        return { text, status: "completed", model, images };
      }

      // `requires_action` is used for other agent types (function calling);
      // also surface any text content in case Deep Research ever uses it too.
      if (interaction.status === "requires_action") {
        const text = this.extractText(interaction.outputs);
        return {
          text,
          status: "requires_action",
          model,
          plan: text,
        };
      }

      if (interaction.status === "failed") {
        throw new Error("RESEARCH_FAILED: Research failed with unknown error");
      }

      if (interaction.status === "cancelled") {
        throw new Error("RESEARCH_CANCELLED: Research was cancelled");
      }

      if (interaction.status === "in_progress") {
        await this.sleep(pollIntervalMs);
        continue;
      }

      // Unknown status — fail hard so we learn and can fix.
      throw new Error(
        `API_ERROR: Unrecognized interaction status "${interaction.status}" for ${interactionId}. ` +
          `Full interaction: ${JSON.stringify(interaction).slice(0, 500)}`
      );
    }
  }

  /**
   * Extract text content from interaction outputs.
   */
  private extractText(outputs?: Array<any>): string {
    if (!outputs) return "";
    return outputs
      .filter((output) => output.type === "text" && output.text)
      .map((output) => output.text)
      .join("\n\n");
  }

  /**
   * Extract any inline images (infographics/charts) from outputs and write
   * them to outputDir. Fails hard on any unrecognized non-text output so we
   * learn the real response shape rather than silently dropping data.
   *
   * The Interactions API returns each output as a typed content variant:
   *   TextContent:  { type: "text", text, annotations? }
   *   ImageContent: { type: "image", data?, mime_type?, uri?, resolution? }
   *   DocumentContent / AudioContent / VideoContent: same shape
   *   ToolCallContent / ToolResultContent / FileSearchCallContent / etc.
   */
  private extractImages(
    outputs: Array<any> | undefined,
    interactionId: string,
    outputDir?: string
  ): ResearchImage[] | undefined {
    if (!outputs) return undefined;

    const candidates: Array<{ data: string; mimeType: string }> = [];

    // Output types we know exist but that don't carry image data; skip silently.
    const NON_IMAGE_KNOWN_TYPES = new Set([
      "text",
      "google_search_call",
      "url_context_call",
      "code_execution_call",
      "file_search_call",
      "file_search_result",
      "mcp_server_call",
      "tool_call",
      "tool_result",
      "reasoning",
      "thought",
    ]);

    for (const output of outputs) {
      const type = output.type;
      if (NON_IMAGE_KNOWN_TYPES.has(type)) continue;

      if (type === "image" && output.data) {
        candidates.push({
          data: output.data,
          mimeType: output.mime_type || "image/png",
        });
        continue;
      }

      // Unknown type — fail hard so we learn what it is.
      throw new Error(
        `API_ERROR: Unrecognized research output (type="${type}", keys=${Object.keys(output).join(",")}): ` +
          `${JSON.stringify(output).slice(0, 400)}`
      );
    }

    if (candidates.length === 0) return undefined;

    // Always include base64 data so callers can embed inline. Persist to disk
    // only when outputDir is explicitly provided.
    let persist = false;
    if (outputDir) {
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }
      persist = true;
    }

    const images: ResearchImage[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const { data, mimeType } = candidates[i];
      const img: ResearchImage = { data, mimeType };
      if (persist) {
        const ext = mimeType.split("/")[1]?.split("+")[0] || "png";
        const path = join(outputDir!, `${interactionId}-${i + 1}.${ext}`);
        writeFileSync(path, Buffer.from(data, "base64"));
        img.path = path;
        logger.debugLog("Saved research image", { path, mimeType });
      }
      images.push(img);
    }

    return images;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check status of a running research task by interaction ID.
   * Can be used to resume/retrieve results after a timeout.
   */
  async checkResearch(
    interactionId: string,
    outputDir?: string
  ): Promise<DeepResearchResult> {
    const startTime = Date.now();

    logger.info("Checking research status", { interactionId });

    try {
      const interaction = await this.client.interactions.get(interactionId);

      logger.info("Research status retrieved", {
        interactionId,
        status: interaction.status,
      });

      // We don't know the friendly model name from the interaction alone; the
      // agent field on the interaction would tell us, but it's the API ID. Map
      // back if we can, otherwise fall back to the default.
      const model = this.resolveModelFromAgentId((interaction as any).agent) ?? DEFAULT_RESEARCH_MODEL;

      if (interaction.status === "completed") {
        const text = this.extractText(interaction.outputs);
        const images = this.extractImages(interaction.outputs, interactionId, outputDir);

        if (!text && (!images || images.length === 0)) {
          throw new Error("API_ERROR: Research completed but no output text or images found");
        }

        return {
          text,
          status: "completed",
          model,
          interactionId,
          durationMs: Date.now() - startTime,
          images,
        };
      }

      if (interaction.status === "requires_action") {
        const text = this.extractText(interaction.outputs);
        return {
          text,
          status: "requires_action",
          model,
          interactionId,
          durationMs: Date.now() - startTime,
          plan: text,
        };
      }

      if (interaction.status === "failed") {
        throw new Error("RESEARCH_FAILED: Research failed with unknown error");
      }

      if (interaction.status === "cancelled") {
        throw new Error("RESEARCH_CANCELLED: Research was cancelled");
      }

      // Still in progress
      return {
        text: `Research still in progress. Status: ${interaction.status}. Check again later using interaction ID: ${interactionId}`,
        status: "in_progress",
        model,
        interactionId,
        durationMs: Date.now() - startTime,
      };
    } catch (error: any) {
      if (error.message?.startsWith("RESEARCH_")) {
        throw error;
      }

      const message = error.message || String(error);

      if (error.status === 404) {
        throw new Error(`NOT_FOUND: Research task not found - interaction ID: ${interactionId}`);
      }
      throw new Error(`API_ERROR: Failed to check research status: ${message}`);
    }
  }

  private resolveModelFromAgentId(agentId?: string): SupportedResearchModel | undefined {
    if (!agentId) return undefined;
    for (const [friendly, api] of Object.entries(RESEARCH_MODEL_IDS)) {
      if (api === agentId) return friendly as SupportedResearchModel;
    }
    return undefined;
  }

  getModelInfo(model: SupportedResearchModel = DEFAULT_RESEARCH_MODEL): ModelInfo {
    const infos: Record<SupportedResearchModel, ModelInfo> = {
      "deep-research": {
        id: "deep-research",
        name: "Gemini Deep Research",
        provider: "google",
        type: "research",
        description:
          "Fast autonomous research agent (Gemini 3.1 Pro) optimized for speed and reduced cost. " +
          "Best for shorter, interactive research tasks.",
      },
      "deep-research-max": {
        id: "deep-research-max",
        name: "Gemini Deep Research Max",
        provider: "google",
        type: "research",
        description:
          "Comprehensive autonomous research agent (Gemini 3.1 Pro) with extended test-time compute. " +
          "Produces thorough, deeply-cited reports with inline charts and infographics. " +
          "Typically takes 10-60 minutes.",
      },
    };
    return infos[model];
  }
}
