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
import { logger } from "../logger.js";
import { withRetry, withTimeout } from "../retry.js";
import { readFileSync, existsSync } from "fs";
import { extname } from "path";

/**
 * Map user-facing thinking level strings to API values.
 *
 * Note: SDK v1.33.0 only has ThinkingLevel.LOW and ThinkingLevel.HIGH.
 * MINIMAL and MEDIUM are not yet in the enum but are accepted by the API.
 * We pass uppercase strings directly which the API accepts.
 */
const THINKING_LEVEL_MAP: Record<ThinkingLevelOption, string> = {
  minimal: "MINIMAL",
  low: ThinkingLevel.LOW,     // "LOW"
  medium: "MEDIUM",
  high: ThinkingLevel.HIGH,   // "HIGH"
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

// Default timeout for generation requests (5 minutes)
const DEFAULT_TIMEOUT_MS = 300000;

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
      files = [],
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
      fileCount: files.length,
    });

    // Build contents array for multimodal input
    const contents: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

    // Add files first if provided (images, audio, video, PDFs, text files)
    for (const filePath of files) {
      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      const mimeType = getMimeType(filePath);
      const data = readFileSync(filePath, { encoding: "base64" });
      contents.push({ inlineData: { mimeType, data } });
      logger.debugLog("Added file to request", { filePath, mimeType });
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
        fileTypes: files.map(f => extname(f).toLowerCase()),
      });

      // Use retry wrapper for transient errors and timeout protection
      const response = await withRetry(
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

      return {
        text: finalText,
        model,
        usage,
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
      "gemini-3-pro": {
        id: "gemini-3-pro",
        name: "Gemini 3 Pro (Thinking)",
        provider: "google",
        type: "text",
        contextWindow: 1048576, // 1M tokens
        maxOutput: 65536, // 64K tokens max output
        supportsThinking: true,
        description:
          "Google's most capable reasoning model with deep thinking. Best for complex analytical and creative tasks. Supports thinking levels: low, high.",
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
