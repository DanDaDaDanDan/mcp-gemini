/**
 * Google Gemini Model Pricing and Cost Calculation
 *
 * Pricing sources:
 * - Text: https://ai.google.dev/pricing
 * - Image: Nano Banana estimates
 * Last updated: January 2026
 */

// ============================================================================
// Types
// ============================================================================

export interface TokenPricing {
  input: number; // USD per 1M input tokens
  output: number; // USD per 1M output tokens
  thoughts?: number; // USD per 1M thinking tokens (for thinking models)
}

export interface ImagePricing {
  perImage: number; // USD per image
}

export interface CostInfo {
  inputCost?: number;
  outputCost?: number;
  imageCost?: number;
  totalCost: number;
  currency: "USD";
  estimated: boolean;
}

// ============================================================================
// Text Model Pricing (USD per 1M tokens)
// ============================================================================

export const GEMINI_TEXT_PRICING: Record<string, TokenPricing> = {
  "gemini-3-pro": {
    input: 2.0,
    output: 12.0,
    thoughts: 12.0, // Thinking tokens billed as output
  },
  "gemini-3-flash": {
    input: 0.5,
    output: 3.0,
    thoughts: 3.0,
  },
};

// Default text pricing for unknown models
export const DEFAULT_TEXT_PRICING: TokenPricing = {
  input: 2.0,
  output: 12.0,
  thoughts: 12.0,
};

// ============================================================================
// Image Model Pricing (USD per image) - Estimates
// ============================================================================

export const GEMINI_IMAGE_PRICING: Record<string, ImagePricing> = {
  "nano-banana": {
    perImage: 0.039,
  },
  "nano-banana-pro": {
    perImage: 0.15, // Base 1K resolution
  },
};

// Resolution multipliers for nano-banana-pro
export const RESOLUTION_MULTIPLIERS: Record<string, number> = {
  "1K": 1.0,
  "2K": 1.33,
  "4K": 2.0,
};

// ============================================================================
// Cost Calculation Functions
// ============================================================================

/**
 * Calculate cost for text generation
 */
export function calculateTextCost(
  model: string,
  promptTokens: number = 0,
  completionTokens: number = 0,
  thoughtsTokens: number = 0
): CostInfo {
  const pricing = GEMINI_TEXT_PRICING[model];
  const estimated = !pricing;
  const effectivePricing = pricing || DEFAULT_TEXT_PRICING;

  const inputCost = (promptTokens / 1_000_000) * effectivePricing.input;
  const outputCost = (completionTokens / 1_000_000) * effectivePricing.output;
  const thoughtsCost = effectivePricing.thoughts
    ? (thoughtsTokens / 1_000_000) * effectivePricing.thoughts
    : 0;

  const totalCost = inputCost + outputCost + thoughtsCost;

  return {
    inputCost: roundToMicro(inputCost),
    outputCost: roundToMicro(outputCost + thoughtsCost),
    totalCost: roundToMicro(totalCost),
    currency: "USD",
    estimated,
  };
}

/**
 * Calculate cost for image generation
 */
export function calculateImageCost(
  model: string,
  resolution: string = "1K",
  numImages: number = 1
): CostInfo {
  const pricing = GEMINI_IMAGE_PRICING[model];
  const estimated = !pricing;

  if (!pricing) {
    return {
      imageCost: 0,
      totalCost: 0,
      currency: "USD",
      estimated: true,
    };
  }

  const multiplier =
    model === "nano-banana-pro" ? RESOLUTION_MULTIPLIERS[resolution] || 1.0 : 1.0;

  const imageCost = pricing.perImage * multiplier * numImages;

  return {
    imageCost: roundToMicro(imageCost),
    totalCost: roundToMicro(imageCost),
    currency: "USD",
    estimated,
  };
}

/**
 * Round to 6 decimal places (micro-dollar precision)
 */
function roundToMicro(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Get text pricing for a specific model
 */
export function getTextPricing(model: string): TokenPricing & { estimated: boolean } {
  const pricing = GEMINI_TEXT_PRICING[model];
  return {
    ...(pricing || DEFAULT_TEXT_PRICING),
    estimated: !pricing,
  };
}

/**
 * Get image pricing for a specific model
 */
export function getImagePricing(model: string): ImagePricing & { estimated: boolean } {
  const pricing = GEMINI_IMAGE_PRICING[model];
  return {
    ...(pricing || { perImage: 0 }),
    estimated: !pricing,
  };
}
