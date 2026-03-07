#!/usr/bin/env node

/**
 * MCP Server: mcp-gemini
 *
 * Provides text and image generation capabilities using Google's Gemini models.
 *
 * Models:
 *   - gemini-3.1-pro: Gemini 3.1 Pro (Deep Think) - latest, most capable reasoning
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
  isSupportedTextModel,
  SUPPORTED_IMAGE_MODELS,
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
      "Generate text using Gemini 3 Pro or Flash with thinking capabilities. Supports file attachments (images, audio, video, PDFs, text files) for multimodal input. Use this for complex reasoning, writing, analysis, or any text generation task. Gemini 3.1 Pro supports Deep Think Mini at HIGH thinking level for dramatically improved reasoning.",
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
            "Model to use: 'gemini-3.1-pro' (default, Deep Think), 'gemini-3-pro' (previous gen), or 'gemini-3-flash' (faster, balanced)",
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
      "Perform autonomous web research using Google's Deep Research agent. " +
      "The agent searches the web, analyzes multiple sources, and produces comprehensive research reports. " +
      "This is a long-running operation that typically takes 5-60 minutes to complete. " +
      "If it times out, use check_research with the returned interaction_id to retrieve results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "The research question or topic to investigate. Be specific and detailed for best results.",
        },
        timeout_minutes: {
          type: "number",
          description:
            "Maximum time to wait for research completion in minutes (default: 120, max: 120)",
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
      "Use this with the interaction_id returned from deep_research if it times out or to poll for completion.",
    inputSchema: {
      type: "object" as const,
      properties: {
        interaction_id: {
          type: "string",
          description: "The interaction ID returned from a previous deep_research call",
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

    // Add deep research model
    models.push({
      ...deepResearchProvider.getModelInfo(),
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
    } = args as {
      prompt: string;
      model?: "gemini-3.1-pro" | "gemini-3-pro" | "gemini-3-flash";
      system_prompt?: string;
      thinking_level?: "minimal" | "low" | "medium" | "high";
      max_tokens?: number;
      temperature?: number;
      attachments?: Array<{ path?: string; data?: string; url?: string; media_type?: string; filename?: string; }>;
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
    const { query, timeout_minutes: timeoutMinutes } = args as {
      query: string;
      timeout_minutes?: number;
    };

    // Validate query
    if (!query || query.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Query cannot be empty",
          },
        ],
        isError: true,
      };
    }

    // Convert timeout from minutes to milliseconds (default 120 minutes)
    const timeoutMs = (timeoutMinutes || 120) * 60 * 1000;

    try {
      logger.info("Starting deep research", { queryLength: query.length, timeoutMinutes: timeoutMinutes || 120 });

      const result = await deepResearchProvider.research({
        query,
        timeoutMs,
      });

      // Return successful result
      return {
        content: [
          {
            type: "text",
            text: result.text,
          },
        ],
        _meta: {
          model: result.model,
          interactionId: result.interactionId,
          durationMs: result.durationMs,
          durationMinutes: Math.round(result.durationMs / 1000 / 60 * 10) / 10,
        },
      };
    } catch (error: any) {
      const errorMessage = error.message || "Unknown error during deep research";
      logger.error("Deep research failed", { error: errorMessage });

      // Include interaction ID in timeout errors so user can check_research later
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

  // Check research status tool
  if (name === "check_research") {
    const { interaction_id: interactionId } = args as {
      interaction_id: string;
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

      const result = await deepResearchProvider.checkResearch(interactionId);

      // Return result (could be completed, in_progress, or failed)
      return {
        content: [
          {
            type: "text",
            text: result.text,
          },
        ],
        _meta: {
          model: result.model,
          interactionId: result.interactionId,
          status: result.status,
          durationMs: result.durationMs,
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
