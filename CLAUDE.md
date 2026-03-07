# mcp-gemini

MCP server providing Claude Code access to Google's Gemini models.

## Philosophy

1. **Fail fast** - Surface errors immediately with clear messages. Don't silently swallow failures or return partial results.
2. **Don't guess, research** - When API behavior is unclear, check the docs. Model IDs and parameters change; verify against https://ai.google.dev/gemini-api/docs/models
3. **Eager initialization** - Create provider instances at startup. Fail at init, not use-time.
4. **Structured errors** - Categorize errors (AUTH_ERROR, RATE_LIMIT, SAFETY_BLOCK, TIMEOUT) for actionable feedback.

## SDK

Uses `@google/genai` (the new unified SDK), NOT the deprecated `@google/generative-ai`.

The old SDK is deprecated (EOL August 31, 2025) and doesn't support:
- `thinkingConfig` for Gemini 3
- Image generation models
- New features like Live API

## Models

| Friendly Name | API Model ID | Type |
|---------------|--------------|------|
| gemini-3.1-pro | `gemini-3.1-pro-preview` | Text/Deep Think (latest, most capable) |
| gemini-3-pro | `gemini-3-pro-preview` | Text/Thinking (deep reasoning) |
| gemini-3-flash | `gemini-3-flash-preview` | Text/Thinking (fast, balanced) |
| nano-banana | `gemini-2.5-flash-image` | Image (fast) |
| nano-banana-pro | `gemini-3-pro-image-preview` | Image (high-quality, 2K/4K) |
| deep-research | `deep-research-pro-preview-12-2025` | Research (async) |

### Model Comparison: Text Models

| Attribute | gemini-3.1-pro | gemini-3-pro | gemini-3-flash |
|-----------|----------------|--------------|----------------|
| Input Tokens | 1,048,576 (1M) | 1,048,576 (1M) | 1,048,576 (1M) |
| Output Tokens | 65,536 (64K) | 65,536 (64K) | 65,536 (64K) |
| Thinking Levels | `low`, `medium`, `high` | `low`, `high` | `minimal`, `low`, `medium`, `high` |
| Deep Think Mini | Yes (at HIGH) | No | No |
| Best For | Complex reasoning, hard problems | General reasoning | Speed, chat, high-throughput |

## Thinking Configuration

Gemini 3 models use `thinkingConfig` with `ThinkingLevel` values:

```typescript
import { ThinkingLevel } from "@google/genai";

config: {
  thinkingConfig: {
    thinkingLevel: ThinkingLevel.HIGH,  // or "MINIMAL", "LOW", "MEDIUM", "HIGH"
    includeThoughts: true,  // Get thought summaries
  }
}
```

**Note:** SDK v1.42.0+ exports all four `ThinkingLevel` enum values: `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`.

### Thinking Levels by Model

| Level | 3.1 Pro | 3 Pro | Flash | Description |
|-------|---------|-------|-------|-------------|
| `minimal` | ❌ | ❌ | ✅ | Minimizes latency; model likely won't think |
| `low` | ✅ | ✅ | ✅ | Faster responses, simple tasks |
| `medium` | ✅ | ❌ | ✅ | Balanced thinking (equivalent to 3 Pro's HIGH) |
| `high` | ✅ (default) | ✅ (default) | ✅ (default) | Maximum reasoning depth; activates Deep Think Mini on 3.1 Pro |

**Key points:**
- Neither model can fully disable thinking
- 3.1 Pro supports `low`, `medium`, `high`; HIGH activates Deep Think Mini (1-8+ min, dramatically improved reasoning)
- 3 Pro only supports `low` and `high`; using `minimal` or `medium` returns VALIDATION_ERROR
- `includeThoughts: true` returns thought summaries in response parts
- Thoughts tokens tracked via `usageMetadata.thoughtsTokenCount`
- Deep Think Mini at HIGH can consume 8K-32K+ thinking tokens per response

## Architecture

```
src/
├── index.ts              # MCP server, tool routing
├── types.ts              # Shared types, model constants, validation
├── logger.ts             # Logging (stderr + optional file)
├── retry.ts              # Exponential backoff, timeout wrapper
└── providers/
    ├── gemini-text.ts    # Gemini 3 Pro/Flash with thinking
    ├── gemini-image.ts   # Nano Banana / Pro image generation
    └── deep-research.ts  # Deep Research autonomous agent
```

## Multimodal Input

Text generation supports comprehensive multimodal input via file paths. All supported file types are defined in `SUPPORTED_MIME_TYPES` in `types.ts`.

### Supported File Types

| Category | Extensions | MIME Types | Limits |
|----------|------------|------------|--------|
| **Images** | jpg, jpeg, png, webp, heic, heif | image/* | Max 3,600 per request |
| **Audio** | wav, mp3, aiff, aac, ogg, flac | audio/* | Up to 9.5 hours total |
| **Video** | mp4, mpeg, mpg, mov, avi, flv, webm, wmv, 3gp | video/* | Up to 2 hours (default) or 6 hours (low res) |
| **Documents** | pdf | application/pdf | Up to 1,000 pages, 50MB |
| **Text** | txt, md, html, xml, css, js, ts, json, csv, rtf | text/*, application/json | Processed as plain text |

**Not supported:** GIF, BMP, TIFF images are not supported by Gemini.

### Size Limits

- **Inline data**: Total request size < 20MB (use Files API for larger)
- **Files API**: Up to 2GB per file, 20GB per project
- **PDF**: Max 1,000 pages, ~258 tokens per page
- **Video**: ~258 tokens per frame at 1 FPS + 32 tokens/sec audio

### Attachment Sources (exactly one required per attachment)

| Field | Description |
|-------|-------------|
| `path` | Local file path — server reads and base64-encodes. Media type inferred from extension. |
| `data` | Base64-encoded content (raw or data URI). Requires `media_type`. |
| `url` | URL — server fetches and inlines. Requires `media_type`. |

### Optional Fields

| Field | Description |
|-------|-------------|
| `media_type` | MIME type. Required with `data` and `url`, inferred from `path`. |
| `filename` | Filename hint. Auto-detected from `path`. |

### Example

```typescript
generate_text({
  prompt: "Describe this image",
  attachments: [
    { path: "/path/to/photo.jpg" },                           // local file
    { data: "iVBOR...", media_type: "image/png" },             // base64
    { url: "https://example.com/image.png", media_type: "image/png" },  // URL
  ]
})
```

Attachments are added before text (standard multimodal ordering). Fails fast if:
- File at `path` doesn't exist
- File extension is not in SUPPORTED_MIME_TYPES
- `media_type` missing when required
- Multiple or zero sources provided per attachment

## Response Handling

### Text Generation
```typescript
// Response structure from new SDK
response.text           // Direct text access
response.candidates     // For accessing parts with thought markers
response.usageMetadata  // Token counts including thoughtsTokenCount

// Parts with thought flag
for (const part of response.candidates[0].content.parts) {
  if (part.thought) {
    // This is a thought summary
  } else {
    // This is the answer
  }
}
```

### Image Generation
```typescript
// Image data in response
response.candidates[0].content.parts[].inlineData.data  // Base64 image
response.candidates[0].content.parts[].inlineData.mimeType
```

## Deep Research

The Deep Research agent uses the `@google/genai` SDK's native interactions API:

```typescript
// Start research
const interaction = await client.interactions.create({
  input: "research query",
  agent: "deep-research-pro-preview-12-2025",
  background: true,
  agent_config: {
    type: "deep-research",        // REQUIRED - must specify agent type
    thinking_summaries: "auto"    // Optional - enables progress updates
  },
});

// Poll for completion
const result = await client.interactions.get(interaction.id);
// result.status: "in_progress" | "completed" | "failed" | "cancelled" | "requires_action"
// result.outputs: Array<TextContent | ...>

// Cancel a running task
await client.interactions.cancel(interaction.id);

// Delete an interaction
await client.interactions.delete(interaction.id);
```

**Key points:**
- Long-running: typically 5-30 minutes, max 60 minutes
- Async polling: start task, poll until `status` is `completed`, `failed`, or `cancelled`
- Output text extracted from `outputs` array where `output.type === "text"`
- SDK handles auth via API key passed at GoogleGenAI construction
- Supports `previous_interaction_id` for follow-up queries
- File support: Experimental - requires File Search stores (not inline files)
- Audio inputs are NOT supported for Deep Research
- Streaming supported via `stream: true` (returns SSE events)

## Tools

| Tool | Description | Model(s) |
|------|-------------|----------|
| `generate_text` | Text generation with thinking and file attachments | gemini-3.1-pro (default), gemini-3-pro, gemini-3-flash |
| `generate_image` | Image generation/editing | nano-banana (default), nano-banana-pro |
| `deep_research` | Autonomous web research | deep-research |
| `list_models` | List available models | Static |

### generate_text Parameters

```typescript
{
  prompt: string;           // Required
  model?: "gemini-3.1-pro" | "gemini-3-pro" | "gemini-3-flash";  // Default: gemini-3.1-pro
  thinking_level?: "minimal" | "low" | "medium" | "high";  // Default: high
  system_prompt?: string;
  max_tokens?: number;      // Default: 65536
  temperature?: number;     // Default: 0.7, range 0-1
  attachments?: Attachment[];  // Multimodal file attachments (path, data, or URL)
}
```

## Error Categories

| Category | HTTP Status | Meaning |
|----------|-------------|---------|
| AUTH_ERROR | 401 | Invalid or missing API key |
| RATE_LIMIT | 429 | API quota exceeded |
| SAFETY_BLOCK | 400 | Blocked by Gemini safety filters |
| CONTENT_BLOCKED | 400 | Content policy violation |
| TIMEOUT | - | Request exceeded timeout |
| VALIDATION_ERROR | 422 | Invalid input parameters |
| API_ERROR | 4xx/5xx | Other API errors |

## Environment Variables

- `GEMINI_API_KEY` (required) - from https://aistudio.google.com/apikey
- `MCP_DEBUG` - debug logging enabled by default; set to "false" to disable
- `MCP_LOG_DIR` - defaults to `./logs`; set to "none" to disable file logging

## Development

```bash
npm install       # Install dependencies
npm run build     # Compile TypeScript
npm run dev       # Watch mode
npm start         # Run server
```

## Testing Changes

After modifying providers, verify:
1. Build succeeds: `npm run build`
2. Model IDs are current (check Google docs)
3. ThinkingLevel values map correctly (SDK v1.42.0 has all enum values)
4. Error categories match API responses

## Adding New Models

1. Add to `SUPPORTED_*_MODELS` in `types.ts`
2. Add API model ID to `TEXT_MODEL_IDS` or equivalent mapping
3. For text models: add thinking level constraints to `MODEL_THINKING_LEVELS`
4. Add `getModelInfo()` entry in provider
5. Update `list_models` handler if needed
6. Check if model needs thinkingConfig or imageGenerationConfig
