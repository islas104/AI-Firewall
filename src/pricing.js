/**
 * Pricing & cost math. Pure functions — no I/O — so they are trivially
 * unit-testable and safe to call anywhere.
 *
 * All rates are USD per 1,000 tokens.
 */

export const DEFAULT_PRICING = Object.freeze({
  'gpt-4o-mini': { input: 0.0015, output: 0.002 },
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  DEFAULT: { input: 0.0015, output: 0.002 },
});

/** Merge MODEL_PRICING env JSON over the defaults. Invalid JSON → defaults. */
export function loadPricing(envJson) {
  if (!envJson) return DEFAULT_PRICING;
  try {
    return Object.freeze({ ...DEFAULT_PRICING, ...JSON.parse(envJson) });
  } catch {
    console.warn('[config] MODEL_PRICING is not valid JSON — using defaults.');
    return DEFAULT_PRICING;
  }
}

/** Per-1k rates for a model, falling back to the DEFAULT tier. */
export function priceFor(pricing, model) {
  return pricing[model] ?? pricing.DEFAULT;
}

/** Round to 6 dp — sub-cent precision without float noise accumulating. */
export function roundUsd(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** Exact USD cost of one call from its reported token usage. */
export function computeCost(pricing, model, promptTokens, completionTokens) {
  const { input, output } = priceFor(pricing, model);
  return roundUsd((promptTokens / 1000) * input + (completionTokens / 1000) * output);
}

/**
 * Worst-case cost estimate for a request BEFORE it is sent. Used to reserve
 * budget atomically so concurrent requests cannot collectively overshoot the
 * ceiling. Intentionally pessimistic:
 *  - prompt tokens ≈ total content chars / 4 (the classic heuristic)
 *  - completion tokens = max_tokens if given, else a configurable default
 */
export function estimateCost(pricing, payload, defaultCompletionEstimate) {
  const model = payload.model ?? 'gpt-4o-mini';
  const chars = (payload.messages ?? []).reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length),
    0,
  );
  const promptEstimate = Math.max(1, Math.ceil(chars / 4));
  const completionEstimate = payload.max_tokens ?? payload.max_completion_tokens ?? defaultCompletionEstimate;
  return computeCost(pricing, model, promptEstimate, completionEstimate);
}
