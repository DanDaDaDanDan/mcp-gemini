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
| gemini-3-pro | `gemini-3-pro-preview` | Text/Thinking |
| nano-banana | `gemini-2.5-flash-preview-image-generation` | Image (fast) |
| nano-banana-pro | `gemini-2.0-flash-exp-image-generation` | Image (high-quality) |

## Thinking Configuration

Gemini 3 Pro uses `thinkingConfig` with `ThinkingLevel` enum:

```typescript
import { ThinkingLevel } from "@google/genai";

config: {
  thinkingConfig: {
    thinkingLevel: ThinkingLevel.HIGH,  // or ThinkingLevel.LOW
    includeThoughts: true,  // Get thought summaries
  }
}
```

**Key points:**
- Gemini 3 Pro cannot disable thinking; only LOW and HIGH are supported
- `includeThoughts: true` returns thought summaries in response parts
- Thoughts tokens tracked via `usageMetadata.thoughtsTokenCount`

## Architecture

```
src/
├── index.ts              # MCP server, tool routing
├── types.ts              # Shared types, model constants
├── logger.ts             # Logging (stderr + optional file)
├── retry.ts              # Exponential backoff, timeout wrapper
└── providers/
    ├── gemini-text.ts    # Gemini 3 Pro with thinking
    └── gemini-image.ts   # Nano Banana / Pro image generation
```

## Multimodal Input

Text generation supports image inputs via file paths:

```typescript
// In gemini-text.ts - images are read and base64 encoded
const contents: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

for (const imagePath of images) {
  const mimeType = getMimeType(imagePath);  // jpg, png, gif, webp, heic, heif
  const data = readFileSync(imagePath, { encoding: "base64" });
  contents.push({ inlineData: { mimeType, data } });
}
contents.push({ text: textPrompt });
```

Images are added before text (standard multimodal ordering). Fails fast if file doesn't exist.

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
3. ThinkingLevel enum values used (not strings)
4. Error categories match API responses

## Adding New Models

1. Add to `SUPPORTED_*_MODELS` in `types.ts`
2. Add model ID mapping in provider file
3. Add `getModelInfo()` entry
4. Update `list_models` handler if needed
5. Check if model needs thinkingConfig or imageGenerationConfig
