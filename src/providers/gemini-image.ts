/**
 * Gemini image generation provider (Nano Banana / Nano Banana Pro)
 *
 * Uses the new @google/genai SDK
 */

import { GoogleGenAI } from "@google/genai";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import type { ImageGenerateOptions, GenerateResult, ModelInfo, ImageProvider } from "../types.js";
import { type SupportedImageModel } from "../types.js";
import { logger } from "../logger.js";
import { withRetry, withTimeout } from "../retry.js";

// Model IDs for image generation
// See: https://ai.google.dev/gemini-api/docs/models
const IMAGE_MODEL_IDS: Record<SupportedImageModel, string> = {
  "nano-banana": "gemini-2.5-flash-preview-image-generation",
  "nano-banana-pro": "gemini-2.0-flash-exp-image-generation",
};

// Maximum reference images per model
// See: https://ai.google.dev/gemini-api/docs/image-generation
const MAX_REFERENCE_IMAGES: Record<SupportedImageModel, number> = {
  "nano-banana": 3,      // Gemini 2.5 Flash Image
  "nano-banana-pro": 14, // Gemini 3 Pro Image
};

// Default timeout for image generation (3 minutes)
const DEFAULT_TIMEOUT_MS = 180000;

// Supported aspect ratios
const VALID_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];

export class GeminiImageProvider implements ImageProvider {
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("Gemini API key is required");
    }
    this.client = new GoogleGenAI({ apiKey });
    logger.info("Gemini image provider initialized", {
      models: Object.keys(IMAGE_MODEL_IDS),
    });
  }

  async generate(options: ImageGenerateOptions): Promise<GenerateResult> {
    const {
      prompt,
      outputPath,
      model = "nano-banana",
      referenceImages = [],
      aspectRatio,
    } = options;
    const startTime = Date.now();

    // Validate aspect ratio if provided
    if (aspectRatio && !VALID_ASPECT_RATIOS.includes(aspectRatio)) {
      throw new Error(
        `Invalid aspect ratio "${aspectRatio}". Valid options: ${VALID_ASPECT_RATIOS.join(", ")}`
      );
    }

    const maxImages = MAX_REFERENCE_IMAGES[model];

    // Validate reference images count
    if (referenceImages.length > maxImages) {
      throw new Error(
        `Maximum ${maxImages} reference images allowed for ${model}`
      );
    }

    const modelId = IMAGE_MODEL_IDS[model];

    logger.debugLog("Starting image generation", {
      promptLength: prompt.length,
      model,
      modelId,
      referenceImageCount: referenceImages.length,
      aspectRatio,
      outputPath,
    });

    try {
      // Build contents - can be string or array with images
      let contents: any = prompt;

      // Add reference images if provided
      if (referenceImages.length > 0) {
        contents = [];

        for (const referenceImage of referenceImages) {
          // Parse base64 input, detect mime type from prefix or default to PNG
          let mimeType = "image/png";
          let imageData = referenceImage;

          if (referenceImage.startsWith("data:")) {
            // Parse data URL
            const matches = referenceImage.match(/^data:([^;]+);base64,(.+)$/);
            if (matches) {
              mimeType = matches[1];
              imageData = matches[2];
            }
          }

          contents.push({
            inlineData: {
              mimeType,
              data: imageData,
            },
          });
        }

        // Add prompt after images
        contents.push(prompt);
      }

      // Build config
      const config: any = {
        responseModalities: ["image", "text"],
      };

      // Add image config if aspect ratio specified
      if (aspectRatio) {
        config.imageGenerationConfig = {
          aspectRatio: aspectRatio,
        };
      }

      logger.debugLog("Image generation API request", {
        model,
        modelId,
        config,
        hasReferenceImages: referenceImages.length > 0,
        referenceImageCount: referenceImages.length,
        promptPreview: prompt.substring(0, 100) + (prompt.length > 100 ? "..." : ""),
      });

      // Use retry wrapper for transient errors and timeout protection
      const response = await withRetry(
        () =>
          withTimeout(
            () =>
              this.client.models.generateContent({
                model: modelId,
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

      logger.debugLog("Image generation API response", {
        model,
        modelId,
        hasCandidates: !!response.candidates?.length,
        candidateCount: response.candidates?.length,
        usageMetadata: response.usageMetadata,
      });

      // Find the image part in the response
      let imageData: string | null = null;
      let imageMimeType = "image/png";

      // Check candidates for image data
      if (response.candidates && response.candidates.length > 0) {
        for (const candidate of response.candidates) {
          for (const part of candidate.content?.parts || []) {
            if ((part as any).inlineData) {
              const inlineData = (part as any).inlineData;
              imageData = inlineData.data;
              imageMimeType = inlineData.mimeType || "image/png";
              break;
            }
          }
          if (imageData) break;
        }
      }

      if (!imageData) {
        throw new Error("No image data found in response");
      }

      // Ensure output directory exists
      const outputDir = dirname(outputPath);
      if (outputDir && !existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      // Decode and save the image
      const imageBuffer = Buffer.from(imageData, "base64");
      writeFileSync(outputPath, imageBuffer);

      const durationMs = Date.now() - startTime;
      const usageMetadata = response.usageMetadata;

      const usage = usageMetadata
        ? {
            promptTokens: usageMetadata.promptTokenCount,
            completionTokens: usageMetadata.candidatesTokenCount,
            totalTokens: usageMetadata.totalTokenCount,
          }
        : undefined;

      // Log usage statistics
      logger.logUsage({
        timestamp: new Date().toISOString(),
        provider: "gemini",
        model,
        operation: "generate_image",
        durationMs,
        success: true,
        metrics: usage ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        } : undefined,
      });

      return {
        imagePath: outputPath,
        model,
        usage,
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      let errorType = "GENERATION_ERROR";
      let errorMessage = error.message || "Unknown error during image generation";

      logger.error("Image generation API error", {
        model,
        modelId,
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
        errorMessage = "Image was blocked by Gemini safety filters";
      } else if (error.message?.includes("blocked")) {
        errorType = "CONTENT_BLOCKED";
        errorMessage = "Request was blocked. Try rephrasing the prompt.";
      } else if (error.message?.includes("TIMEOUT")) {
        errorType = "TIMEOUT";
        errorMessage = "Request timed out. The image generation may be taking too long.";
      }

      // Log failed usage
      logger.logUsage({
        timestamp: new Date().toISOString(),
        provider: "gemini",
        model,
        operation: "generate_image",
        durationMs,
        success: false,
        error: `${errorType}: ${errorMessage}`,
      });

      throw new Error(`${errorType}: ${errorMessage}`);
    }
  }

  getModelInfo(model: SupportedImageModel = "nano-banana"): ModelInfo {
    const modelInfos: Record<SupportedImageModel, ModelInfo> = {
      "nano-banana": {
        id: "nano-banana",
        name: "Nano Banana (Gemini 2.5 Flash Image)",
        provider: "google",
        type: "image",
        description:
          "Fast image generation model. Good for quick iterations and lower-fidelity images.",
      },
      "nano-banana-pro": {
        id: "nano-banana-pro",
        name: "Nano Banana Pro (Gemini 2.0 Flash Exp Image)",
        provider: "google",
        type: "image",
        description:
          "High-fidelity image generation model. Excellent for detailed, production-quality images with accurate text rendering.",
      },
    };

    return modelInfos[model];
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Just verify the client is initialized
      return !!this.client;
    } catch {
      return false;
    }
  }
}
