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
  files?: string[]; // File paths for multimodal input (images, audio, video, PDFs, text files)
}

// Supported MIME types for multimodal input
// See: https://ai.google.dev/gemini-api/docs
export const SUPPORTED_MIME_TYPES: Record<string, string> = {
  // Images (GIF, BMP, TIFF are NOT supported)
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  // Audio (up to 9.5 hours)
  ".wav": "audio/wav",
  ".mp3": "audio/mp3",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  // Video (up to 2 hours at default resolution, 6 hours at low resolution)
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpg",
  ".mov": "video/mov",
  ".avi": "video/avi",
  ".flv": "video/x-flv",
  ".webm": "video/webm",
  ".wmv": "video/wmv",
  ".3gp": "video/3gpp",
  ".3gpp": "video/3gpp",
  // Documents (PDF: up to 1000 pages, 50MB)
  ".pdf": "application/pdf",
  // Text files (processed as plain text, not visual understanding)
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "text/xml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".json": "application/json",
  ".csv": "text/csv",
  ".rtf": "application/rtf",
};

// Image generation options for Nano Banana / Pro
export interface ImageGenerateOptions {
  prompt: string;
  outputPath: string;
  model?: "nano-banana" | "nano-banana-pro";
  referenceImages?: string[]; // Base64 encoded images for editing/composition (max varies by model)
  aspectRatio?: string; // e.g., "16:9", "1:1", "4:3"
}

// Deep Research options
export interface DeepResearchOptions {
  query: string;
  timeoutMs?: number; // Max time to wait for research completion (default: 30 min)
  pollIntervalMs?: number; // How often to check status (default: 10 sec)
}

// Deep Research result
export interface DeepResearchResult {
  text: string;
  model: string;
  interactionId: string;
  status: "completed" | "failed";
  durationMs: number;
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
  type: "text" | "image" | "research";
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

export interface DeepResearchProvider {
  research(options: DeepResearchOptions): Promise<DeepResearchResult>;
  getModelInfo(): ModelInfo;
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

// API model IDs
// See: https://ai.google.dev/gemini-api/docs/models
export const TEXT_MODEL_ID = "gemini-3-pro-preview";
export const DEEP_RESEARCH_AGENT_ID = "deep-research-pro-preview-12-2025";
