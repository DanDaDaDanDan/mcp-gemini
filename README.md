# mcp-gemini

MCP server for Claude Code providing access to Google's Gemini models:

- **Gemini 3 Pro** - Deep reasoning with thinking capabilities (multimodal)
- **Gemini 3 Flash** - Fast, balanced model with thinking (multimodal)
- **Nano Banana** - Fast image generation (Gemini 2.5 Flash Image)
- **Nano Banana Pro** - High-fidelity image generation (Gemini 3 Pro Image)
- **Deep Research** - Autonomous web research agent

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
claude mcp add -s user -t stdio mcp-gemini \
  -e GEMINI_API_KEY=your-api-key-here \
  -- node /path/to/mcp-gemini/dist/index.js
```

Or manually add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "mcp-gemini": {
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

Generate text using Gemini 3 Pro or Flash with thinking capabilities. Supports comprehensive multimodal input.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | The prompt to send |
| `model` | `"gemini-3-pro"` \| `"gemini-3-flash"` | | Model (default: `"gemini-3-pro"`) |
| `system_prompt` | string | | System instructions |
| `thinking_level` | `"minimal"` \| `"low"` \| `"medium"` \| `"high"` | | Thinking depth (default: `"high"`) |
| `max_tokens` | number | | Max output tokens (default: 65536) |
| `temperature` | number | | 0-1 sampling temp (default: 0.7) |
| `files` | string[] | | File paths for multimodal input |

**Thinking levels by model:**
- **Pro:** `low`, `high` only
- **Flash:** `minimal`, `low`, `medium`, `high`

**Supported file formats:**
- **Images:** jpg, png, webp, heic, heif (max 3,600 per request)
- **Audio:** wav, mp3, aiff, aac, ogg, flac (up to 9.5 hours)
- **Video:** mp4, mpeg, mov, avi, flv, webm, wmv, 3gp (up to 2 hours)
- **Documents:** pdf (up to 1,000 pages)
- **Text:** txt, md, html, xml, css, js, ts, json, csv, rtf

**Not supported:** GIF, BMP, TIFF

**Example:**
```
Use generate_text to analyze this code with high thinking
```

**Multimodal example:**
```
Use generate_text with files=["/path/to/document.pdf"] to summarize this document
```

### generate_image

Generate images using Nano Banana or Nano Banana Pro.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Image description |
| `output_path` | string | Yes | Where to save the image |
| `model` | `"nano-banana"` \| `"nano-banana-pro"` | | Model (default: `"nano-banana"`) |
| `reference_images` | string[] | | Base64 images for editing/composition |
| `aspect_ratio` | string | | e.g., `"16:9"`, `"1:1"` |

**Max reference images:** 3 for nano-banana, 14 for nano-banana-pro

**Supported aspect ratios:** 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9

**Example:**
```
Use generate_image to create a sunset over mountains, save to /tmp/sunset.png
```

### deep_research

Perform autonomous web research using Google's Deep Research agent. Returns comprehensive research reports.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Research question or topic |
| `timeout_minutes` | number | | Max wait time (default: 30, max: 60) |

**Note:** This is a long-running operation that typically takes 5-30 minutes.

**Example:**
```
Use deep_research to investigate recent developments in quantum computing
```

### list_models

List available models and their capabilities.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | Yes | - | Google AI API key |
| `MCP_DEBUG` | | `true` | Debug logging; set to `"false"` to disable |
| `MCP_LOG_DIR` | | `./logs` | Log directory; set to `"none"` to disable |

## Model Details

| Model | API ID | Type | Description |
|-------|--------|------|-------------|
| gemini-3-pro | `gemini-3-pro-preview` | Text | Deep reasoning with thinking (multimodal) |
| gemini-3-flash | `gemini-3-flash-preview` | Text | Fast, balanced with thinking (multimodal) |
| nano-banana | `gemini-2.5-flash-preview-image-generation` | Image | Fast image generation |
| nano-banana-pro | `gemini-2.0-flash-exp-image-generation` | Image | High-fidelity images |
| deep-research | `deep-research-pro-preview-12-2025` | Research | Autonomous web research agent |

**Note:** Uses `@google/genai` SDK (not the deprecated `@google/generative-ai`).

## Development

```bash
npm run dev    # Watch mode
npm run build  # Build
npm start      # Run
```

## License

MIT
