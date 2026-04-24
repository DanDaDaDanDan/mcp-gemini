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
| gemini-3.1-pro | `gemini-3.1-pro-preview` | Text/Thinking (latest, most capable) |
| gemini-3-pro | `gemini-3-pro-preview` | Text/Thinking (deep reasoning) |
| gemini-3-flash | `gemini-3-flash-preview` | Text/Thinking (fast, balanced) |
| nano-banana | `gemini-2.5-flash-image` | Image (fast) |
| nano-banana-pro | `gemini-3-pro-image-preview` | Image (high-quality, 2K/4K) |
| deep-research | `deep-research-preview-04-2026` | Research (fast, interactive) |
| deep-research-max | `deep-research-max-preview-04-2026` | Research (comprehensive, async) |

### Model Comparison: Text Models

| Attribute | gemini-3.1-pro | gemini-3-pro | gemini-3-flash |
|-----------|----------------|--------------|----------------|
| Input Tokens | 1,048,576 (1M) | 1,048,576 (1M) | 1,048,576 (1M) |
| Output Tokens | 65,536 (64K) | 65,536 (64K) | 65,536 (64K) |
| Thinking Levels | `low`, `medium`, `high` | `low`, `high` | `minimal`, `low`, `medium`, `high` |
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
| `high` | ✅ (default) | ✅ (default) | ✅ (default) | Maximum reasoning depth |

**Key points:**
- Neither model can fully disable thinking
- 3.1 Pro supports `low`, `medium`, `high`
- 3 Pro only supports `low` and `high`; using `minimal` or `medium` returns VALIDATION_ERROR
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

The Deep Research agents (April 2026 release — both built on Gemini 3.1 Pro)
use the `@google/genai` SDK's native interactions API. Two variants:

- **`deep-research`** (`deep-research-preview-04-2026`) — optimized for speed
  and reduced cost; ideal for interactive UI surfaces.
- **`deep-research-max`** (`deep-research-max-preview-04-2026`) — extended
  test-time compute for maximum comprehensiveness; best for async/background
  workflows. This is our default.

```typescript
// Start research
const interaction = await client.interactions.create({
  // string | typed Content[] | Turn[] | messages-like [{role, content}]
  input: "research query",
  agent: "deep-research-max-preview-04-2026",
  background: true,
  agent_config: {
    type: "deep-research",                     // required
    thinking_summaries: "auto",                // "auto" | "none"
    visualization: "auto",                     // "auto" | "off"
    collaborative_planning: false,             // propose plan before execution
  },
  // Each tool is a discriminated union: { type: "<name>", ...config }.
  tools: [
    { type: "google_search" },
    { type: "url_context" },
    // { type: "code_execution" },
    // { type: "file_search", file_search_store_names: ["fileSearchStores/..."] },
    // { type: "mcp_server", name: "label", url: "https://...", headers: {...} },
  ],
  // previous_interaction_id: "...",
});
```

**Shape gotchas learned the hard way:**
- **Tools need a `type` discriminator**, not a nested key. `{ google_search: {} }`
  is rejected; `{ type: "google_search" }` is correct.
- **Content parts use typed variants** (`{ type, data, mime_type }`), not
  `inline_data` wrappers. Valid content types: `text`, `image`, `document`,
  `audio`, `video`.
- **`DocumentContent` only accepts `application/pdf`** — text/markdown/json
  attachments must be inlined into a text part (our provider does this).
- **`mcp_server` requires both `name` and `url`** at the top level of the tool
  entry; `headers` is optional.
- **`file_search` uses `file_search_store_names`** (resource names like
  `fileSearchStores/my-store-123`), not IDs.

```typescript
// Poll for completion
const result = await client.interactions.get(interaction.id);
// status: "in_progress" | "completed" | "failed" | "cancelled" | "requires_action"
// outputs: Array<TextContent | ImageContent | tool-call content | ...>

// Cancel / delete
await client.interactions.cancel(interaction.id);
await client.interactions.delete(interaction.id);
```

**Collaborative planning flow (observed):** with `collaborative_planning: true`
the first turn completes with `status: "completed"` and the plan as the
response body (~10-30s). Our provider re-surfaces this as
`status: "requires_action"` so callers know to resume by calling
`deep_research` again with the user's refinements as `query` and the returned
`interactionId` as `previous_interaction_id`. That second turn executes the
actual research (5-30+ min).

**Output extraction:** images arrive as `{ type: "image", data, mime_type }`
outputs; text as `{ type: "text", text, annotations? }`. Tool-call and
tool-result content types (`google_search_call`, `file_search_result`, etc.)
are skipped during image extraction. Any unrecognized output type fails hard
with the JSON dumped into the error message — we don't silently drop data.

**Image handling:** Deep Research with `visualization: "auto"` (the default)
generates infographics even for queries that didn't explicitly ask for charts
— a simple 3-paragraph text request can still return 1+ images. Our MCP
surfaces every image as an inline `{ type: "image", data, mimeType }` content
block in the tool response regardless of whether `output_dir` is set. When
`output_dir` is provided, images are additionally persisted to disk and their
paths appear in `_meta.images[].path`. Base64 data is stripped from `_meta`
to avoid bloating metadata.

**Other notes:**
- Long-running: typically 5-30 min for `deep-research`, up to 60 min for max
- `disable_web` in our MCP strips `google_search` + `url_context` for
  proprietary-only research against file stores or MCP servers
- Streaming supported via `stream: true` (SSE) — not exposed through this
  MCP since MCP is request/response

## Tools

| Tool | Description | Model(s) |
|------|-------------|----------|
| `generate_text` | Text generation with thinking and file attachments | gemini-3.1-pro (default), gemini-3-pro, gemini-3-flash |
| `generate_image` | Image generation/editing | nano-banana (default), nano-banana-pro |
| `deep_research` | Autonomous web research with visualizations, MCP tools, and collaborative planning | deep-research-max (default), deep-research |
| `check_research` | Poll status / retrieve results of a running research task | — |
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

### deep_research Parameters

```typescript
{
  query: string;                             // Required
  model?: "deep-research-max" | "deep-research";  // Default: deep-research-max
  visualization?: "auto" | "off";            // Default: auto — inline charts/infographics
  thinking_summaries?: "auto" | "none";      // Default: auto
  collaborative_planning?: boolean;          // Default: false — pause for plan review
  tools?: Array<"google_search" | "url_context" | "code_execution" | "file_search">;
                                             // Default: ["google_search", "url_context"]
  disable_web?: boolean;                     // Default: false — strip web tools
  file_search_store_names?: string[];        // e.g. ["fileSearchStores/my-store-123"]
  mcp_servers?: Array<{ name: string; url: string; headers?: Record<string, string> }>;
  attachments?: Attachment[];                // PDFs, CSVs, images, audio, video, text
  previous_interaction_id?: string;          // Continue after plan review / prior run
  output_dir?: string;                       // Optional: also persist generated images to disk
  timeout_minutes?: number;                  // Default: 120
}
```

Returns `{ text, _meta: { interactionId, status, model, images?, plan? } }`.
When `status === "requires_action"`, the proposed plan is in both `text` and
`_meta.plan`; resume by passing your refinements as `query` and setting
`previous_interaction_id` to the returned `interactionId`.

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
