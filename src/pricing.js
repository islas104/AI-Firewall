/**
 * Pricing & cost math. Pure functions — no I/O — so they are trivially
 * unit-testable and safe to call anywhere.
 *
 * All rates are USD per 1,000 tokens.
 *
 * Security notes (hardened after the pen-test round):
 *  - `priceFor` uses Object.hasOwn so a `model` of "constructor"/"toString"
 *    etc. cannot resolve to an inherited Object.prototype member (which used
 *    to yield NaN cost and crash the Redis Lua script).
 *  - `hasPricing` lets callers reject unpriced models instead of silently
 *    billing them at the cheap DEFAULT tier (which let an "o1" request record
 *    gpt-4o-mini-priced spend and slip past the ceiling).
 *  - Cost helpers clamp inputs to finite, non-negative numbers so a negative
 *    or NaN token count can never poison the ledger.
 */

export const DEFAULT_PRICING = Object.freeze({
  'gpt-4o-mini': { input: 0.0015, output: 0.002 },
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  DEFAULT: { input: 0.0015, output: 0.002 },
});

// Estimation is deliberately pessimistic — it governs the reservation that
// stops concurrent requests from overshooting a limit, so under-estimating is
// the dangerous direction. ~3 chars/token (vs the real ~4) pads for dense and
// non-English text; each image block is charged a conservative token floor
// rather than the length of its (short) URL string.
const EST_CHARS_PER_TOKEN = 3;
const EST_IMAGE_TOKEN_FLOOR = 1200;

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

/** True only if the model has an explicit own entry (not the DEFAULT tier). */
export function hasPricing(pricing, model) {
  return typeof model === 'string' && Object.hasOwn(pricing, model) && model !== 'DEFAULT';
}

/**
 * Per-1k rates for a model. Uses own-property lookup so prototype member names
 * ("constructor", "toString", …) can't resolve to inherited functions. Unknown
 * models fall back to the DEFAULT tier — callers that must not bill unknown
 * models should gate on `hasPricing` first.
 */
export function priceFor(pricing, model) {
  if (typeof model === 'string' && Object.hasOwn(pricing, model)) return pricing[model];
  return pricing.DEFAULT;
}

/** Coerce to a finite, non-negative number (defends the ledger). */
function safeNonNeg(n) {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Round to 6 dp — sub-cent precision without float noise accumulating. */
export function roundUsd(n) {
  return Math.round(safeNonNeg(n) * 1e6) / 1e6;
}

/** Exact USD cost of one call from its reported token usage. */
export function computeCost(pricing, model, promptTokens, completionTokens) {
  const { input, output } = priceFor(pricing, model);
  const p = safeNonNeg(promptTokens);
  const c = safeNonNeg(completionTokens);
  return roundUsd((p / 1000) * input + (c / 1000) * output);
}

/** Token estimate for one message's content (text chars + image floors). */
function estimateContentTokens(content) {
  if (typeof content === 'string') {
    return Math.ceil(content.length / EST_CHARS_PER_TOKEN);
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      const isImage = part?.type === 'image_url' || part?.image_url || part?.type === 'input_image';
      if (isImage) return sum + EST_IMAGE_TOKEN_FLOOR;
      const text = typeof part?.text === 'string' ? part.text : JSON.stringify(part ?? '');
      return sum + Math.ceil(text.length / EST_CHARS_PER_TOKEN);
    }, 0);
  }
  return Math.ceil(JSON.stringify(content ?? '').length / EST_CHARS_PER_TOKEN);
}

/**
 * Worst-case cost estimate for a request BEFORE it is sent. Used to reserve
 * budget atomically so concurrent requests cannot collectively overshoot the
 * ceiling. Intentionally pessimistic. `max_tokens` is assumed already
 * validated/clamped by the caller; this function additionally floors it at 0.
 */
export function estimateCost(pricing, payload, defaultCompletionEstimate) {
  const model = typeof payload.model === 'string' ? payload.model : 'gpt-4o-mini';
  const promptTokens = (payload.messages ?? []).reduce(
    (sum, m) => sum + estimateContentTokens(m?.content),
    0,
  );
  const requested = payload.max_tokens ?? payload.max_completion_tokens;
  const completionTokens = safeNonNeg(requested) || defaultCompletionEstimate;
  return computeCost(pricing, model, Math.max(1, promptTokens), completionTokens);
}
