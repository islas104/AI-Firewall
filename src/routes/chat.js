/**
 * The proxy surface: POST /v1/chat/completions.
 *
 * Budget lifecycle per request:
 *   1. Estimate a worst-case cost from the request (prompt chars + max_tokens).
 *   2. Atomically RESERVE that estimate in Redis (Lua) — concurrent requests
 *      can never collectively overshoot the ceiling.
 *   3. Forward to the upstream (real OpenAI or mock).
 *   4. COMMIT the actual metered cost and release the reservation.
 *      On upstream failure, commit 0 (pure release).
 *
 * Streaming is fully supported: `stream_options.include_usage` is forced so
 * the final SSE chunk carries token counts, metered after the stream ends.
 */
import { Router } from 'express';
import { computeCost, estimateCost, roundUsd, hasPricing } from '../pricing.js';
import { errorBody } from '../errors.js';

const HALT_BODY = { error: 'Budget exceeded. Agent execution halted.' };

// Agent ids become Redis key segments and metric log fields — constrain them
// to a safe alphabet and bounded length at the boundary.
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// `model` is used as an object key, forwarded upstream, and logged — bound it.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * Validate the request body at the boundary. Returns an { error } describing
 * a 400, or null if the payload is safe to price and forward. This is where
 * the pen-test findings are closed: negative/huge max_tokens, null message
 * elements, prototype-colliding or unpriced model names.
 */
function validateChatPayload(payload, config) {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return { type: 'invalid_request', message: 'Request body must include a non-empty "messages" array.' };
  }
  // Every element must be a non-null object — otherwise estimateCost throws
  // before the try/catch and the request hangs with no response.
  for (const m of payload.messages) {
    if (typeof m !== 'object' || m === null || Array.isArray(m)) {
      return { type: 'invalid_request', message: 'Each item in "messages" must be an object.' };
    }
  }

  if (payload.model !== undefined && (typeof payload.model !== 'string' || !MODEL_RE.test(payload.model))) {
    return { type: 'invalid_request', message: 'Invalid "model": must be a short alphanumeric identifier.' };
  }
  const model = payload.model ?? 'gpt-4o-mini';
  if (config.rejectUnknownModels && !hasPricing(config.pricing, model)) {
    return {
      type: 'unknown_model',
      message: `Model "${model}" has no configured pricing and cannot be metered. Add it to MODEL_PRICING or use a known model.`,
    };
  }

  for (const field of ['max_tokens', 'max_completion_tokens']) {
    const v = payload[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || !Number.isInteger(v)) {
      return { type: 'invalid_request', message: `"${field}" must be a positive integer.` };
    }
    if (v > config.maxTokensCeiling) {
      return {
        type: 'invalid_request',
        message: `"${field}" exceeds the maximum of ${config.maxTokensCeiling}.`,
      };
    }
  }
  return null;
}

export function chatRouter({ config, budget, upstream, metrics }) {
  const router = Router();

  router.post('/v1/chat/completions', async (req, res) => {
    const log = req.log ?? console;
    const agentId = req.header('X-Agent-ID');
    const payload = req.body ?? {};

    // --- Validation at the boundary ----------------------------------------
    if (!agentId) {
      return res.status(400).json(errorBody('Missing required header: X-Agent-ID.', 'missing_agent_id'));
    }
    if (!AGENT_ID_RE.test(agentId)) {
      return res
        .status(400)
        .json(
          errorBody(
            'Invalid X-Agent-ID: use 1-64 characters from [A-Za-z0-9._-], starting alphanumeric.',
            'invalid_agent_id',
          ),
        );
    }
    if (config.agentAllowlist && !config.agentAllowlist.includes(agentId)) {
      log.warn(`[allowlist] rejected unknown agent=${agentId} ip=${req.ip}`);
      return res
        .status(403)
        .json(errorBody(`Agent "${agentId}" is not on the allowlist.`, 'agent_not_allowed'));
    }

    const invalid = validateChatPayload(payload, config);
    if (invalid) {
      return res.status(400).json(errorBody(invalid.message, invalid.type));
    }

    const model = payload.model ?? 'gpt-4o-mini';
    const estimate = estimateCost(config.pricing, payload, config.defaultCompletionEstimate);

    // --- Atomic reservation (the kill-switch) -------------------------------
    let reservation;
    try {
      reservation = await budget.reserve(agentId, estimate);
    } catch (err) {
      log.error(`[budget] reserve failed: ${err.message}`);
      // Fail closed: if we can't verify the budget, we don't spend money.
      return res
        .status(503)
        .json(errorBody('Budget store unavailable; refusing to forward request.', 'store_unavailable'));
    }

    if (reservation.status === 'halt') {
      metrics?.budgetHalts.inc();
      log.warn(
        `[halt] agent=${agentId} spent=$${reservation.spent.toFixed(4)} >= limit=$${reservation.limit}`,
      );
      return res.status(402).json(HALT_BODY);
    }
    if (reservation.status === 'halt_global') {
      metrics?.globalBudgetHalts.inc();
      log.error(
        `[halt-global] fleet-wide daily budget exhausted — agent=${agentId} rejected`,
      );
      return res
        .status(402)
        .json(errorBody('Global daily budget exceeded. All agent execution halted.', 'global_budget_exceeded'));
    }
    if (reservation.status === 'defer') {
      // Committed spend is still under the limit, but in-flight requests have
      // reserved the remainder. 429 (not 402): the caller may retry after
      // those requests settle.
      metrics?.budgetContention.inc();
      res.set('Retry-After', '5');
      return res
        .status(429)
        .json(
          errorBody(
            'Remaining daily budget is reserved by concurrent in-flight requests. Retry shortly.',
            'budget_contention',
          ),
        );
    }

    const release = async (actualCost) => {
      try {
        const total = await budget.commit(agentId, actualCost, estimate);
        if (actualCost > 0) metrics?.spendUsd.inc(actualCost);
        return total;
      } catch (err) {
        // The API call already happened and cost real money. Log loudly so
        // the discrepancy is visible; never fail the response over metering.
        log.error(
          `[budget] FAILED to commit cost=$${actualCost} agent=${agentId} — spend under-counted: ${err.message}`,
        );
        return reservation.spent + actualCost;
      }
    };

    const ctx = { req, res, config, upstream, release, agentId, model, payload, estimate, limit: reservation.limit, metrics, log };
    return payload.stream ? handleStream(ctx) : handleBlocking(ctx);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Non-streaming path
// ---------------------------------------------------------------------------

async function handleBlocking({ res, config, upstream, release, agentId, model, payload, limit, metrics, log }) {
  let completion;
  try {
    completion = await upstream.chat(payload);
  } catch (err) {
    await release(0); // pure release — nothing was spent... that we know of
    metrics?.upstreamErrors.inc();
    const { status, clientMessage } = classifyUpstreamError(err);
    log.error(`[upstream] agent=${agentId} status=${status} raw=${err?.error?.message ?? err?.message}`);
    return res.status(status).json(errorBody(clientMessage, 'upstream_error'));
  }

  const usage = completion.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const cost = computeCost(config.pricing, model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
  const newTotal = await release(cost);

  logMeter(log, { agentId, model, usage, cost, newTotal, limit });
  setBudgetHeaders(res, cost, newTotal, limit);
  return res.status(200).json(completion);
}

// ---------------------------------------------------------------------------
// Streaming path (SSE passthrough with usage capture)
// ---------------------------------------------------------------------------

async function handleStream({ req, res, config, upstream, release, agentId, model, payload, estimate, limit, metrics, log }) {
  let stream;
  try {
    stream = await upstream.chatStream(payload);
  } catch (err) {
    await release(0);
    metrics?.upstreamErrors.inc();
    const { status, clientMessage } = classifyUpstreamError(err);
    log.error(`[upstream] agent=${agentId} status=${status} raw=${err?.error?.message ?? err?.message}`);
    return res.status(status).json(errorBody(clientMessage, 'upstream_error'));
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // If the client walks away mid-stream, abort the upstream call so we stop
  // paying for tokens nobody will read.
  req.on('close', () => stream?.controller?.abort?.());

  let usage = null;
  let streamedChars = 0;
  try {
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      streamedChars += chunk.choices?.[0]?.delta?.content?.length ?? 0;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    log.error(`[stream] agent=${agentId} aborted: ${err.message}`);
  } finally {
    // Meter from real usage when present. If the stream died before the usage
    // chunk, fail CONSERVATIVELY: charge the larger of the full reservation
    // estimate and what actually flowed, never the possibly-zero char count.
    const cost = usage
      ? computeCost(config.pricing, model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0)
      : Math.max(estimate, computeCost(config.pricing, model, 0, Math.ceil(streamedChars / 4)));
    const newTotal = await release(cost);
    logMeter(log, {
      agentId,
      model,
      usage: usage ?? { prompt_tokens: '?', completion_tokens: `~${Math.ceil(streamedChars / 4)}` },
      cost,
      newTotal,
      limit,
    });
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function setBudgetHeaders(res, cost, newTotal, limit) {
  res.set('X-Budget-Cost-USD', String(roundUsd(cost)));
  res.set('X-Budget-Spent-USD', String(roundUsd(newTotal)));
  if (limit !== null) {
    res.set('X-Budget-Remaining-USD', String(roundUsd(Math.max(0, limit - newTotal))));
  }
}

/**
 * Map an upstream (OpenAI) error to a safe status + client message. Auth and
 * permission failures can echo a partially-masked key or org details, so those
 * are replaced with a generic message (the raw text still goes to the logs).
 */
function classifyUpstreamError(err) {
  const status = Number.isInteger(err?.status) ? err.status : 502;
  if (status === 401 || status === 403) {
    return { status: 502, clientMessage: 'Upstream authentication error. The proxy operator has been notified.' };
  }
  const raw = err?.error?.message ?? err?.message ?? 'Upstream request failed.';
  // Bound the relayed message and strip anything key-shaped defensively.
  const clientMessage = String(raw).slice(0, 300).replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
  return { status, clientMessage };
}

function logMeter(log, { agentId, model, usage, cost, newTotal, limit }) {
  const limitSuffix = limit ? '/' + limit : '';
  const safeModel = String(model).slice(0, 64);
  log.info(
    `[meter] agent=${agentId} model=${safeModel} in=${usage.prompt_tokens} out=${usage.completion_tokens} ` +
      `cost=$${roundUsd(cost).toFixed(6)} total=$${roundUsd(newTotal).toFixed(4)}${limitSuffix}`,
  );
}
