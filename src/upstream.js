/**
 * Upstream abstraction: the chat route talks to `chat()` / `chatStream()` and
 * doesn't care whether the other side is the real OpenAI API or the local
 * mock. Mock mode lets the entire product run end-to-end — budgets,
 * streaming, kill-switch, dashboard — with zero API spend.
 */
import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Real upstream
// ---------------------------------------------------------------------------

export function createOpenAIUpstream({ apiKey, baseURL, timeoutMs = 60_000, maxRetries = 1 }) {
  const client = new OpenAI({
    apiKey,
    timeout: timeoutMs,
    maxRetries,
    ...(baseURL ? { baseURL } : {}),
  });
  return {
    name: 'openai',
    chat: (payload) => client.chat.completions.create({ ...payload, stream: false }),
    // Force include_usage so the final stream chunk carries token counts —
    // without it, streamed calls could not be metered.
    chatStream: (payload) =>
      client.chat.completions.create({
        ...payload,
        stream: true,
        stream_options: { ...payload.stream_options, include_usage: true },
      }),
  };
}

// ---------------------------------------------------------------------------
// Mock upstream (deterministic, no network)
// ---------------------------------------------------------------------------

const MOCK_REPLY =
  'This is a mock completion from the budget proxy. Token usage below is fabricated deterministically from your prompt length so budget metering behaves exactly as it would in production.';

/** ~4 chars per token, same heuristic as the cost estimator. */
function fakeTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function mockUsage(payload) {
  const promptChars = (payload.messages ?? []).reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
    0,
  );
  return {
    prompt_tokens: fakeTokens('x'.repeat(Math.max(1, promptChars))),
    completion_tokens: fakeTokens(MOCK_REPLY),
    total_tokens: 0, // filled below
  };
}

function mockCompletion(payload) {
  const usage = mockUsage(payload);
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: payload.model ?? 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: MOCK_REPLY },
        finish_reason: 'stop',
      },
    ],
    usage,
  };
}

/** Async generator that mimics an OpenAI SSE stream, usage in the final chunk. */
async function* mockStream(payload) {
  const model = payload.model ?? 'gpt-4o-mini';
  const created = Math.floor(Date.now() / 1000);
  const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created, model };
  const words = MOCK_REPLY.split(' ');

  yield { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
  for (const word of words) {
    // Small delay so streaming visibly streams during demos.
    await new Promise((r) => setTimeout(r, 15));
    yield { ...base, choices: [{ index: 0, delta: { content: word + ' ' }, finish_reason: null }] };
  }
  yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };

  const usage = mockUsage(payload);
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  yield { ...base, choices: [], usage };
}

export function createMockUpstream() {
  return {
    name: 'mock',
    chat: async (payload) => mockCompletion(payload),
    chatStream: async (payload) => mockStream(payload),
  };
}

export function createUpstream(config) {
  return config.mockUpstream
    ? createMockUpstream()
    : createOpenAIUpstream({
        apiKey: config.openaiApiKey,
        baseURL: config.openaiBaseUrl,
        timeoutMs: config.upstreamTimeoutMs,
        maxRetries: config.upstreamMaxRetries,
      });
}
