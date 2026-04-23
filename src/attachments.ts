/**
 * Shared multimodal attachment handling.
 *
 * Converts Attachment descriptors (path, base64 data, or URL) into Gemini's
 * inline-data part format. Used by both text generation and deep research.
 */

import { readFileSync, existsSync } from "fs";
import { extname } from "path";
import type { Attachment } from "./types.js";
import { SUPPORTED_MIME_TYPES } from "./types.js";
import { logger } from "./logger.js";

export interface InlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeType = SUPPORTED_MIME_TYPES[ext];
  if (!mimeType) {
    const supportedExts = Object.keys(SUPPORTED_MIME_TYPES).join(", ");
    throw new Error(
      `Unsupported file type "${ext}". Supported types: ${supportedExts}`
    );
  }
  return mimeType;
}

/**
 * Resolve an array of Attachment descriptors into inline-data parts.
 * Fetches URLs, reads files, and validates that exactly one source is set.
 */
export async function buildInlineAttachments(
  attachments: Attachment[]
): Promise<InlineDataPart[]> {
  const parts: InlineDataPart[] = [];

  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const sources = [attachment.path, attachment.data, attachment.url].filter(Boolean);
    if (sources.length !== 1) {
      throw new Error(
        `VALIDATION_ERROR: Attachment ${i}: exactly one of 'path', 'data', or 'url' must be provided (got ${sources.length})`
      );
    }

    let mimeType: string | undefined = attachment.media_type;
    let base64Data: string;

    if (attachment.path) {
      if (!existsSync(attachment.path)) {
        throw new Error(`File not found: ${attachment.path}`);
      }
      if (!mimeType) {
        mimeType = getMimeType(attachment.path);
      }
      base64Data = readFileSync(attachment.path, { encoding: "base64" });
      logger.debugLog("Added file attachment", { path: attachment.path, mimeType });
    } else if (attachment.data) {
      if (!mimeType) {
        throw new Error(`VALIDATION_ERROR: Attachment ${i}: 'media_type' is required when using 'data'`);
      }
      if (attachment.data.startsWith("data:")) {
        const match = attachment.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
          throw new Error(`VALIDATION_ERROR: Attachment ${i}: invalid data URI format`);
        }
        base64Data = match[2];
      } else {
        base64Data = attachment.data;
      }
      logger.debugLog("Added base64 attachment", { mimeType, dataLength: base64Data.length });
    } else {
      if (!mimeType) {
        throw new Error(`VALIDATION_ERROR: Attachment ${i}: 'media_type' is required when using 'url'`);
      }
      const response = await fetch(attachment.url!);
      if (!response.ok) {
        throw new Error(
          `VALIDATION_ERROR: Attachment ${i}: failed to fetch URL: ${response.status} ${response.statusText}`
        );
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      base64Data = buffer.toString("base64");
      logger.debugLog("Added URL attachment", { url: attachment.url, mimeType });
    }

    parts.push({ inlineData: { mimeType: mimeType!, data: base64Data } });
  }

  return parts;
}
