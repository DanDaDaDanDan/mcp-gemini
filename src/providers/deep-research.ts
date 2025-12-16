/**
 * Deep Research provider using Google's Deep Research Agent API
 *
 * Uses direct REST API calls since the @google/genai SDK doesn't support the interactions API yet.
 * The agent performs autonomous web research and returns comprehensive reports.
 */

import type { DeepResearchOptions, DeepResearchResult, ModelInfo, DeepResearchProvider } from "../types.js";
import { DEEP_RESEARCH_AGENT_ID } from "../types.js";
import { logger } from "../logger.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Default timeout: 30 minutes (research can take up to 60 min, most complete in ~20)
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10 * 1000;

interface InteractionResponse {
  id: string;
  status: "in_progress" | "completed" | "failed";
  outputs?: Array<{ text?: string }>;
  error?: { message: string };
}

export class GeminiDeepResearchProvider implements DeepResearchProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("Gemini API key is required");
    }
    this.apiKey = apiKey;
    logger.info("Deep Research provider initialized", { agent: DEEP_RESEARCH_AGENT_ID });
  }

  /**
   * Start a deep research task and poll until completion
   */
  async research(options: DeepResearchOptions): Promise<DeepResearchResult> {
    const {
      query,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    } = options;

    const startTime = Date.now();

    logger.debugLog("Starting deep research", {
      queryLength: query.length,
      timeoutMs,
      pollIntervalMs,
    });

    // Start the research task
    const interactionId = await this.startResearch(query);
    logger.info("Deep research started", { interactionId });

    // Poll for completion
    const result = await this.pollForCompletion(interactionId, timeoutMs, pollIntervalMs, startTime);

    const durationMs = Date.now() - startTime;
    logger.info("Deep research completed", {
      interactionId,
      status: result.status,
      durationMs,
      resultLength: result.text.length,
    });

    return {
      ...result,
      interactionId,
      durationMs,
    };
  }

  /**
   * Start a new research interaction
   */
  private async startResearch(query: string): Promise<string> {
    const url = `${API_BASE}/interactions`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify({
        input: query,
        agent: DEEP_RESEARCH_AGENT_ID,
        background: true,
        agent_config: {
          thinking_summaries: "auto",
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Failed to start research: ${response.status}`;
      let isAuthError = false;

      try {
        let errorJson = JSON.parse(errorText);
        // API sometimes returns array wrapper: [{error: {...}}]
        if (Array.isArray(errorJson) && errorJson.length > 0) {
          errorJson = errorJson[0];
        }
        if (errorJson.error?.message) {
          errorMessage = errorJson.error.message;
        }
        // Google returns 400 (not 401/403) for invalid API keys with API_KEY_INVALID reason
        if (errorJson.error?.details) {
          const hasApiKeyInvalid = errorJson.error.details.some(
            (d: { reason?: string }) => d.reason === "API_KEY_INVALID"
          );
          if (hasApiKeyInvalid) {
            isAuthError = true;
          }
        }
      } catch {
        if (errorText) {
          errorMessage = errorText;
        }
      }

      if (isAuthError || response.status === 401 || response.status === 403) {
        throw new Error(`AUTH_ERROR: ${errorMessage}`);
      } else if (response.status === 429) {
        throw new Error(`RATE_LIMIT: ${errorMessage}`);
      } else {
        throw new Error(`API_ERROR: ${errorMessage}`);
      }
    }

    const data = (await response.json()) as InteractionResponse;

    if (!data.id) {
      throw new Error("API_ERROR: No interaction ID returned from API");
    }

    return data.id;
  }

  /**
   * Poll for research completion
   */
  private async pollForCompletion(
    interactionId: string,
    timeoutMs: number,
    pollIntervalMs: number,
    startTime: number
  ): Promise<{ text: string; status: "completed" | "failed"; model: string }> {
    const url = `${API_BASE}/interactions/${interactionId}`;

    while (true) {
      const elapsed = Date.now() - startTime;

      if (elapsed > timeoutMs) {
        const minutes = Math.round(elapsed / 1000 / 60);
        throw new Error(
          `TIMEOUT: Research timed out after ${minutes} minutes. ` +
            `The research may still be running - interaction ID: ${interactionId}`
        );
      }

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "x-goog-api-key": this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API_ERROR: Failed to poll research status: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as InteractionResponse;

      logger.debugLog("Research poll", {
        interactionId,
        status: data.status,
        elapsedMs: elapsed,
      });

      if (data.status === "completed") {
        const text = data.outputs
          ?.map((output) => output.text)
          .filter(Boolean)
          .join("\n\n") || "";

        if (!text) {
          throw new Error("API_ERROR: Research completed but no output text found");
        }

        return {
          text,
          status: "completed",
          model: "deep-research",
        };
      }

      if (data.status === "failed") {
        const errorMessage = data.error?.message || "Research failed with unknown error";
        throw new Error(`RESEARCH_FAILED: ${errorMessage}`);
      }

      await this.sleep(pollIntervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getModelInfo(): ModelInfo {
    return {
      id: "deep-research",
      name: "Deep Research Pro",
      provider: "google",
      type: "research",
      description:
        "AI research agent that autonomously searches the web, analyzes multiple sources, " +
        "and produces comprehensive research reports. Takes 5-30 minutes to complete.",
    };
  }
}
