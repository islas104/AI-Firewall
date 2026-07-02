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
import { computeCost, estimateCost, roundUsd } from '../pricing.js';
import { errorBody } from '../errors.js';

const HALT_BODY = { error: 'Budget exceeded. Agent execution halted.' };

export function chatRouter({ config, budget, upstream }) {
  const router = Router();

  router.post('/v1/chat/completions', async (req, res) => {
    const agentId = req.header('X-Agent-ID');
    const payload = req.body ?? {};

    // --- Validation at the boundary ----------------------------------------
    if (!agentId) {
      return res.status(400).json(errorBody('Missing required header: X-Agent-ID.', 'missing_agent_id'));
    }
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      return res
        .status(400)
        .json(errorBody('Request body must include a non-empty "messages" array.', 'invalid_request'));
    }

    const model = payload.model ?? 'gpt-4o-mini';
    const estimate = estimateCost(config.pricing, payload, config.defaultCompletionEstimate);

    // --- Atomic reservation (the kill-switch) -------------------------------
    let reservation;
    try {
      reservation = await budget.reserve(agentId, estimate);
    } catch (err) {
      console.error('[budget] reserve failed:', err.message);
      // Fail closed: if we can't verify the budget, we don't spend money.
      return res
        .status(503)
        .json(errorBody('Budget store unavailable; refusing to forward request.', 'store_unavailable'));
    }

    if (reservation.status === 'halt') {
      console.warn(
        `[halt] agent=${agentId} spent=$${reservation.spent.toFixed(4)} >= limit=$${reservation.limit}`,
      );
      return res.status(402).json(HALT_BODY);
    }
    if (reservation.status === 'defer') {
      // Committed spend is still under the limit, but in-flight requests have
      // reserved the remainder. 429 (not 402): the caller may retry after
      // those requests settle.
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
        return await budget.commit(agentId, actualCost, estimate);
      } catch (err) {
        // The API call already happened and cost real money. Log loudly so
        // the discrepancy is visible; never fail the response over metering.
        console.error(
          `[budget] FAILED to commit cost=$${actualCost} agent=${agentId} — spend under-counted:`,
          err.message,
        );
        return reservation.spent + actualCost;
      }
    };

    const limit = reservation.limit;
    return payload.stream
      ? handleStream({ req, res, config, upstream, release, agentId, model, payload, estimate, limit })
      : handleBlocking({ res, config, upstream, release, agentId, model, payload, limit });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Non-streaming path
// ---------------------------------------------------------------------------

async function handleBlocking({ res, config, upstream, release, agentId, model, payload, limit }) {
  let completion;
  try {
    completion = await upstream.chat(payload);
  } catch (err) {
    await release(0); // pure release — nothing was spent... that we know of
    const status = err?.status ?? 502;
    const message = err?.error?.message ?? err?.message ?? 'Upstream request failed.';
    console.error(`[upstream] agent=${agentId} status=${status} message=${message}`);
    return res.status(status).json(errorBody(message, 'upstream_error'));
  }

  const usage = completion.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const cost = computeCost(config.pricing, model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
  const newTotal = await release(cost);

  logMeter({ agentId, model, usage, cost, newTotal, limit });
  setBudgetHeaders(res, cost, newTotal, limit);
  return res.status(200).json(completion);
}

// ---------------------------------------------------------------------------
// Streaming path (SSE passthrough with usage capture)
// ---------------------------------------------------------------------------

async function handleStream({ req, res, config, upstream, release, agentId, model, payload, estimate, limit }) {
  let stream;
  try {
    stream = await upstream.chatStream(payload);
  } catch (err) {
    await release(0);
    const status = err?.status ?? 502;
    const message = err?.error?.message ?? err?.message ?? 'Upstream request failed.';
    console.error(`[upstream] agent=${agentId} status=${status} message=${message}`);
    return res.status(status).json(errorBody(message, 'upstream_error'));
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
    console.error(`[stream] agent=${agentId} aborted: ${err.message}`);
  } finally {
    // Meter from real usage when present; if the stream died before the
    // usage chunk, charge a conservative estimate from what actually flowed.
    const cost = usage
      ? computeCost(config.pricing, model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0)
      : Math.min(estimate, computeCost(config.pricing, model, 0, Math.ceil(streamedChars / 4)));
    const newTotal = await release(cost);
    logMeter({ agentId, model, usage: usage ?? { prompt_tokens: '?', completion_tokens: `~${Math.ceil(streamedChars / 4)}` }, cost, newTotal, limit });
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

function logMeter({ agentId, model, usage, cost, newTotal, limit }) {
  console.log(
    `[meter] agent=${agentId} model=${model} in=${usage.prompt_tokens} out=${usage.completion_tokens} ` +
      `cost=$${roundUsd(cost).toFixed(6)} total=$${roundUsd(newTotal).toFixed(4)}${limit ? `/${limit}` : ''}`,
  );
}
