/**
 * Logging utility for the MCP Gemini server
 *
 * Logs to stderr (stdout is reserved for MCP protocol) and optionally
 * to a log file for usage tracking.
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  event: string;
  details?: Record<string, unknown>;
}

export interface UsageEntry {
  timestamp: string;
  model: string;
  type: "text" | "image";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  thoughtsTokens?: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

class Logger {
  private logFile: string | null = null;
  private usageFile: string | null = null;
  private debug: boolean = false;

  constructor() {
    // Debug mode: default to true, can be disabled with MCP_DEBUG=false
    this.debug = process.env.MCP_DEBUG !== "false";

    // Log directory: default to ./logs, can be overridden or disabled with MCP_LOG_DIR=none
    const logDir = process.env.MCP_LOG_DIR ?? "logs";
    if (logDir === "none") {
      return;
    }
    try {
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      this.logFile = join(logDir, "mcp-gemini.log");
      this.usageFile = join(logDir, "usage.jsonl");
      this.info("Logger initialized", { logDir, logFile: this.logFile, usageFile: this.usageFile });
    } catch (error: any) {
      console.error(`[mcp-gemini] Failed to initialize log files: ${error.message}`);
    }
  }

  private formatEntry(entry: LogEntry): string {
    const parts = [`[${entry.timestamp}]`, `[${entry.level.toUpperCase()}]`, entry.event];
    if (entry.details) {
      parts.push(JSON.stringify(entry.details));
    }
    return parts.join(" ");
  }

  private log(level: LogEntry["level"], event: string, details?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      details,
    };

    // Always log to stderr for visibility
    const message = this.formatEntry(entry);
    if (level === "error") {
      console.error(`[mcp-gemini] ${message}`);
    } else if (level === "warn") {
      console.error(`[mcp-gemini] ${message}`);
    } else if (this.debug || level === "info") {
      console.error(`[mcp-gemini] ${message}`);
    }

    // Log to file if configured
    if (this.logFile) {
      try {
        appendFileSync(this.logFile, message + "\n");
      } catch {
        // Silently fail file logging
      }
    }
  }

  info(event: string, details?: Record<string, unknown>): void {
    this.log("info", event, details);
  }

  warn(event: string, details?: Record<string, unknown>): void {
    this.log("warn", event, details);
  }

  error(event: string, details?: Record<string, unknown>): void {
    this.log("error", event, details);
  }

  debugLog(event: string, details?: Record<string, unknown>): void {
    if (this.debug) {
      this.log("debug", event, details);
    }
  }

  /**
   * Log usage statistics for a generation request
   */
  logUsage(entry: UsageEntry): void {
    // Log summary to stderr
    const summary = entry.success
      ? `${entry.type} generation complete: ${entry.model}, ${entry.totalTokens || "?"} tokens, ${entry.durationMs}ms`
      : `${entry.type} generation failed: ${entry.model}, ${entry.error}`;
    this.info(summary);

    // Log detailed usage to file if configured
    if (this.usageFile) {
      try {
        appendFileSync(this.usageFile, JSON.stringify(entry) + "\n");
      } catch {
        // Silently fail file logging
      }
    }
  }
}

// Export singleton instance
export const logger = new Logger();
