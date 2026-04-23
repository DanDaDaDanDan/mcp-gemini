#!/usr/bin/env node

/**
 * MCP Server: mcp-gemini
 *
 * Provides text and image generation capabilities using Google's Gemini models.
 *
 * Models:
 *   - gemini-3.1-pro: Gemini 3.1 Pro - latest, most capable reasoning
 *   - gemini-3-pro: Gemini 3 Pro (Thinking) - deep reasoning
 *   - gemini-3-flash: Gemini 3 Flash (Thinking) - fast, balanced for throughput
 *   - nano-banana: Gemini 2.5 Flash Image - fast image generation
 *   - nano-banana-pro: Gemini 3 Pro Image - high-fidelity image generation
 *
 * Tools:
 *   - generate_text: Generate text using Gemini 3 Pro or Flash
 *   - generate_image: Generate images using Nano Banana or Nano Banana Pro
 *   - deep_research: Autonomous web research
 *   - list_models: List available models and their capabilities
 *
 * Environment Variables:
 *   - GEMINI_API_KEY: Required for all model access
 *   - MCP_DEBUG: Set to "true" for verbose logging
 *   - MCP_LOG_DIR: Directory for log files (optional)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { GeminiTextProvider } from "./providers/gemini-text.js";
import { GeminiImageProvider } from "./providers/gemini-image.js";
import { GeminiDeepResearchProvider } from "./providers/deep-research.js";
import {
  isSupportedImageModel,
  isSupportedResearchModel,
  isSupportedTextModel,
  SUPPORTED_IMAGE_MODELS,
  SUPPORTED_RESEARCH_MODELS,
  SUPPORTED_TEXT_MODELS,
} from "./types.js";
import { logger } from "./logger.js";
import { costTracker } from "./cost-tracker.js";

// Configuration from environment - fail fast if missing
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  const errorMsg = "FATAL: GEMINI_API_KEY environment variable is required. " +
    "Set it in your MCP server configuration or export it in your shell.";
  logger.error(errorMsg);
  console.error(errorMsg);  // Also to stderr for immediate visibility
  process.exit(1);
}

// Initialize providers eagerly at startup - fail fast
const textProvider = new GeminiTextProvider(GEMINI_API_KEY);
const imageProvider = new GeminiImageProvider(GEMINI_API_KEY);
const deepResearchProvider = new GeminiDeepResearchProvider(GEMINI_API_KEY);

// Create MCP server
const server = new Server(
  {
    name: "mcp-gemini",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
const TOOLS = [
  {
    name: "generate_text",
    description:
      "Generate text using Gemini 3 Pro or Flash with thinking capabilities. Supports file attachments (images, audio, video, PDFs, text files) for multimodal input. Use this for complex reasoning, writing, analysis, or any text generation task.",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string",
          description: "The complete prompt to send to the model, including all necessary context",
        },
        model: {
          type: "string",
          enum: [...SUPPORTED_TEXT_MODELS],
          description:
            "Model to use: 'gemini-3.1-pro' (default, most capable), 'gemini-3-pro' (previous gen), or 'gemini-3-flash' (faster, balanced)",
          default: "gemini-3.1-pro",
        },
        system_prompt: {
          type: "string",
          description:
            "Optional system instructions that set the model's behavior and role (e.g., 'You are a professional writer')",
        },
        thinking_level: {
          type: "string",
          enum: ["minimal", "low", "medium", "high"],
          description:
            "Thinking depth. 3.1 Pro supports: low, medium, high. 3 Pro supports: low, high. Flash supports: minimal, low, medium, high. Default: high",
          default: "high",
        },
        max_tokens: {
          type: "number",
          description: "Maximum number of tokens to generate (default: 65536)",
          default: 65536,
        },
        temperature: {
          type: "number",
          description:
            "Sampling temperature from 0 to 1. Lower = more focused, higher = more creative (default: 0.7)",
          default: 0.7,
          minimum: 0,
          maximum: 1,
        },
        attachments: {
          type: "array",
          description:
            "File attachments for multimodal input. Each must provide exactly one of: 'path' (local file), 'data' (base64), or 'url'. " +
            "Supports: Images (jpg, png, webp, heic, heif), Audio (wav, mp3, aiff, aac, ogg, flac), " +
            "Video (mp4, mpeg, mov, avi, flv, webm, wmv, 3gp), Documents (pdf), Text (txt, md, html, xml, css, js, ts, json, csv, rtf).",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Local file path — server reads and base64-encodes. Media type inferred from extension.",
              },
              data: {
                type: "string",
                description: "Base64-encoded content (raw base64 or data URI). Requires media_type.",
              },
              url: {
                type: "string",
                description: "URL — server fetches and inlines the content. Requires media_type.",
              },
              media_type: {
                type: "string",
                description: "MIME type (required with 'data' and 'url', inferred from 'path' extension).",
              },
              filename: {
                type: "string",
                description: "Optional filename hint (auto-detected from path)",
              },
            },
          },
        },
        enable_tools: {
          type: "boolean",
          description:
            "Enable built-in file tools (read_file, list_directory, grep_search) that the model " +
            "can call during generation to explore the local filesystem for additional context.",
          default: false,
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_image",
    description:
      "Generate images using Nano Banana (fast) or Nano Banana Pro (high-quality). Use this for creating images from text descriptions, or editing images with reference inputs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string",
          description: "Description of the image to generate",
        },
        output_path: {
          type: "string",
          description: "File path where the generated image will be saved (e.g., '/tmp/image.png')",
        },
        model: {
          type: "string",
          enum: [...SUPPORTED_IMAGE_MODELS],
          description:
            "Image model: 'nano-banana' for fast generation (default), 'nano-banana-pro' for high-fidelity output",
          default: "nano-banana",
        },
        reference_images: {
          type: "array",
          items: { type: "string" },
          description:
            "Base64-encoded reference images for editing, composition, or style transfer. Max 3 for nano-banana, max 14 for nano-banana-pro. Can be raw base64 or data URL format.",
        },
        aspect_ratio: {
          type: "string",
          enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
          description: "Aspect ratio for the generated image (default: model decides)",
        },
      },
      required: ["prompt", "output_path"],
    },
  },
  {
    name: "deep_research",
    description:
      "Perform autonomous web research using Google's Deep Research agents (Gemini 3.1 Pro). " +
      "The agent searches the web, analyzes sources, and produces comprehensive cited reports with " +
      "optional inline charts and infographics. Long-running (typically 5-60 minutes). If it times out, " +
      "use check_research with the returned interaction_id. " +
      "Supports file attachments, remote MCP servers, code execution, file search, and collaborative " +
      "planning (review the plan before execution, then continue with previous_interaction_id).",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "The research question or topic to investigate. Be specific and detailed for best results. " +
            "When continuing a collaborative_planning session, pass refinements here.",
        },
        model: {
          type: "string",
          enum: [...SUPPORTED_RESEARCH_MODELS],
          description:
            "'deep-research-max' (default, most comprehensive, extended test-time compute) or " +
            "'deep-research' (faster, lower cost, for shorter investigations).",
          default: "deep-research-max",
        },
        visualization: {
          type: "string",
          enum: ["auto", "off"],
          description:
            "Whether to generate inline charts and infographics (HTML + images). Default: auto.",
          default: "auto",
        },
        thinking_summaries: {
          type: "string",
          enum: ["auto", "none"],
          description: "Include intermediate reasoning summaries in the output. Default: auto.",
          default: "auto",
        },
        collaborative_planning: {
          type: "boolean",
          description:
            "When true, the agent pauses after producing a research plan (status=requires_action). " +
            "Call deep_research again with your refinements as 'query' and previous_interaction_id " +
            "set to the returned interaction_id to resume execution.",
          default: false,
        },
        tools: {
          type: "array",
          items: {
            type: "string",
            enum: ["google_search", "url_context", "code_execution", "file_search"],
          },
          description:
            "Which built-in tools the agent may use. Default: ['google_search', 'url_context']. " +
            "'file_search' requires file_search_store_ids.",
        },
        disable_web: {
          type: "boolean",
          description:
            "If true, strips google_search and url_context — useful for proprietary-only research " +
            "against file_search stores or MCP servers.",
          default: false,
        },
        file_search_store_names: {
          type: "array",
          items: { type: "string" },
          description:
            "File Search store resource names (e.g. 'fileSearchStores/my-store-123') to search " +
            "when 'file_search' is enabled.",
        },
        mcp_servers: {
          type: "array",
          description:
            "Remote MCP servers the agent may call as tools during research. Each needs a name, a " +
            "URL, and optional auth headers / allowed_tools list.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short label for this MCP server" },
              url: { type: "string", description: "MCP server URL (e.g. https://api.example.com/mcp)" },
              headers: {
                type: "object",
                additionalProperties: { type: "string" },
                description: "Optional HTTP headers (e.g., Authorization)",
              },
            },
            required: ["name", "url"],
          },
        },
        attachments: {
          type: "array",
          description:
            "File attachments providing context (PDFs, CSVs, images, audio, video, text). Each must " +
            "provide exactly one of: 'path', 'data' (base64), or 'url'.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Local file path" },
              data: { type: "string", description: "Base64-encoded content (raw or data URI)" },
              url: { type: "string", description: "URL to fetch and inline" },
              media_type: { type: "string", description: "MIME type (required with data/url)" },
              filename: { type: "string", description: "Optional filename hint" },
            },
          },
        },
        previous_interaction_id: {
          type: "string",
          description:
            "Continue a prior research interaction (e.g., after reviewing a collaborative-planning plan).",
        },
        output_dir: {
          type: "string",
          description:
            "Directory to save inline-generated charts/infographics. If omitted, images are discarded.",
        },
        timeout_minutes: {
          type: "number",
          description: "Maximum time to wait for completion (default: 120, max: 120).",
          default: 120,
          minimum: 5,
          maximum: 120,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "check_research",
    description:
      "Check the status of a running deep research task or retrieve results after a timeout. " +
      "Use this with the interaction_id returned from deep_research.",
    inputSchema: {
      type: "object" as const,
      properties: {
        interaction_id: {
          type: "string",
          description: "The interaction ID returned from a previous deep_research call",
        },
        output_dir: {
          type: "string",
          description:
            "Directory to save any inline-generated images if the task has now completed.",
        },
      },
      required: ["interaction_id"],
    },
  },
  {
    name: "list_models",
    description: "List all available Gemini models and their capabilities",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_cost_summary",
    description: "Get cumulative cost summary for all Gemini API calls made through this server",
    inputSchema: {
      type: "object" as const,
      properties: {
        reset: {
          type: "boolean",
          description: "Reset the cost tracker after returning summary (default: false)",
          default: false,
        },
      },
      required: [],
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;

  // List models tool
  if (name === "list_models") {
    const models = [];

    // Add text models
    models.push({
      ...textProvider.getModelInfo("gemini-3.1-pro"),
      available: true,
    });
    models.push({
      ...textProvider.getModelInfo("gemini-3-pro"),
      available: true,
    });
    models.push({
      ...textProvider.getModelInfo("gemini-3-flash"),
      available: true,
    });

    // Add image models
    models.push({
      ...imageProvider.getModelInfo("nano-banana"),
      available: true,
    });
    models.push({
      ...imageProvider.getModelInfo("nano-banana-pro"),
      available: true,
    });

    // Add deep research models
    models.push({
      ...deepResearchProvider.getModelInfo("deep-research-max"),
      available: true,
    });
    models.push({
      ...deepResearchProvider.getModelInfo("deep-research"),
      available: true,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ models }, null, 2),
        },
      ],
    };
  }

  // Generate text tool
  if (name === "generate_text") {
    const {
      prompt,
      model,
      system_prompt: systemPrompt,
      thinking_level: thinkingLevel,
      max_tokens: maxTokens,
      temperature,
      attachments,
      enable_tools: enableTools,
    } = args as {
      prompt: string;
      model?: "gemini-3.1-pro" | "gemini-3-pro" | "gemini-3-flash";
      system_prompt?: string;
      thinking_level?: "minimal" | "low" | "medium" | "high";
      max_tokens?: number;
      temperature?: number;
      attachments?: Array<{ path?: string; data?: string; url?: string; media_type?: string; filename?: string; }>;
      enable_tools?: boolean;
    };

    // Validate prompt
    if (!prompt || prompt.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Prompt cannot be empty",
          },
        ],
        isError: true,
      };
    }

    // Validate model if provided
    if (model && !isSupportedTextModel(model)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Unknown text model "${model}". Supported models: ${SUPPORTED_TEXT_MODELS.join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await textProvider.generate({
        prompt,
        model,
        systemPrompt,
        thinkingLevel,
        maxTokens,
        temperature,
        attachments,
        enableTools,
      });

      // Return successful result
      return {
        content: [
          {
            type: "text",
            text: result.text || "",
          },
        ],
        // Include metadata about the generation
        _meta: {
          model: result.model,
          usage: result.usage,
          cost: result.cost,
        },
      };
    } catch (error: any) {
      const errorMessage = error.message || "Unknown error during generation";
      logger.error("Text generation failed", { error: errorMessage });

      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Generate image tool
  if (name === "generate_image") {
    const {
      prompt,
      output_path: outputPath,
      model,
      reference_images: referenceImages,
      aspect_ratio: aspectRatio,
    } = args as {
      prompt: string;
      output_path: string;
      model?: "nano-banana" | "nano-banana-pro";
      reference_images?: string[];
      aspect_ratio?: string;
    };

    // Validate prompt
    if (!prompt || prompt.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Prompt cannot be empty",
          },
        ],
        isError: true,
      };
    }

    // Validate output path
    if (!outputPath || outputPath.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: output_path is required",
          },
        ],
        isError: true,
      };
    }

    // Validate model if provided
    if (model && !isSupportedImageModel(model)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Unknown image model "${model}". Supported models: ${SUPPORTED_IMAGE_MODELS.join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await imageProvider.generate({
        prompt,
        outputPath,
        model,
        referenceImages,
        aspectRatio,
      });

      // Return successful result
      return {
        content: [
          {
            type: "text",
            text: `Image saved to: ${result.imagePath}`,
          },
        ],
        // Include metadata about the generation
        _meta: {
          model: result.model,
          imagePath: result.imagePath,
          usage: result.usage,
          cost: result.cost,
        },
      };
    } catch (error: any) {
      const errorMessage = error.message || "Unknown error during image generation";
      logger.error("Image generation failed", { error: errorMessage });

      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Deep research tool
  if (name === "deep_research") {
    const {
      query,
      model,
      visualization,
      thinking_summaries: thinkingSummaries,
      collaborative_planning: collaborativePlanning,
      tools,
      disable_web: disableWeb,
      file_search_store_names: fileSearchStoreNames,
      mcp_servers: mcpServers,
      attachments,
      previous_interaction_id: previousInteractionId,
      output_dir: outputDir,
      timeout_minutes: timeoutMinutes,
    } = args as {
      query: string;
      model?: string;
      visualization?: "auto" | "off";
      thinking_summaries?: "auto" | "none";
      collaborative_planning?: boolean;
      tools?: Array<"google_search" | "url_context" | "code_execution" | "file_search">;
      disable_web?: boolean;
      file_search_store_names?: string[];
      mcp_servers?: Array<{ name: string; url: string; headers?: Record<string, string> }>;
      attachments?: Array<{ path?: string; data?: string; url?: string; media_type?: string; filename?: string }>;
      previous_interaction_id?: string;
      output_dir?: string;
      timeout_minutes?: number;
    };

    // Validate query
    if (!query || query.trim().length === 0) {
      return {
        content: [{ type: "text", text: "Error: Query cannot be empty" }],
        isError: true,
      };
    }

    // Validate model if provided
    if (model && !isSupportedResearchModel(model)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Unknown research model "${model}". Supported: ${SUPPORTED_RESEARCH_MODELS.join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    // Convert timeout from minutes to milliseconds (default 120 minutes)
    const timeoutMs = (timeoutMinutes || 120) * 60 * 1000;

    try {
      logger.info("Starting deep research", {
        model: model || "deep-research-max",
        queryLength: query.length,
        timeoutMinutes: timeoutMinutes || 120,
        visualization: visualization || "auto",
        collaborativePlanning: !!collaborativePlanning,
        toolCount: tools?.length,
        attachmentCount: attachments?.length,
        mcpServerCount: mcpServers?.length,
        hasPreviousInteraction: !!previousInteractionId,
      });

      const result = await deepResearchProvider.research({
        query,
        model: model as any,
        visualization,
        thinkingSummaries,
        collaborativePlanning,
        tools,
        disableWeb,
        fileSearchStoreNames,
        mcpServers,
        attachments,
        previousInteractionId,
        outputDir,
        timeoutMs,
      });

      // If the agent paused for plan review, surface the plan clearly.
      const bodyText =
        result.status === "requires_action" && result.plan
          ? `**Research plan awaiting your review.** Call deep_research again with your refinements as 'query' and previous_interaction_id='${result.interactionId}' to continue.\n\n${result.plan}`
          : result.text;

      return {
        content: [{ type: "text", text: bodyText }],
        _meta: {
          model: result.model,
          interactionId: result.interactionId,
          status: result.status,
          durationMs: result.durationMs,
          durationMinutes: Math.round((result.durationMs / 1000 / 60) * 10) / 10,
          images: result.images,
          plan: result.plan,
        },
      };
    } catch (error: any) {
      const errorMessage = error.message || "Unknown error during deep research";
      logger.error("Deep research failed", { error: errorMessage });

      return {
        content: [{ type: "text", text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  }

  // Check research status tool
  if (name === "check_research") {
    const { interaction_id: interactionId, output_dir: outputDir } = args as {
      interaction_id: string;
      output_dir?: string;
    };

    // Validate interaction ID
    if (!interactionId || interactionId.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: interaction_id is required",
          },
        ],
        isError: true,
      };
    }

    try {
      logger.info("Checking research status", { interactionId });

      const result = await deepResearchProvider.checkResearch(interactionId, outputDir);

      // Return result (could be completed, in_progress, requires_action, or failed)
      return {
        content: [{ type: "text", text: result.text }],
        _meta: {
          model: result.model,
          interactionId: result.interactionId,
          status: result.status,
          durationMs: result.durationMs,
          images: result.images,
          plan: result.plan,
        },
      };
    } catch (error: any) {
      const errorMessage = error.message || "Unknown error checking research status";
      logger.error("Check research failed", { error: errorMessage, interactionId });

      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Get cost summary tool
  if (name === "get_cost_summary") {
    const { reset } = args as { reset?: boolean };

    const summary = costTracker.getSummary();

    // Format cost values as dollars
    const formatCost = (cost: number) => `$${cost.toFixed(6)}`;

    const formattedSummary = {
      totalCost: formatCost(summary.totalCost),
      callCount: summary.callCount,
      estimatedCosts: formatCost(summary.estimatedCosts),
      since: summary.since,
      byModel: Object.fromEntries(
        Object.entries(summary.byModel).map(([k, v]) => [k, formatCost(v)])
      ),
      byOperation: Object.fromEntries(
        Object.entries(summary.byOperation).map(([k, v]) => [k, formatCost(v)])
      ),
    };

    if (reset) {
      costTracker.reset();
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(formattedSummary, null, 2),
        },
      ],
    };
  }

  // Unknown tool
  return {
    content: [
      {
        type: "text",
        text: `Error: Unknown tool "${name}"`,
      },
    ],
    isError: true,
  };
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();

  // Log startup
  logger.info("Starting MCP server", {
    version: "1.0.0",
    geminiConfigured: !!GEMINI_API_KEY,
    debugMode: process.env.MCP_DEBUG === "true",
    logDir: process.env.MCP_LOG_DIR || "none",
  });

  await server.connect(transport);

  logger.info("Server running and ready for connections");
}

main().catch((error) => {
  logger.error("Fatal error", { error: error.message });
  process.exit(1);
});
