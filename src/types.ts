/**
 * Shared types for the MCP Gemini server
 */

// Text generation options for Gemini 3 Pro
export interface TextGenerateOptions {
  prompt: string;
  systemPrompt?: string;
  thinkingLevel?: "low" | "high";
  maxTokens?: number;
  temperature?: number;
  images?: string[]; // File paths to images for multimodal input
}

// Image generation options for Nano Banana / Pro
export interface ImageGenerateOptions {
  prompt: string;
  outputPath: string;
  model?: "nano-banana" | "nano-banana-pro";
  referenceImages?: string[]; // Base64 encoded images for editing/composition (max varies by model)
  aspectRatio?: string; // e.g., "16:9", "1:1", "4:3"
}

// Common result structure
export interface GenerateResult {
  text?: string;
  imagePath?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    thoughtsTokens?: number;
  };
  model: string;
}

// Model information
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  type: "text" | "image";
  contextWindow?: number;
  maxOutput?: number;
  supportsThinking?: boolean;
  description: string;
}

// Provider interfaces
export interface TextProvider {
  generate(options: TextGenerateOptions): Promise<GenerateResult>;
  getModelInfo(): ModelInfo;
  isAvailable(): Promise<boolean>;
}

export interface ImageProvider {
  generate(options: ImageGenerateOptions): Promise<GenerateResult>;
  getModelInfo(model?: string): ModelInfo;
  isAvailable(): Promise<boolean>;
}

// Supported models
export const SUPPORTED_TEXT_MODELS = ["gemini-3-pro"] as const;
export const SUPPORTED_IMAGE_MODELS = ["nano-banana", "nano-banana-pro"] as const;

export type SupportedTextModel = (typeof SUPPORTED_TEXT_MODELS)[number];
export type SupportedImageModel = (typeof SUPPORTED_IMAGE_MODELS)[number];

export function isSupportedTextModel(model: string): model is SupportedTextModel {
  return SUPPORTED_TEXT_MODELS.includes(model as SupportedTextModel);
}

export function isSupportedImageModel(model: string): model is SupportedImageModel {
  return SUPPORTED_IMAGE_MODELS.includes(model as SupportedImageModel);
}

// API model ID for text generation
// See: https://ai.google.dev/gemini-api/docs/models
export const TEXT_MODEL_ID = "gemini-3-pro-preview";
