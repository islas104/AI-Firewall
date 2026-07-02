# AI Firewall — Agent Budget Proxy

A production-ready proxy that sits between autonomous AI agents and the OpenAI
API. It meters every call, enforces a **hard daily spend ceiling per agent**
with atomic Redis reservations, supports streaming, and ships with a live
control-room dashboard. It is the kill-switch that stops an infinite agent loop
from running up an unbounded bill.

```
┌──────────┐   POST /v1/chat/completions    ┌──────────────┐   forward    ┌─────────┐
│  Agent   │ ─────────────────────────────▶ │  AI Firewall │ ───────────▶ │ OpenAI  │
│          │   X-Agent-ID: crawler-01       │              │ ◀─────────── │  (or    │
└──────────┘ ◀───────────────────────────── └──────┬───────┘   usage      │  mock)  │
       402 halt · 429 contention · SSE             │                      └─────────┘
                                            ┌───────▼───────┐
                                            │     Redis     │  atomic reserve/commit (Lua)
                                            └───────────────┘
                                                    ▲
                                     /dashboard ────┘  live fleet view
```

## Features

- **Atomic hard ceiling** — budget checks and reservations run inside a Redis
  Lua script, so *concurrent* requests can never collectively overshoot the
  limit. Committed spend is mathematically capped at the ceiling.
- **Kill-switch** — once an agent's daily spend reaches its limit, requests are
  rejected with `402` + `{"error": "Budget exceeded. Agent execution halted."}`
  and never reach OpenAI.
- **Reserve → commit lifecycle** — each request reserves its worst-case cost
  (prompt size + `max_tokens`) before forwarding, then commits the exact
  metered cost afterwards. Failed upstream calls release the reservation.
- **Streaming supported** — SSE passthrough with `stream_options.include_usage`
  forced, metered from the final usage chunk. Client disconnects abort the
  upstream call so you stop paying for tokens nobody reads.
- **Per-agent limits** — override the global ceiling per agent via the admin
  API or dashboard.
- **Live dashboard** — `/dashboard` shows the fleet, spend bars, halted agents,
  in-flight reservations; set limits and reset spend from the UI.
- **Mock upstream mode** — run the entire product (budgets, streaming,
  kill-switch, dashboard) with zero OpenAI spend. Used by the test suite.
- **Optional auth** — Bearer key for the proxy surface, separate admin key.

## Quick start (60 seconds, no OpenAI key needed)

```bash
npm install
docker compose up -d redis
npm run demo          # boots with MOCK_UPSTREAM=true
open http://localhost:3000/dashboard
```

Send traffic through it:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Agent-ID: crawler-01" \
  -d '{"model":"gpt-4o-mini","max_tokens":50,"messages":[{"role":"user","content":"hello"}]}' | jq
```

### Real OpenAI traffic

```bash
cp .env.example .env    # set OPENAI_API_KEY, MOCK_UPSTREAM=false
npm start
```

### Everything in Docker

```bash
OPENAI_API_KEY=sk-... MOCK_UPSTREAM=false docker compose up --build
```

## How enforcement works

Per request:

1. **Estimate** worst-case cost: `prompt_chars / 4` tokens in, `max_tokens`
   (or `DEFAULT_COMPLETION_ESTIMATE`) out, priced from the model table.
2. **Reserve** atomically in Redis (Lua):
   - committed spend ≥ limit → **`402` halt** (kill-switch)
   - spend + in-flight reservations + estimate > limit → **`429` contention**
     (retryable — concurrent requests hold the remaining budget)
   - otherwise the estimate is added to a pending counter
3. **Forward** to the upstream.
4. **Commit**: release the reservation and record the exact metered cost from
   `usage.prompt_tokens` / `usage.completion_tokens`.

Failure behavior is deliberate:

- **Redis down → fail closed (`503`).** If the budget can't be verified, no
  money is spent.
- **Upstream error → reservation released**, OpenAI's own status code is
  surfaced to the caller.
- **Process crash mid-flight** → orphaned reservations expire after 10 minutes
  (`pendingKeyTtlSeconds`); daily spend keys expire after 48 h.

## Test it with curl

```bash
# Budget status for one agent
curl -s localhost:3000/v1/budget/crawler-01 | jq

# Streaming (SSE) — usage arrives in the final chunk and is metered
curl -sN localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" -H "X-Agent-ID: streamer-01" \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"stream"}]}'

# Trip the kill-switch: clamp an agent to $0.0005/day, then call again
curl -s -X PUT localhost:3000/admin/agents/runaway-bot/limit \
  -H "Content-Type: application/json" -d '{"limitUsd":0.0005}'
curl -s localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" -H "X-Agent-ID: runaway-bot" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → 402 {"error":"Budget exceeded. Agent execution halted."}

# Un-trip it
curl -s -X DELETE localhost:3000/admin/agents/runaway-bot/spend | jq
```

## API

### Proxy surface (Bearer `PROXY_API_KEY` if set)

| Method | Path                   | Purpose                                            |
| ------ | ---------------------- | -------------------------------------------------- |
| `POST` | `/v1/chat/completions` | OpenAI-compatible proxy (blocking + streaming).    |
| `GET`  | `/v1/budget/:agentId`  | Agent's spend/limit/status for today.              |

Responses include `X-Budget-Cost-USD`, `X-Budget-Spent-USD`,
`X-Budget-Remaining-USD` headers.

| Status | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| `402`  | Daily budget exceeded — agent halted. Body: `{"error": "Budget exceeded. Agent execution halted."}` |
| `429`  | Remaining budget reserved by concurrent in-flight requests — retry. |
| `503`  | Budget store unreachable — fail closed.                        |

### Admin surface (`X-Admin-Key` if `ADMIN_API_KEY` set)

| Method   | Path                            | Purpose                                  |
| -------- | ------------------------------- | ---------------------------------------- |
| `GET`    | `/admin/agents`                 | Fleet overview (powers the dashboard).   |
| `GET`    | `/admin/agents/:id`             | Single-agent status.                     |
| `PUT`    | `/admin/agents/:id/limit`       | Set `{"limitUsd": 25}` or clear with `null`. |
| `DELETE` | `/admin/agents/:id/spend`       | Reset today's spend (un-trips the switch). |

### Other

| Method | Path         | Purpose                                  |
| ------ | ------------ | ---------------------------------------- |
| `GET`  | `/healthz`   | Liveness (verifies Redis).               |
| `GET`  | `/dashboard` | Live control-room UI.                    |

## Pointing your agent at the proxy

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="unused-or-PROXY_API_KEY",
    default_headers={"X-Agent-ID": "crawler-01"},
)
resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "hello"}],
)
```

A `402` surfaces as an SDK error your agent loop can catch and halt on.

## Configuration

| Variable                      | Default                  | Description                                        |
| ----------------------------- | ------------------------ | -------------------------------------------------- |
| `OPENAI_API_KEY`              | —                        | Required unless `MOCK_UPSTREAM=true`.              |
| `MOCK_UPSTREAM`               | `false`                  | Deterministic local completions, zero spend.       |
| `HARD_DAILY_LIMIT_USD`        | `10.00`                  | Global per-agent daily ceiling (UTC day).          |
| `DEFAULT_COMPLETION_ESTIMATE` | `1024`                   | Reservation estimate when no `max_tokens` given.   |
| `PROXY_API_KEY`               | unset (open)             | Bearer auth for `/v1/*`.                           |
| `ADMIN_API_KEY`               | unset (open)             | `X-Admin-Key` auth for `/admin/*`.                 |
| `REDIS_URL`                   | `redis://127.0.0.1:6379` | Budget store.                                      |
| `PORT`                        | `3000`                   | Listen port.                                       |
| `OPENAI_BASE_URL`             | OpenAI default           | Alternate upstream (Azure, gateway).               |
| `MODEL_PRICING`               | built-in table           | JSON of `{model: {input, output}}` USD per 1k tokens. |

Built-in rates (USD / 1k tokens): `gpt-4o-mini` 0.0015 / 0.002 ·
`gpt-4o` 0.005 / 0.015 · `gpt-4-turbo` 0.01 / 0.03 · fallback = gpt-4o-mini.
Rates drift — verify against OpenAI's current pricing before using for billing.

## Tests

```bash
docker compose up -d redis   # integration tests need Redis (uses DB 15)
npm test
```

20 tests: pricing math (unit) plus full-stack integration — metering,
kill-switch, reservation guard, a 40-request concurrent burst proving the
ceiling holds, streaming metering, admin flows, auth, malformed input.

## Project structure

```
.
├── server.js                 # Entrypoint: assembles config → redis → app
├── src/
│   ├── app.js                # Express wiring, auth layers, error handling
│   ├── config.js             # Env config, frozen at boot
│   ├── pricing.js            # Pure cost math (unit-tested)
│   ├── redis.js              # Client + Lua reserve/commit scripts
│   ├── budget.js             # Budget domain: keys, lifecycle, fleet registry
│   ├── upstream.js           # OpenAI client + deterministic mock
│   ├── errors.js             # OpenAI-style error envelope
│   ├── middleware/auth.js    # Proxy + admin auth
│   └── routes/
│       ├── chat.js           # The proxy: reserve → forward → commit, SSE
│       ├── admin.js          # Fleet, limits, resets
│       └── health.js         # /healthz
├── public/dashboard.html     # Live control-room UI
├── test/                     # node:test suite (unit + integration)
├── Dockerfile                # node:22-alpine, non-root, healthcheck
└── docker-compose.yml        # redis + proxy
```

## License

MIT
