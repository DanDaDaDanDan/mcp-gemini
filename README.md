# mcp-gemini

MCP server for Claude Code providing access to Google's Gemini models:

- **Gemini 3 Pro** - Text generation with thinking/reasoning capabilities (multimodal)
- **Nano Banana** - Fast image generation (Gemini 2.5 Flash Image)
- **Nano Banana Pro** - High-fidelity image generation (Gemini 3 Pro Image)

## Setup

### 1. Get API Key

Get your API key from [Google AI Studio](https://aistudio.google.com/apikey).

### 2. Install Dependencies & Build

```bash
cd mcp-gemini
npm install && npm run build
```

### 3. Add to Claude Code

```bash
claude mcp add --transport stdio gemini \
  --env GEMINI_API_KEY=your-api-key-here \
  -- node /path/to/mcp-gemini/dist/index.js
```

Or manually add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "gemini": {
      "command": "node",
      "args": ["/path/to/mcp-gemini/dist/index.js"],
      "env": {
        "GEMINI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## Tools

### generate_text

Generate text using Gemini 3 Pro with thinking capabilities. Supports multimodal input (images).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | ✓ | The prompt to send |
| `system_prompt` | string | | System instructions |
| `thinking_level` | `"low"` \| `"high"` | | Thinking depth (default: `"high"`) |
| `max_tokens` | number | | Max output tokens (default: 65536) |
| `temperature` | number | | 0-1 sampling temp (default: 0.7) |
| `images` | string[] | | File paths to images for multimodal input |

**Supported image formats:** jpg, jpeg, png, gif, webp, heic, heif

**Example:**
```
Use generate_text to analyze this code with high thinking
```

**Multimodal example:**
```
Use generate_text with images=["/path/to/screenshot.png"] to describe what's in this image
```

### generate_image

Generate images using Nano Banana or Nano Banana Pro.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | ✓ | Image description |
| `output_path` | string | ✓ | Where to save the image |
| `model` | `"nano-banana"` \| `"nano-banana-pro"` | | Model (default: `"nano-banana"`) |
| `reference_images` | string[] | | Base64 images for editing/composition |
| `aspect_ratio` | string | | e.g., `"16:9"`, `"1:1"` |

**Max reference images:** 3 for nano-banana, 14 for nano-banana-pro

**Supported aspect ratios:** 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9

**Example:**
```
Use generate_image to create a sunset over mountains, save to /tmp/sunset.png
```

### list_models

List available models and their capabilities.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | ✓ | - | Google AI API key |
| `MCP_DEBUG` | | `true` | Debug logging; set to `"false"` to disable |
| `MCP_LOG_DIR` | | `./logs` | Log directory; set to `"none"` to disable |

## Model Details

| Model | API ID | Type | Description |
|-------|--------|------|-------------|
| gemini-3-pro | `gemini-3-pro-preview` | Text | Thinking/reasoning model (multimodal) |
| nano-banana | `gemini-2.5-flash-preview-image-generation` | Image | Fast image generation |
| nano-banana-pro | `gemini-2.0-flash-exp-image-generation` | Image | High-fidelity images |

**Note:** Uses `@google/genai` SDK (not the deprecated `@google/generative-ai`).

## Development

```bash
npm run dev    # Watch mode
npm run build  # Build
npm start      # Run
```

## License

MIT
