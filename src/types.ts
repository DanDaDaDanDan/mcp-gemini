/**
 * Shared types for the MCP Gemini server
 */

// ============================================================================
// Input Types (Tool Parameters)
// ============================================================================

// File attachment for multimodal input
export interface Attachment {
  path?: string;       // Local file path — server reads and base64-encodes
  data?: string;       // Base64-encoded content (raw or data URI)
  url?: string;        // URL — server fetches and base64-encodes (Gemini requires inline data)
  media_type?: string; // MIME type (required with data, inferred from path)
  filename?: string;   // Optional filename hint (auto-detected from path)
}

// Text generation options for Gemini 3 Pro/Flash
export interface TextGenerateOptions {
  prompt: string;
  systemPrompt?: string;
  model?: SupportedTextModel;
  thinkingLevel?: ThinkingLevelOption;
  maxTokens?: number;
  temperature?: number;
  attachments?: Attachment[]; // File attachments for multimodal input
  enableTools?: boolean; // Enable built-in file tools (read_file, list_directory, grep_search)
}

// Thinking levels - Flash supports all 4, 3 Pro supports low/high, 3.1 Pro supports low/medium/high
export type ThinkingLevelOption = "minimal" | "low" | "medium" | "high";

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

// Deep Research tool types that can be enabled for a run
export type ResearchTool =
  | "google_search"
  | "url_context"
  | "code_execution"
  | "file_search";

// Remote MCP server descriptor for Deep Research's `mcp_server` tool
export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

// Generated image returned alongside a research report (infographic/chart)
export interface ResearchImage {
  path: string;
  mimeType: string;
}

// Deep Research options
export interface DeepResearchOptions {
  query: string;
  model?: SupportedResearchModel;
  visualization?: "auto" | "off";
  thinkingSummaries?: "auto" | "none";
  collaborativePlanning?: boolean;
  tools?: ResearchTool[];
  disableWeb?: boolean;
  attachments?: Attachment[];
  previousInteractionId?: string;
  mcpServers?: McpServerConfig[];
  // File Search store resource names, e.g. "fileSearchStores/my-store-123"
  fileSearchStoreNames?: string[];
  outputDir?: string; // Where to save any inline-generated images
  timeoutMs?: number; // Max time to wait for research completion
  pollIntervalMs?: number; // How often to check status
}

// Deep Research result
export interface DeepResearchResult {
  text: string;
  model: string;
  interactionId: string;
  status: "completed" | "failed" | "requires_action" | "in_progress";
  durationMs: number;
  images?: ResearchImage[];
  plan?: string; // Populated when status === "requires_action" (collaborative planning pause)
}

// ============================================================================
// Result Types
// ============================================================================

// Cost information
export interface CostInfo {
  inputCost?: number;
  outputCost?: number;
  imageCost?: number;
  totalCost: number;
  currency: "USD";
  estimated: boolean;
}

// Usage information
export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  thoughtsTokens?: number;
}

// Common result structure
export interface GenerateResult {
  text?: string;
  imagePath?: string;
  usage?: UsageInfo;
  model: string;
  cost?: CostInfo;
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
  getModelInfo(model?: SupportedTextModel): ModelInfo;
  isAvailable(): Promise<boolean>;
}

export interface ImageProvider {
  generate(options: ImageGenerateOptions): Promise<GenerateResult>;
  getModelInfo(model?: string): ModelInfo;
  isAvailable(): Promise<boolean>;
}

export interface DeepResearchProvider {
  research(options: DeepResearchOptions): Promise<DeepResearchResult>;
  checkResearch(interactionId: string, outputDir?: string): Promise<DeepResearchResult>;
  getModelInfo(model?: SupportedResearchModel): ModelInfo;
}

// ============================================================================
// Model Constants
// ============================================================================

// Supported models
export const SUPPORTED_TEXT_MODELS = ["gemini-3.1-pro", "gemini-3-pro", "gemini-3-flash"] as const;
export const SUPPORTED_IMAGE_MODELS = ["nano-banana", "nano-banana-pro"] as const;
export const SUPPORTED_RESEARCH_MODELS = ["deep-research", "deep-research-max"] as const;

export type SupportedTextModel = (typeof SUPPORTED_TEXT_MODELS)[number];
export type SupportedImageModel = (typeof SUPPORTED_IMAGE_MODELS)[number];
export type SupportedResearchModel = (typeof SUPPORTED_RESEARCH_MODELS)[number];

export function isSupportedTextModel(model: string): model is SupportedTextModel {
  return SUPPORTED_TEXT_MODELS.includes(model as SupportedTextModel);
}

export function isSupportedImageModel(model: string): model is SupportedImageModel {
  return SUPPORTED_IMAGE_MODELS.includes(model as SupportedImageModel);
}

export function isSupportedResearchModel(model: string): model is SupportedResearchModel {
  return SUPPORTED_RESEARCH_MODELS.includes(model as SupportedResearchModel);
}

// API model IDs
// See: https://ai.google.dev/gemini-api/docs/models
export const TEXT_MODEL_IDS: Record<SupportedTextModel, string> = {
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "gemini-3-pro": "gemini-3-pro-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
} as const;

export const DEFAULT_TEXT_MODEL: SupportedTextModel = "gemini-3.1-pro";

// Deep Research agent IDs
// See: https://ai.google.dev/gemini-api/docs/deep-research
export const RESEARCH_MODEL_IDS: Record<SupportedResearchModel, string> = {
  "deep-research": "deep-research-preview-04-2026",
  "deep-research-max": "deep-research-max-preview-04-2026",
} as const;

// Default to Max since our MCP flow already polls asynchronously and users
// are reaching for Deep Research when they want the highest-quality report.
export const DEFAULT_RESEARCH_MODEL: SupportedResearchModel = "deep-research-max";

// Thinking levels supported by each model
// 3.1 Pro: low/medium/high; 3 Pro: low/high; Flash: all four levels
export const MODEL_THINKING_LEVELS: Record<SupportedTextModel, readonly ThinkingLevelOption[]> = {
  "gemini-3.1-pro": ["low", "medium", "high"] as const,
  "gemini-3-pro": ["low", "high"] as const,
  "gemini-3-flash": ["minimal", "low", "medium", "high"] as const,
} as const;

/**
 * Validate that a thinking level is supported by the given model.
 * Returns an error message if invalid, undefined if valid.
 */
export function validateThinkingLevel(
  model: SupportedTextModel,
  level: ThinkingLevelOption
): string | undefined {
  const supportedLevels = MODEL_THINKING_LEVELS[model];
  if (!supportedLevels.includes(level)) {
    return `${model} only supports thinking levels: ${supportedLevels.join(", ")}. Got: ${level}`;
  }
  return undefined;
}

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
