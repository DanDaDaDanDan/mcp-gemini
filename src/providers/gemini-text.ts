/**
 * Gemini 3 Pro/Flash text provider with thinking capabilities
 *
 * Uses the new @google/genai SDK which supports thinkingConfig
 */

import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type {
  TextGenerateOptions,
  GenerateResult,
  ModelInfo,
  TextProvider,
  SupportedTextModel,
  ThinkingLevelOption,
} from "../types.js";
import {
  TEXT_MODEL_IDS,
  DEFAULT_TEXT_MODEL,
  SUPPORTED_MIME_TYPES,
  validateThinkingLevel,
} from "../types.js";
import { FILE_TOOL_DEFINITIONS, executeFileTool } from "../file-tools.js";
import { logger } from "../logger.js";
import { withRetry, withTimeout } from "../retry.js";
import { calculateTextCost } from "../pricing.js";
import { costTracker } from "../cost-tracker.js";
import { readFileSync, existsSync } from "fs";
import { basename, extname } from "path";

/**
 * Map user-facing thinking level strings to SDK enum values.
 */
const THINKING_LEVEL_MAP: Record<ThinkingLevelOption, string> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * Get MIME type for a file path. Throws if file type is not supported.
 */
function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeType = SUPPORTED_MIME_TYPES[ext];
  if (!mimeType) {
    const supportedExts = Object.keys(SUPPORTED_MIME_TYPES).join(", ");
    throw new Error(
      `Unsupported file type "${ext}". Supported types: ${supportedExts}`
    );
  }
  return mimeType;
}

// Default timeout for generation requests (120 minutes for extended thinking)
const DEFAULT_TIMEOUT_MS = 120 * 60 * 1000;

export class GeminiTextProvider implements TextProvider {
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("Gemini API key is required");
    }
    this.client = new GoogleGenAI({ apiKey });
    logger.info("Gemini text provider initialized", {
      supportedModels: Object.keys(TEXT_MODEL_IDS),
      defaultModel: DEFAULT_TEXT_MODEL,
    });
  }

  async generate(options: TextGenerateOptions): Promise<GenerateResult> {
    const {
      prompt,
      systemPrompt,
      model = DEFAULT_TEXT_MODEL,
      thinkingLevel = "high",
      maxTokens = 65536,
      temperature = 0.7,
      attachments = [],
      enableTools = false,
    } = options;
    const startTime = Date.now();

    // Resolve API model ID
    const apiModelId = TEXT_MODEL_IDS[model];

    // Validate thinking level is supported by the selected model
    const validationError = validateThinkingLevel(model, thinkingLevel);
    if (validationError) {
      throw new Error(`VALIDATION_ERROR: ${validationError}`);
    }

    // Construct the full prompt with system instructions
    let textPrompt = prompt;
    if (systemPrompt) {
      textPrompt = `<system>\n${systemPrompt}\n</system>\n\n${prompt}`;
    }

    logger.debugLog("Starting text generation", {
      model,
      apiModelId,
      promptLength: prompt.length,
      hasSystemPrompt: !!systemPrompt,
      thinkingLevel,
      maxTokens,
      temperature,
      attachmentCount: attachments.length,
    });

    // Build contents array for multimodal input
    const contents: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

    // Add attachments if provided (images, audio, video, PDFs, text files)
    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i];
      const sources = [attachment.path, attachment.data, attachment.url].filter(Boolean);
      if (sources.length !== 1) {
        throw new Error(
          `VALIDATION_ERROR: Attachment ${i}: exactly one of 'path', 'data', or 'url' must be provided (got ${sources.length})`
        );
      }

      let mimeType: string | undefined = attachment.media_type;
      let base64Data: string;

      if (attachment.path) {
        if (!existsSync(attachment.path)) {
          throw new Error(`File not found: ${attachment.path}`);
        }
        if (!mimeType) {
          mimeType = getMimeType(attachment.path);
        }
        base64Data = readFileSync(attachment.path, { encoding: "base64" });
        logger.debugLog("Added file attachment", { path: attachment.path, mimeType });
      } else if (attachment.data) {
        if (!mimeType) {
          throw new Error(`VALIDATION_ERROR: Attachment ${i}: 'media_type' is required when using 'data'`);
        }
        // Handle both raw base64 and data URI formats
        if (attachment.data.startsWith("data:")) {
          const match = attachment.data.match(/^data:([^;]+);base64,(.+)$/);
          if (!match) {
            throw new Error(`VALIDATION_ERROR: Attachment ${i}: invalid data URI format`);
          }
          base64Data = match[2];
        } else {
          base64Data = attachment.data;
        }
        logger.debugLog("Added base64 attachment", { mimeType, dataLength: base64Data.length });
      } else {
        // URL — fetch and inline since Gemini requires inline data
        if (!mimeType) {
          throw new Error(`VALIDATION_ERROR: Attachment ${i}: 'media_type' is required when using 'url'`);
        }
        const response = await fetch(attachment.url!);
        if (!response.ok) {
          throw new Error(`VALIDATION_ERROR: Attachment ${i}: failed to fetch URL: ${response.status} ${response.statusText}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        base64Data = buffer.toString("base64");
        logger.debugLog("Added URL attachment", { url: attachment.url, mimeType });
      }

      contents.push({ inlineData: { mimeType: mimeType!, data: base64Data } });
    }

    // Add text prompt
    contents.push({ text: textPrompt });

    try {
      // Build config object for the new SDK
      const config: any = {
        maxOutputTokens: maxTokens,
        temperature: temperature,
        thinkingConfig: {
          // Map user-facing level to SDK enum
          thinkingLevel: THINKING_LEVEL_MAP[thinkingLevel],
          // Include thought summaries for transparency
          includeThoughts: true,
        },
      };

      // Add file tools if enabled
      if (enableTools) {
        config.tools = [{
          functionDeclarations: FILE_TOOL_DEFINITIONS.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        }];
      }

      logger.debugLog("Text generation API request", {
        model,
        apiModelId,
        config: {
          maxOutputTokens: config.maxOutputTokens,
          temperature: config.temperature,
          thinkingLevel: config.thinkingConfig.thinkingLevel,
          includeThoughts: config.thinkingConfig.includeThoughts,
        },
        contentsCount: contents.length,
        attachmentCount: attachments.length,
      });

      // Use retry wrapper for transient errors and timeout protection
      let response = await withRetry(
        () =>
          withTimeout(
            () =>
              this.client.models.generateContent({
                model: apiModelId,
                contents,
                config,
              }),
            DEFAULT_TIMEOUT_MS
          ),
        {
          maxRetries: 2,
          retryableErrors: ["RATE_LIMIT", "429", "503", "502", "ECONNRESET", "ETIMEDOUT"],
        }
      );

      // Agentic tool-calling loop: let the model call file tools until it produces a final answer
      if (enableTools) {
        // Track conversation for multi-turn
        const conversationContents: any[] = [
          { role: "user", parts: contents.map((c: any) => c.text ? { text: c.text } : { inlineData: c.inlineData }) },
        ];
        let toolRound = 0;

        while (true) {
          const parts = response.candidates?.[0]?.content?.parts || [];
          const functionCalls = parts.filter((p: any) => p.functionCall);
          if (functionCalls.length === 0) break;

          toolRound++;
          logger.debugLog("Tool call round", {
            round: toolRound,
            toolCalls: functionCalls.map((fc: any) => ({ name: fc.functionCall.name, args: fc.functionCall.args })),
          });

          // Add model response to conversation
          conversationContents.push({ role: "model", parts });

          // Execute tools and add results
          const functionResponses = functionCalls.map((fc: any) => {
            const result = executeFileTool(fc.functionCall.name, fc.functionCall.args || {});
            logger.debugLog("Tool result", {
              tool: fc.functionCall.name,
              resultLength: result.length,
            });
            return {
              functionResponse: {
                name: fc.functionCall.name,
                response: { result },
              },
            };
          });

          conversationContents.push({ role: "user", parts: functionResponses });

          // Continue conversation
          response = await withRetry(
            () =>
              withTimeout(
                () =>
                  this.client.models.generateContent({
                    model: apiModelId,
                    contents: conversationContents,
                    config,
                  }),
                DEFAULT_TIMEOUT_MS
              ),
            {
              maxRetries: 2,
              retryableErrors: ["RATE_LIMIT", "429", "503", "502", "ECONNRESET", "ETIMEDOUT"],
            }
          );
        }

        if (toolRound > 0) {
          logger.debugLog("Tool calling completed", { totalRounds: toolRound });
        }
      }

      logger.debugLog("Text generation API response", {
        model,
        apiModelId,
        hasText: !!response.text,
        hasCandidates: !!response.candidates?.length,
        candidateCount: response.candidates?.length,
        usageMetadata: response.usageMetadata,
      });

      // Extract text from response
      // The new SDK returns text directly or via candidates
      let text = "";
      let thoughtSummary = "";

      if (response.text) {
        text = response.text;
      } else if (response.candidates && response.candidates.length > 0) {
        // Process parts to separate thoughts from answer
        for (const part of response.candidates[0].content?.parts || []) {
          if (part.text) {
            if ((part as any).thought) {
              thoughtSummary += part.text + "\n";
            } else {
              text += part.text;
            }
          }
        }
      }

      // Get usage metadata
      const usageMetadata = response.usageMetadata;
      const durationMs = Date.now() - startTime;

      const usage = usageMetadata
        ? {
            promptTokens: usageMetadata.promptTokenCount,
            completionTokens: usageMetadata.candidatesTokenCount,
            totalTokens: usageMetadata.totalTokenCount,
            // Thinking tokens from Gemini 3 Pro
            thoughtsTokens: usageMetadata.thoughtsTokenCount,
          }
        : undefined;

      // Log usage statistics
      logger.logUsage({
        timestamp: new Date().toISOString(),
        provider: "gemini",
        model,
        operation: "generate_text",
        durationMs,
        success: true,
        metrics: usage ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          thoughtsTokens: usage.thoughtsTokens,
        } : undefined,
      });

      // Include thought summary in response if available
      const finalText = thoughtSummary
        ? `${text}\n\n---\n**Thinking Summary:**\n${thoughtSummary}`
        : text;

      // Calculate cost
      const cost = calculateTextCost(
        model,
        usage?.promptTokens || 0,
        usage?.completionTokens || 0,
        usage?.thoughtsTokens || 0
      );

      // Track cost
      costTracker.trackCost({
        timestamp: new Date().toISOString(),
        model,
        operation: "generate_text",
        inputCost: cost.inputCost,
        outputCost: cost.outputCost,
        totalCost: cost.totalCost,
        estimated: cost.estimated,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        thoughtsTokens: usage?.thoughtsTokens,
      });

      return {
        text: finalText,
        model,
        usage,
        cost,
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      let errorType = "GENERATION_ERROR";
      let errorMessage = error.message || "Unknown error during generation";

      logger.error("Text generation API error", {
        model,
        apiModelId,
        errorName: error.name,
        errorMessage: error.message,
        errorStack: error.stack?.split("\n").slice(0, 5).join("\n"),
        durationMs,
      });

      // Handle specific Gemini API errors
      if (error.message?.includes("API key") || error.message?.includes("API_KEY")) {
        errorType = "AUTH_ERROR";
        errorMessage = "Invalid or missing Gemini API key";
      } else if (
        error.message?.includes("quota") ||
        error.message?.includes("rate") ||
        error.message?.includes("429")
      ) {
        errorType = "RATE_LIMIT";
        errorMessage = "Gemini API rate limit or quota exceeded. Please wait and retry.";
      } else if (error.message?.includes("safety")) {
        errorType = "SAFETY_BLOCK";
        errorMessage = "Content was blocked by Gemini safety filters";
      } else if (error.message?.includes("blocked")) {
        errorType = "CONTENT_BLOCKED";
        errorMessage = "Request was blocked. Try rephrasing the prompt.";
      } else if (error.message?.includes("TIMEOUT")) {
        errorType = "TIMEOUT";
        errorMessage = "Request timed out. The prompt may be too complex or the service is slow.";
      }

      // Log failed usage
      logger.logUsage({
        timestamp: new Date().toISOString(),
        provider: "gemini",
        model,
        operation: "generate_text",
        durationMs,
        success: false,
        error: `${errorType}: ${errorMessage}`,
      });

      throw new Error(`${errorType}: ${errorMessage}`);
    }
  }

  getModelInfo(model: SupportedTextModel = DEFAULT_TEXT_MODEL): ModelInfo {
    const modelInfoMap: Record<SupportedTextModel, ModelInfo> = {
      "gemini-3.1-pro": {
        id: "gemini-3.1-pro",
        name: "Gemini 3.1 Pro (Deep Think)",
        provider: "google",
        type: "text",
        contextWindow: 1048576, // 1M tokens
        maxOutput: 65536, // 64K tokens max output
        supportsThinking: true,
        description:
          "Google's latest and most capable reasoning model. HIGH thinking activates Deep Think Mini for dramatically improved reasoning (1-8+ min). Supports thinking levels: low, medium, high.",
      },
      "gemini-3-pro": {
        id: "gemini-3-pro",
        name: "Gemini 3 Pro (Thinking)",
        provider: "google",
        type: "text",
        contextWindow: 1048576, // 1M tokens
        maxOutput: 65536, // 64K tokens max output
        supportsThinking: true,
        description:
          "Previous generation reasoning model. Supports thinking levels: low, high.",
      },
      "gemini-3-flash": {
        id: "gemini-3-flash",
        name: "Gemini 3 Flash (Thinking)",
        provider: "google",
        type: "text",
        contextWindow: 1048576, // 1M tokens
        maxOutput: 65536, // 64K tokens max output
        supportsThinking: true,
        description:
          "Fast, balanced model optimized for speed and scale. Best for chat, high-throughput, and simple tasks. Supports thinking levels: minimal, low, medium, high.",
      },
    };
    return modelInfoMap[model];
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Simple test to check if API is accessible using default model
      const apiModelId = TEXT_MODEL_IDS[DEFAULT_TEXT_MODEL];
      const response = await this.client.models.generateContent({
        model: apiModelId,
        contents: "Hi",
        config: {
          maxOutputTokens: 10,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
        },
      });
      return !!response.text;
    } catch {
      return false;
    }
  }
}
