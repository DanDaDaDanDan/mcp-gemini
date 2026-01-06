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
| gemini-3-pro | `gemini-3-pro-preview` | Text/Thinking (deep reasoning) |
| gemini-3-flash | `gemini-3-flash-preview` | Text/Thinking (fast, balanced) |
| nano-banana | `gemini-2.5-flash-preview-image-generation` | Image (fast) |
| nano-banana-pro | `gemini-2.0-flash-exp-image-generation` | Image (high-quality) |
| deep-research | `deep-research-pro-preview-12-2025` | Research (async) |

### Model Comparison: Pro vs Flash

| Attribute | gemini-3-pro | gemini-3-flash |
|-----------|--------------|----------------|
| Input Tokens | 1,048,576 (1M) | 1,048,576 (1M) |
| Output Tokens | 65,536 (64K) | 65,536 (64K) |
| Thinking Levels | `low`, `high` | `minimal`, `low`, `medium`, `high` |
| Best For | Complex reasoning, analysis | Speed, chat, high-throughput |

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

**Note:** SDK v1.33.0 only exports `ThinkingLevel.LOW` and `ThinkingLevel.HIGH`. For `MINIMAL` and `MEDIUM`, pass uppercase strings directly (e.g., `"MINIMAL"`) - the API accepts them.

### Thinking Levels by Model

| Level | Pro | Flash | Description |
|-------|-----|-------|-------------|
| `minimal` | ❌ | ✅ | Minimizes latency; model likely won't think |
| `low` | ✅ | ✅ | Faster responses, simple tasks |
| `medium` | ❌ | ✅ | Balanced thinking for most tasks |
| `high` | ✅ (default) | ✅ (default) | Maximum reasoning depth |

**Key points:**
- Neither model can fully disable thinking
- Pro only supports `low` and `high`; using `minimal` or `medium` returns VALIDATION_ERROR
- `includeThoughts: true` returns thought summaries in response parts
- Thoughts tokens tracked via `usageMetadata.thoughtsTokenCount`

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

### Usage

```typescript
// In gemini-text.ts - files are read and base64 encoded
const contents: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

for (const filePath of files) {
  const mimeType = getMimeType(filePath);  // Uses SUPPORTED_MIME_TYPES lookup
  const data = readFileSync(filePath, { encoding: "base64" });
  contents.push({ inlineData: { mimeType, data } });
}
contents.push({ text: textPrompt });
```

Files are added before text (standard multimodal ordering). Fails fast if:
- File doesn't exist
- File extension is not in SUPPORTED_MIME_TYPES

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

The Deep Research agent uses a REST API (not the SDK) for autonomous web research:

```typescript
// Start research - returns interaction ID
POST /v1beta/interactions
{
  input: "research query",
  agent: "deep-research-pro-preview-12-2025",
  background: true,
  agent_config: {
    type: "deep-research",        // REQUIRED - must specify agent type
    thinking_summaries: "auto"    // Optional - enables progress updates
  }
}

// Poll for completion
GET /v1beta/interactions/{interaction_id}
// Returns: { status: "in_progress" | "completed" | "failed", outputs: [...] }
```

**Key points:**
- Long-running: typically 5-30 minutes, max 60 minutes
- Async polling: start task, poll until `status` is `completed` or `failed`
- Output is in `response.outputs[].text`
- Uses `x-goog-api-key` header for authentication (same API key)
- File support: Experimental - requires File Search stores (not inline files)
- Audio inputs are NOT supported for Deep Research

## Tools

| Tool | Description | Model(s) |
|------|-------------|----------|
| `generate_text` | Text generation with thinking | gemini-3-pro (default), gemini-3-flash |
| `generate_image` | Image generation/editing | nano-banana (default), nano-banana-pro |
| `deep_research` | Autonomous web research | deep-research |
| `list_models` | List available models | Static |

### generate_text Parameters

```typescript
{
  prompt: string;           // Required
  model?: "gemini-3-pro" | "gemini-3-flash";  // Default: gemini-3-pro
  thinking_level?: "minimal" | "low" | "medium" | "high";  // Default: high
  system_prompt?: string;
  max_tokens?: number;      // Default: 65536
  temperature?: number;     // Default: 0.7, range 0-1
  files?: string[];         // Multimodal file paths
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
3. ThinkingLevel values map correctly (SDK v1.33.0 lacks MINIMAL/MEDIUM enums; strings used)
4. Error categories match API responses

## Adding New Models

1. Add to `SUPPORTED_*_MODELS` in `types.ts`
2. Add API model ID to `TEXT_MODEL_IDS` or equivalent mapping
3. For text models: add thinking level constraints to `MODEL_THINKING_LEVELS`
4. Add `getModelInfo()` entry in provider
5. Update `list_models` handler if needed
6. Check if model needs thinkingConfig or imageGenerationConfig
