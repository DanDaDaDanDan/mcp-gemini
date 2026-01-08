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

// Default timeout: 60 minutes (research can take up to 60 min, most complete in ~20)
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
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

    const requestBody = {
      input: query,
      agent: DEEP_RESEARCH_AGENT_ID,
      background: true,
      agent_config: {
        type: "deep-research",
        thinking_summaries: "auto",
      },
    };

    logger.debugLog("Deep research API request", {
      url,
      method: "POST",
      agent: DEEP_RESEARCH_AGENT_ID,
      queryPreview: query.substring(0, 200) + (query.length > 200 ? "..." : ""),
      requestBody: { ...requestBody, input: `[${query.length} chars]` },
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    logger.debugLog("Deep research API response", {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("Deep research API error response", {
        status: response.status,
        statusText: response.statusText,
        errorBody: errorText,
      });

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
    logger.debugLog("Deep research started successfully", {
      interactionId: data.id,
      status: data.status,
    });

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

      logger.debugLog("Polling research status", {
        url,
        interactionId,
        elapsedMs: elapsed,
        elapsedMinutes: Math.round(elapsed / 1000 / 60 * 10) / 10,
      });

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "x-goog-api-key": this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("Deep research poll error", {
          interactionId,
          status: response.status,
          statusText: response.statusText,
          errorBody: errorText,
        });
        throw new Error(`API_ERROR: Failed to poll research status: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as InteractionResponse;

      logger.debugLog("Research poll response", {
        interactionId,
        status: data.status,
        elapsedMs: elapsed,
        hasOutputs: !!data.outputs,
        outputCount: data.outputs?.length,
        hasError: !!data.error,
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

  /**
   * Check status of a running research task by interaction ID
   * Can be used to resume/retrieve results after a timeout
   */
  async checkResearch(interactionId: string): Promise<DeepResearchResult> {
    const startTime = Date.now();

    logger.info("Checking research status", { interactionId });

    const url = `${API_BASE}/interactions/${interactionId}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-goog-api-key": this.apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("Check research error", {
        interactionId,
        status: response.status,
        statusText: response.statusText,
        errorBody: errorText,
      });

      if (response.status === 404) {
        throw new Error(`NOT_FOUND: Research task not found - interaction ID: ${interactionId}`);
      }
      throw new Error(`API_ERROR: Failed to check research status: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as InteractionResponse;

    logger.info("Research status retrieved", {
      interactionId,
      status: data.status,
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
        interactionId,
        durationMs: Date.now() - startTime,
      };
    }

    if (data.status === "failed") {
      const errorMessage = data.error?.message || "Research failed with unknown error";
      throw new Error(`RESEARCH_FAILED: ${errorMessage}`);
    }

    // Still in progress
    return {
      text: `Research still in progress. Status: ${data.status}. Check again later using interaction ID: ${interactionId}`,
      status: "in_progress" as any,
      model: "deep-research",
      interactionId,
      durationMs: Date.now() - startTime,
    };
  }

  getModelInfo(): ModelInfo {
    return {
      id: "deep-research",
      name: "Deep Research Pro",
      provider: "google",
      type: "research",
      description:
        "AI research agent that autonomously searches the web, analyzes multiple sources, " +
        "and produces comprehensive research reports. Takes 5-60 minutes to complete.",
    };
  }
}
