# AI Firewall — Agent Budget Proxy

**A hard spending limit for AI agents.** AI Firewall is a proxy server that sits
between your AI agents and the OpenAI API. Every request passes through it, gets
metered to the exact dollar, and gets **blocked the moment an agent exceeds its
daily budget**. A bugged agent stuck in an infinite loop can burn *at most* its
daily limit — never your whole account.

```
┌─────────────┐  POST /v1/chat/completions   ┌──────────────┐   forward    ┌─────────┐
│  Your agent │ ───────────────────────────▶ │  AI Firewall │ ───────────▶ │ OpenAI  │
│             │  X-Agent-ID: crawler-01      │              │ ◀─────────── │   API   │
└─────────────┘ ◀──────────────────────────  └──────┬───────┘  token usage └─────────┘
        402 "Budget exceeded" when over limit       │
                                             ┌──────▼───────┐
                                             │    Redis     │  atomic spend ledger
                                             └──────────────┘
```

---

## Table of contents

1. [The problem this solves](#the-problem-this-solves)
2. [How it works](#how-it-works)
3. [Quick start (5 minutes, no OpenAI key needed)](#quick-start-5-minutes-no-openai-key-needed)
4. [Pointing your agents at the firewall](#pointing-your-agents-at-the-firewall)
5. [Going to production](#going-to-production)
6. [The three keys — who holds what](#the-three-keys--who-holds-what)
7. [Full API reference](#full-api-reference)
8. [The dashboard](#the-dashboard)
9. [Configuration reference](#configuration-reference)
10. [Architecture & design decisions](#architecture--design-decisions)
11. [Monitoring & observability](#monitoring--observability)
12. [Testing](#testing)
13. [Troubleshooting](#troubleshooting)
14. [Project structure](#project-structure)

---

## The problem this solves

Autonomous AI agents call LLM APIs in loops. When an agent has a bug — a retry
loop, a planning cycle that never terminates, a prompt that always fails — it
keeps calling the API. **Every call costs real money and nothing stops it.**
Developers have woken up to bills of hundreds or thousands of dollars from a
loop that ran overnight.

OpenAI offers account-level monthly limits, but nothing per-agent, per-day,
that reacts *instantly*. AI Firewall closes that gap:

- Each agent gets a **daily budget in USD** (e.g. $10/day).
- Spend is metered on **every single call** from exact token usage.
- The instant an agent hits its limit, it receives `402 Payment Required` with
  `{"error": "Budget exceeded. Agent execution halted."}` — **the request never
  reaches OpenAI and costs $0**.
- The budget resets at midnight UTC, or you reset it manually from the
  dashboard.

---

## How it works

Every `POST /v1/chat/completions` request goes through this lifecycle:

1. **Identify** — the agent is identified by its `X-Agent-ID` header
   (validated: 1–64 chars, `[A-Za-z0-9._-]`, must start alphanumeric).
2. **Rate check** — a per-agent requests-per-minute brake (default 60/min).
   Exceeding it returns `429 rate_limited`. This stops fast loops of *cheap*
   calls before they matter.
3. **Estimate** — the worst-case cost of the request is estimated:
   `prompt_chars / 4` input tokens + `max_tokens` (or a default of 1024)
   output tokens, priced from the model pricing table.
4. **Reserve (atomic)** — a Redis Lua script atomically checks and reserves
   that estimate against the agent's daily budget. Because this happens
   *inside* Redis as a single operation, **concurrent requests can never
   collectively overshoot the ceiling** — there is no race window.
   - Already at/over the limit → **`402` — the kill-switch**.
   - Estimate doesn't fit in what's left (other requests in flight hold it)
     → `429 budget_contention` (retryable).
5. **Forward** — the request goes to OpenAI with *your* real API key, which
   agents never see.
6. **Commit (atomic)** — the reservation is released and the **exact** metered
   cost (from `usage.prompt_tokens` / `usage.completion_tokens` in OpenAI's
   response) is added to the agent's daily total. If the upstream call failed,
   the reservation is released and nothing is charged.

**Failure design (this matters):**

| Failure | Behaviour |
|---|---|
| Redis unreachable | **Fail closed** — `503`, no request is forwarded. If spend can't be verified, no money is spent. |
| OpenAI errors | Reservation released, OpenAI's own status code and message are passed through to the caller. |
| Process crash mid-request | Orphaned reservations auto-expire after 10 minutes. Daily spend keys expire after 48 h. |
| Client disconnects mid-stream | The upstream OpenAI call is aborted — you stop paying for tokens nobody reads. |

---

## Quick start (5 minutes, no OpenAI key needed)

Requirements: Node.js ≥ 18.17, Docker.

```bash
git clone https://github.com/islas104/AI-Firewall.git
cd AI-Firewall
npm install

# Start Redis
docker compose up -d redis

# Start the proxy in MOCK MODE — completions are fabricated locally,
# budgets/streaming/kill-switch are all real, $0 is spent.
npm run demo
```

Open the dashboard: **http://localhost:3000/dashboard**

Send a request through it:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Agent-ID: my-first-agent" \
  -d '{"model":"gpt-4o-mini","max_tokens":50,"messages":[{"role":"user","content":"hello"}]}'
```

Watch `my-first-agent` appear on the dashboard with its metered spend.

**See the kill-switch fire** (no money involved — mock mode):

```bash
# Clamp the agent to a $0.0001/day budget
curl -s -X PUT localhost:3000/admin/agents/my-first-agent/limit \
  -H "Content-Type: application/json" -d '{"limitUsd":0.0001}'

# Its next request is halted:
curl -s localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" -H "X-Agent-ID: my-first-agent" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → 402 {"error":"Budget exceeded. Agent execution halted."}
```

To run locally against the **real** OpenAI API:

```bash
cp .env.example .env
# edit .env: set OPENAI_API_KEY=sk-... and MOCK_UPSTREAM=false
npm start
```

---

## Pointing your agents at the firewall

The proxy is request/response compatible with OpenAI's Chat Completions API.
Existing code needs exactly **three changes**: the base URL, the API key
(use the *proxy* key, never your `sk-` key), and the `X-Agent-ID` header.

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://YOUR-DEPLOYMENT-URL/v1",     # your firewall, not api.openai.com
    api_key="YOUR_PROXY_API_KEY",                  # the pk_… proxy key, NOT sk-…
    default_headers={"X-Agent-ID": "crawler-01"},  # who is spending
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "hello"}],
)
```

### Node.js (openai SDK)

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://YOUR-DEPLOYMENT-URL/v1',
  apiKey: 'YOUR_PROXY_API_KEY',
  defaultHeaders: { 'X-Agent-ID': 'crawler-01' },
});
```

### curl

```bash
curl https://YOUR-DEPLOYMENT-URL/v1/chat/completions \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Agent-ID: crawler-01" \
  -d '{"model":"gpt-4o-mini","max_tokens":100,"messages":[{"role":"user","content":"hello"}]}'
```

### Handling the kill-switch in your agent loop

When the budget is gone, the SDK raises an error with HTTP status 402. Catch
it and stop:

```python
import openai

try:
    resp = client.chat.completions.create(...)
except openai.APIStatusError as e:
    if e.status_code == 402:
        print("Daily budget exhausted — halting agent.")
        raise SystemExit(0)
    if e.status_code == 429:
        time.sleep(5)   # rate limit or budget contention — retry later
```

Every successful response also carries budget headers you can log:

```
X-Budget-Cost-USD: 0.000038        # what this call cost
X-Budget-Spent-USD: 0.004512       # agent's total today
X-Budget-Remaining-USD: 12.495488  # what's left today
```

---

## Going to production

### Option A — Railway (what this repo is set up for)

The repo includes `railway.json` (Dockerfile build, `/healthz` health check,
restart-on-failure). Steps, in order:

```bash
# 1. Install the CLI and log in (opens your browser)
npm i -g @railway/cli
railway login

# 2. Create the project and the Redis database
railway init --name ai-firewall
railway add --database redis

# 3. Generate strong keys (keep the output somewhere safe)
echo "PROXY_API_KEY=pk_$(openssl rand -hex 24)"
echo "ADMIN_API_KEY=ak_$(openssl rand -hex 24)"

# 4. Create the proxy service with production variables
railway add --service proxy \
  --variables 'REDIS_URL=${{Redis.REDIS_URL}}' \
  --variables 'MOCK_UPSTREAM=true' \
  --variables 'HARD_DAILY_LIMIT_USD=10.00' \
  --variables 'RATE_LIMIT_RPM=60' \
  --variables 'PROXY_API_KEY=<pk_ key from step 3>' \
  --variables 'ADMIN_API_KEY=<ak_ key from step 3>' \
  --variables 'TRUST_PROXY=1' \
  --variables 'ENABLE_HSTS=true'

# 5. Deploy and expose a public URL
railway up --service proxy --detach
railway domain --service proxy

# 6. Verify (mock mode — still $0 spent)
curl https://<your-url>/healthz
# {"status":"ok","redis":"up","upstream":"mock",...}

# 7. Flip to real OpenAI traffic when ready
railway variables --service proxy \
  --set "OPENAI_API_KEY=sk-your-real-key" \
  --set "MOCK_UPSTREAM=false"
railway redeploy --service proxy
```

For auto-deploy on every push: Railway dashboard → your `proxy` service →
Settings → Source → Connect Repo.

### Option B — any Docker host

```bash
OPENAI_API_KEY=sk-... MOCK_UPSTREAM=false \
PROXY_API_KEY=pk_... ADMIN_API_KEY=ak_... \
docker compose up --build -d
```

Put TLS in front (Caddy, nginx, or your platform's load balancer) and set
`TRUST_PROXY=1` and `ENABLE_HSTS=true`.

### Go-live checklist

- [ ] `PROXY_API_KEY` and `ADMIN_API_KEY` set to long random values
- [ ] `MOCK_UPSTREAM=false` and a **dedicated** OpenAI key (one key per
      deployment, named e.g. `ai-firewall-prod`, so it can be revoked alone)
- [ ] OpenAI account funded with **prepaid credits, auto-recharge OFF** — this
      is your absolute ceiling behind the firewall
- [ ] An **account-level usage limit** set in OpenAI billing as backstop
- [ ] TLS in front; `ENABLE_HSTS=true`, `TRUST_PROXY=<hops>`
- [ ] Redis not publicly exposed (compose binds it to loopback) and persistent
      (AOF is enabled in compose)
- [ ] `HARD_DAILY_LIMIT_USD` sized deliberately: total worst-case daily
      exposure = limit × number of agents. **Start low ($2–3) and raise it.**
- [ ] Prometheus scraping `/metrics`; alert on `budget_halts_total` spikes
- [ ] Log shipping for the JSON logs (each request has a correlation id)

---

## The three keys — who holds what

This separation is the core security model. **Agents never touch the real
OpenAI key**, so the only path to spending money goes through the budget check.

| Key | Env var | Format | Who holds it | Purpose |
|---|---|---|---|---|
| OpenAI key | `OPENAI_API_KEY` | `sk-…` | **Only the server** (Railway env / secret manager). Never in git, never in agents. | Pays for the actual API calls upstream. |
| Proxy key | `PROXY_API_KEY` | `pk_…` (any string) | Your agents. | Lets an agent through the firewall. Sent as `Authorization: Bearer pk_…`. |
| Admin key | `ADMIN_API_KEY` | `ak_…` (any string) | Only you. | Dashboard, budget overrides, spend resets, `/metrics`. Sent as `X-Admin-Key: ak_…`. |

If a proxy key leaks: the attacker can spend **at most your daily limits**, and
you rotate one env var. If your raw OpenAI key had leaked instead, they could
drain the account. That asymmetry is the product.

---

## Full API reference

### Proxy surface — auth: `Authorization: Bearer <PROXY_API_KEY>` (when set)

#### `POST /v1/chat/completions`

OpenAI-compatible. Requires the `X-Agent-ID` header. Supports streaming
(`"stream": true`) — SSE chunks pass through in real time and usage is metered
from the final chunk (`stream_options.include_usage` is forced server-side).

Success responses include:

| Header | Meaning |
|---|---|
| `X-Budget-Cost-USD` | Exact cost of this call |
| `X-Budget-Spent-USD` | Agent's committed spend today |
| `X-Budget-Remaining-USD` | Budget left today |

Error responses:

| Status | `error.type` | Meaning | What your agent should do |
|---|---|---|---|
| `402` | — (fixed body: `{"error": "Budget exceeded. Agent execution halted."}`) | Daily budget exhausted. **Terminal for the day.** | Stop. Retrying is pointless until UTC midnight or an admin reset. |
| `429` | `rate_limited` | Too many requests/minute for this agent. | Back off; see `Retry-After`. |
| `429` | `budget_contention` | Budget remains, but concurrent in-flight requests have reserved it. | Retry in a few seconds. |
| `400` | `missing_agent_id` / `invalid_agent_id` / `invalid_request` / `invalid_json` | Malformed request. | Fix the request. |
| `401` | `unauthorized` | Missing/wrong proxy key. | Fix credentials. |
| `413` | `payload_too_large` | Body over 2 MB. | Shrink the payload. |
| `502`/passthrough | `upstream_error` | OpenAI itself failed; original status and message preserved. | Handle as you would a direct OpenAI error. |
| `503` | `store_unavailable` | Redis down — fail-closed, nothing forwarded. | Retry with backoff; page whoever runs the proxy. |

#### `GET /v1/budget/:agentId`

Current budget status for one agent:

```json
{
  "agentId": "crawler-01",
  "day": "2026-07-02",
  "spentUsd": 0.004512,
  "pendingUsd": 0.0021,
  "limitUsd": 12.5,
  "remainingUsd": 12.495488,
  "exceeded": false,
  "customLimit": false
}
```

`pendingUsd` is money reserved by requests currently in flight.

### Admin surface — auth: `X-Admin-Key: <ADMIN_API_KEY>` (when set)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin/agents` | Fleet overview: every agent seen today with spend/limit/status. |
| `GET` | `/admin/agents/:id` | One agent's status. |
| `PUT` | `/admin/agents/:id/limit` | Set a per-agent daily limit: body `{"limitUsd": 25}`. Clear the override with `{"limitUsd": null}` (falls back to the global limit). Overrides persist across days. |
| `DELETE` | `/admin/agents/:id/spend` | Reset today's spend to $0 — un-trips the kill-switch immediately. |
| `GET` | `/metrics` | Prometheus metrics. |

### Public

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness — verifies Redis, reports upstream mode and global limit. |
| `GET` | `/dashboard` | The live control-room UI. |

---

## The dashboard

`/dashboard` is a zero-dependency live control room (auto-refreshes every 2 s).
If an admin key is configured it prompts once and remembers it in
`localStorage`.

For each agent seen today: status pill (**ACTIVE** / **NEAR LIMIT** at >80% /
**HALTED**), spent today, a budget bar, its limit (`*` marks a per-agent
override), in-flight reservations, and two actions:

- **limit** — set or clear a per-agent daily limit
- **reset** — wipe today's spend (un-trips the kill-switch)

---

## Configuration reference

All configuration is environment variables, read once at boot and validated
(bad config = the process refuses to start).

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | **Required** unless `MOCK_UPSTREAM=true`. The real upstream key. |
| `MOCK_UPSTREAM` | `false` | `true` = fabricate completions locally. Real budgets, streaming, kill-switch; zero spend. For demos/CI. |
| `HARD_DAILY_LIMIT_USD` | `10` | Global per-agent daily ceiling (UTC calendar day). |
| `RATE_LIMIT_RPM` | `60` | Requests/minute per agent. `0` disables. |
| `PROXY_API_KEY` | unset = open | Bearer key required on `/v1/*` when set. **Set it in production.** |
| `ADMIN_API_KEY` | unset = open | Key required on `/admin/*` and `/metrics` when set. **Set it in production.** |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Budget store. Supports `redis://user:pass@host:port`. |
| `PORT` | `3000` | Listen port. |
| `OPENAI_BASE_URL` | OpenAI default | Alternate upstream (Azure OpenAI, another gateway). |
| `UPSTREAM_TIMEOUT_MS` | `60000` | Timeout per OpenAI request. |
| `UPSTREAM_MAX_RETRIES` | `1` | OpenAI SDK retry count. |
| `MODEL_PRICING` | built-in table | JSON overriding prices: `{"gpt-4o-mini":{"input":0.0015,"output":0.002}}` — USD per 1,000 tokens. |
| `DEFAULT_COMPLETION_ESTIMATE` | `1024` | Output-token estimate used for reservation when a request has no `max_tokens`. |
| `LOG_LEVEL` | `info` | pino level: `debug`, `info`, `warn`, `error`, `silent`. |
| `TRUST_PROXY` | `0` | Number of trusted reverse-proxy hops (set `1` on Railway/behind one LB). |
| `ENABLE_HSTS` | `false` | Send HSTS header. Only enable behind TLS. |

**Pricing note:** built-in rates are the project's baseline spec values and are
deliberately conservative for gpt-4o-mini (the meter over-counts, so agents
halt *early*, never late). If you want metered numbers to match your OpenAI
invoice exactly, set `MODEL_PRICING` to the current official rates.

---

## Architecture & design decisions

- **Atomicity via Redis Lua.** The check-and-reserve runs as one script inside
  Redis. Two requests arriving in the same millisecond cannot both pass a
  nearly-exhausted budget — one reserves, the other is deferred. The test
  suite proves this with a 40-request concurrent burst asserting committed
  spend never crosses the ceiling.
- **Reserve worst case, commit actual.** Reservations use a pessimistic
  estimate; commits use OpenAI's reported usage. Failed calls release the
  reservation in full.
- **Fail closed on the money path, fail open on the convenience path.** Redis
  down → requests are refused (503) because spend can't be verified. The
  *rate limiter* failing, by contrast, lets traffic through — the budget check
  right behind it is the enforcement layer that matters.
- **Streaming is metered, not blocked.** `stream_options.include_usage` is
  forced upstream so the final SSE chunk carries token counts. If a stream
  dies before that chunk, the agent is charged a conservative estimate from
  the characters actually streamed.
- **Keys layout in Redis:**
  ```
  agent:budget:spent:{agentId}:{YYYY-MM-DD}    committed spend   (TTL 48h)
  agent:budget:pending:{agentId}:{YYYY-MM-DD}  in-flight reserve (TTL 10m)
  agent:budget:limit:{agentId}                 per-agent override (persistent)
  agent:budget:agents:{YYYY-MM-DD}             agents seen today (TTL 48h)
  agent:ratelimit:{agentId}:{epochMinute}      rate-limit window (TTL 120s)
  ```
- **Security:** strict CSP (no inline script anywhere, including the
  dashboard), full security-header set, constant-time key comparison,
  agent-ID validation (blocks Redis key injection), auth headers redacted
  from logs, non-root container.

---

## Monitoring & observability

**Logs** — structured JSON (pino) on stdout. Every request has a UUID
(`req.id`) correlating all its log lines. `Authorization` and `X-Admin-Key`
headers are redacted before writing.

**Metrics** — Prometheus at `/metrics` (behind the admin key):

| Metric | Meaning |
|---|---|
| `http_requests_total{method,route,status}` | Traffic by route/status |
| `http_request_duration_seconds` | Latency histogram |
| `agent_spend_usd_total` | Total metered spend |
| `budget_halts_total` | Kill-switch activations (**alert on spikes**) |
| `budget_contention_total` | 429s from reservation contention |
| `rate_limited_total` | 429s from the rate limiter |
| `upstream_errors_total` | Failed OpenAI calls |

Scrape config needs the header: `Authorization` is unused; set
`X-Admin-Key` via Prometheus `http_headers` / your agent's custom headers.

---

## Testing

```bash
docker compose up -d redis   # integration tests need Redis (they use DBs 14/15)
npm test
```

27 tests across three suites:

- **Unit** — pricing math, estimation, config merging.
- **Integration** — real Express + real Redis + mock upstream: metering,
  kill-switch exact body, reservation guard, **a 40-request concurrent burst
  proving the ceiling holds**, streaming metering, admin flows, auth, malformed
  input.
- **Production hardening** — security headers, agent-ID validation, per-agent
  rate limiting, metrics auth, oversized bodies.

CI (GitHub Actions) runs the suite against a Redis service container, then
builds the Docker image and smoke-tests a real container end-to-end.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `429` with OpenAI's *"You exceeded your current quota"* message | Your **OpenAI account** has no API credits (API billing is separate from ChatGPT Plus). | Add prepaid credits at platform.openai.com → Billing. No redeploy needed. |
| `402` on every request from one agent | That agent hit its daily budget — the firewall is doing its job. | Wait for UTC midnight, `DELETE /admin/agents/:id/spend`, or raise its limit. |
| `503 store_unavailable` | Redis is down/unreachable. | Check `REDIS_URL`, Redis health. The proxy deliberately refuses to spend unverifiable money. |
| `401` on `/v1/*` | Missing/wrong `Authorization: Bearer <PROXY_API_KEY>`. | Send the `pk_` key — not the `sk-` OpenAI key. |
| Dashboard stuck on "Failed to reach proxy: unauthorized" | Wrong admin key cached. | DevTools → `localStorage.removeItem('adminKey')` → reload. |
| Spend looks ~10× your OpenAI bill | Conservative built-in pricing (see Configuration). | Set `MODEL_PRICING` to current official rates. |
| Health shows `"upstream":"mock"` in production | `MOCK_UPSTREAM` still `true`. | Set it `false` and redeploy. |

---

## Project structure

```
.
├── server.js                 # Entrypoint: config → redis → app; graceful shutdown
├── src/
│   ├── app.js                # Express wiring, middleware order, error handling
│   ├── config.js             # Env config, frozen + validated at boot
│   ├── pricing.js            # Pure cost math (unit-tested)
│   ├── redis.js              # Client + Lua reserve/commit scripts, backoff
│   ├── budget.js             # Budget domain: keys, lifecycle, fleet registry
│   ├── upstream.js           # OpenAI client (timeout/retries) + deterministic mock
│   ├── logger.js             # pino structured logs, request IDs, redaction
│   ├── metrics.js            # Prometheus registry + timing middleware
│   ├── errors.js             # OpenAI-style error envelope
│   ├── middleware/
│   │   ├── auth.js           # Proxy + admin auth (constant-time)
│   │   ├── security.js       # CSP + security headers
│   │   └── rateLimit.js      # Per-agent requests/minute (Redis)
│   └── routes/
│       ├── chat.js           # The proxy: reserve → forward → commit, SSE
│       ├── admin.js          # Fleet, limits, resets
│       └── health.js         # /healthz
├── public/                   # Dashboard (CSP-safe external JS)
├── test/                     # node:test — unit, integration, prod hardening
├── .github/workflows/ci.yml  # Tests vs Redis service + Docker smoke test
├── Dockerfile                # node:22-alpine, non-root, healthcheck
├── docker-compose.yml        # redis (loopback-only) + proxy
└── railway.json              # Railway build/deploy config
```

## License

MIT
