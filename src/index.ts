#!/usr/bin/env node

/**
 * MCP Server: mcp-gemini
 *
 * Provides text and image generation capabilities using Google's Gemini models.
 *
 * Models:
 *   - gemini-3-pro: Gemini 3 Pro (Thinking) - text generation with reasoning
 *   - nano-banana: Gemini 2.5 Flash Image - fast image generation
 *   - nano-banana-pro: Gemini 3 Pro Image - high-fidelity image generation
 *
 * Tools:
 *   - generate_text: Generate text using Gemini 3 Pro
 *   - generate_image: Generate images using Nano Banana or Nano Banana Pro
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
import {
  isSupportedImageModel,
  SUPPORTED_IMAGE_MODELS,
} from "./types.js";
import { logger } from "./logger.js";

// Configuration from environment - fail fast if missing
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error(
    "FATAL: GEMINI_API_KEY environment variable is required. " +
      "Set it in your MCP server configuration or export it in your shell."
  );
  process.exit(1);
}

// Initialize providers eagerly at startup - fail fast
const textProvider = new GeminiTextProvider(GEMINI_API_KEY);
const imageProvider = new GeminiImageProvider(GEMINI_API_KEY);

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
      "Generate text using Gemini 3 Pro with thinking capabilities. Use this for complex reasoning, writing, analysis, or any text generation task that benefits from deep thinking.",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string",
          description: "The complete prompt to send to the model, including all necessary context",
        },
        system_prompt: {
          type: "string",
          description:
            "Optional system instructions that set the model's behavior and role (e.g., 'You are a professional writer')",
        },
        thinking_level: {
          type: "string",
          enum: ["low", "high"],
          description:
            "Thinking depth: 'high' for maximum reasoning (default), 'low' for faster responses",
          default: "high",
        },
        max_tokens: {
          type: "number",
          description: "Maximum number of tokens to generate (default: 65536, max for Gemini 3 Pro)",
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
        images: {
          type: "array",
          items: { type: "string" },
          description:
            "File paths to images for multimodal input. Supports jpg, png, gif, webp, heic. Use for image analysis, OCR, visual Q&A.",
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
    name: "list_models",
    description: "List all available Gemini models and their capabilities",
    inputSchema: {
      type: "object" as const,
      properties: {},
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

    // Add text model
    models.push({
      ...textProvider.getModelInfo(),
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
      system_prompt: systemPrompt,
      thinking_level: thinkingLevel,
      max_tokens: maxTokens,
      temperature,
      images,
    } = args as {
      prompt: string;
      system_prompt?: string;
      thinking_level?: "low" | "high";
      max_tokens?: number;
      temperature?: number;
      images?: string[];
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

    try {
      const result = await textProvider.generate({
        prompt,
        systemPrompt,
        thinkingLevel,
        maxTokens,
        temperature,
        images,
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
