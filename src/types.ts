/**
 * Shared types for the MCP Gemini server
 */

// ============================================================================
// Input Types (Tool Parameters)
// ============================================================================

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

// ============================================================================
// Result Types
// ============================================================================

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

// ============================================================================
// Provider Interfaces
// ============================================================================

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

// ============================================================================
// Model Constants
// ============================================================================

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

// ============================================================================
// Error Types
// ============================================================================

export type MCPProvider = "xai" | "gemini" | "fal";

export type ErrorCategory =
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "CONTENT_BLOCKED"
  | "SAFETY_BLOCK"
  | "TIMEOUT"
  | "API_ERROR"
  | "VALIDATION_ERROR";

export class MCPError extends Error {
  constructor(
    public category: ErrorCategory,
    message: string,
    public provider: MCPProvider,
    public statusCode?: number
  ) {
    super(`${category}: ${message}`);
    this.name = "MCPError";
  }
}

/**
 * Categorize an error from the Gemini API
 */
export function categorizeError(error: unknown, provider: MCPProvider = "gemini"): MCPError {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as any)?.status || (error as any)?.statusCode;

  if (status === 401 || message.includes("API key") || message.includes("unauthorized")) {
    return new MCPError("AUTH_ERROR", "Invalid or missing Gemini API key", provider, status);
  }

  if (status === 429 || message.includes("rate") || message.includes("quota")) {
    return new MCPError("RATE_LIMIT", "Gemini API rate limit or quota exceeded. Please wait and retry.", provider, status);
  }

  if (message.includes("safety") || message.includes("SAFETY")) {
    return new MCPError("SAFETY_BLOCK", "Content was blocked by Gemini safety filters", provider, status);
  }

  if (message.includes("blocked") || message.includes("content policy")) {
    return new MCPError("CONTENT_BLOCKED", "Request blocked due to content policy", provider, status);
  }

  if (message.includes("TIMEOUT") || message.includes("timed out")) {
    return new MCPError("TIMEOUT", message, provider);
  }

  return new MCPError("API_ERROR", message, provider, status);
}
