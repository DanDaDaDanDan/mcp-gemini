/**
 * Deep Research provider using Google's Deep Research Agent API
 *
 * Uses the @google/genai SDK's native interactions API (client.interactions).
 * The agent performs autonomous web research and returns comprehensive reports.
 */

import { GoogleGenAI } from "@google/genai";
import type { DeepResearchOptions, DeepResearchResult, ModelInfo, DeepResearchProvider } from "../types.js";
import { DEEP_RESEARCH_AGENT_ID } from "../types.js";
import { logger } from "../logger.js";

// Default timeout: 60 minutes (research can take up to 60 min, most complete in ~20)
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10 * 1000;

export class GeminiDeepResearchProvider implements DeepResearchProvider {
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("Gemini API key is required");
    }
    this.client = new GoogleGenAI({ apiKey });
    logger.info("Deep Research provider initialized", { agent: DEEP_RESEARCH_AGENT_ID });
  }

  /**
   * Start a deep research task and poll until completion
   */
  async research(options: DeepResearchOptions): Promise<DeepResearchResult> {
    const {
      query,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    } = options;

    const startTime = Date.now();

    logger.debugLog("Starting deep research", {
      queryLength: query.length,
      timeoutMs,
      pollIntervalMs,
    });

    // Start the research task
    const interactionId = await this.startResearch(query);
    logger.info("Deep research started", { interactionId });

    // Poll for completion
    const result = await this.pollForCompletion(interactionId, timeoutMs, pollIntervalMs, startTime);

    const durationMs = Date.now() - startTime;
    logger.info("Deep research completed", {
      interactionId,
      status: result.status,
      durationMs,
      resultLength: result.text.length,
    });

    return {
      ...result,
      interactionId,
      durationMs,
    };
  }

  /**
   * Start a new research interaction using the SDK
   */
  private async startResearch(query: string): Promise<string> {
    logger.debugLog("Deep research API request", {
      agent: DEEP_RESEARCH_AGENT_ID,
      queryPreview: query.substring(0, 200) + (query.length > 200 ? "..." : ""),
    });

    try {
      const interaction = await this.client.interactions.create({
        input: query,
        agent: DEEP_RESEARCH_AGENT_ID,
        background: true,
        agent_config: {
          type: "deep-research",
          thinking_summaries: "auto",
        },
      });

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

      if (error.status === 401 || error.status === 403 || message.includes("API_KEY_INVALID") || message.includes("API key")) {
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
   * Poll for research completion using the SDK
   */
  private async pollForCompletion(
    interactionId: string,
    timeoutMs: number,
    pollIntervalMs: number,
    startTime: number
  ): Promise<{ text: string; status: "completed" | "failed"; model: string }> {
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
        elapsedMinutes: Math.round(elapsed / 1000 / 60 * 10) / 10,
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

        if (!text) {
          throw new Error("API_ERROR: Research completed but no output text found");
        }

        return {
          text,
          status: "completed",
          model: "deep-research",
        };
      }

      if (interaction.status === "failed") {
        throw new Error("RESEARCH_FAILED: Research failed with unknown error");
      }

      if (interaction.status === "cancelled") {
        throw new Error("RESEARCH_CANCELLED: Research was cancelled");
      }

      await this.sleep(pollIntervalMs);
    }
  }

  /**
   * Extract text content from interaction outputs
   */
  private extractText(outputs?: Array<any>): string {
    if (!outputs) return "";
    return outputs
      .filter((output) => output.type === "text" && output.text)
      .map((output) => output.text)
      .join("\n\n");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check status of a running research task by interaction ID
   * Can be used to resume/retrieve results after a timeout
   */
  async checkResearch(interactionId: string): Promise<DeepResearchResult> {
    const startTime = Date.now();

    logger.info("Checking research status", { interactionId });

    try {
      const interaction = await this.client.interactions.get(interactionId);

      logger.info("Research status retrieved", {
        interactionId,
        status: interaction.status,
      });

      if (interaction.status === "completed") {
        const text = this.extractText(interaction.outputs);

        if (!text) {
          throw new Error("API_ERROR: Research completed but no output text found");
        }

        return {
          text,
          status: "completed",
          model: "deep-research",
          interactionId,
          durationMs: Date.now() - startTime,
        };
      }

      if (interaction.status === "failed") {
        throw new Error("RESEARCH_FAILED: Research failed with unknown error");
      }

      if (interaction.status === "cancelled") {
        throw new Error("RESEARCH_CANCELLED: Research was cancelled");
      }

      // Still in progress or requires_action
      return {
        text: `Research still in progress. Status: ${interaction.status}. Check again later using interaction ID: ${interactionId}`,
        status: "in_progress" as any,
        model: "deep-research",
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

  getModelInfo(): ModelInfo {
    return {
      id: "deep-research",
      name: "Deep Research Pro",
      provider: "google",
      type: "research",
      description:
        "AI research agent that autonomously searches the web, analyzes multiple sources, " +
        "and produces comprehensive research reports. Takes 5-60 minutes to complete.",
    };
  }
}
