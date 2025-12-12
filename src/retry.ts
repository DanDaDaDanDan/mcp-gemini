/**
 * Retry utility with exponential backoff
 *
 * Handles transient errors like rate limits gracefully.
 */

import { logger } from "./logger.js";

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableErrors: ["RATE_LIMIT", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "429", "503", "502"],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: Error, retryablePatterns: string[]): boolean {
  const message = error.message || "";
  return retryablePatterns.some(
    (pattern) => message.includes(pattern) || message.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Execute a function with automatic retry on transient failures
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | null = null;
  let delay = opts.initialDelayMs;

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Check if we should retry
      const isRetryable = isRetryableError(error, opts.retryableErrors);
      const hasRetriesLeft = attempt <= opts.maxRetries;

      if (!isRetryable || !hasRetriesLeft) {
        // Non-retryable error or out of retries
        logger.warn("Retry exhausted or non-retryable error", {
          attempt,
          maxRetries: opts.maxRetries,
          isRetryable,
          error: error.message,
        });
        throw error;
      }

      // Log retry attempt
      logger.info("Retrying after transient error", {
        attempt,
        maxRetries: opts.maxRetries,
        delayMs: delay,
        error: error.message,
      });

      // Wait before retry
      await sleep(delay);

      // Increase delay for next attempt (exponential backoff)
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  // Should not reach here, but just in case
  throw lastError || new Error("Retry failed with unknown error");
}

/**
 * Wrap a function to add timeout capability
 */
export async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT: Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}
