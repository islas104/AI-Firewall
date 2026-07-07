# Security Policy

## Reporting a vulnerability

Email **islas104@gmail.com** or open a [private security advisory](https://github.com/islas104/AI-Firewall/security/advisories/new).
Please do not open a public issue for undisclosed vulnerabilities. Expect an
initial response within a few days.

## Threat model

AI Firewall exists to enforce one property: **an agent can never spend more than
its configured budget, and the fleet can never exceed the global cap.** The
security posture is organized around protecting that property and the surfaces
around it.

| Attack | Defense | Worst-case damage |
|---|---|---|
| Leaked proxy key, one agent | Per-agent daily budget | `HARD_DAILY_LIMIT_USD`/day |
| Leaked proxy key + rotating agent IDs | Fleet-wide `TOTAL_DAILY_LIMIT_USD`, atomic in the same Lua script; optional `AGENT_ALLOWLIST` | `TOTAL_DAILY_LIMIT_USD`/day |
| Request flooding (authed or anon) | Per-agent RPM + per-IP RPM (applied before auth) + 2 MB body cap | Throttled at the edge |
| Key brute-forcing | 48-hex-char keys, `timingSafeEqual`, per-IP+surface failed-auth lockout | Impractical |
| Redis key injection via `X-Agent-ID` / route params | Strict id regex + reserved-id (`__global__`) rejection on every surface | 400 |
| Prototype-collision via `model` | `Object.hasOwn` pricing lookup + model validation | 400 |
| Unpriced/expensive model billed as cheap | `REJECT_UNKNOWN_MODELS` (fail closed on unpriced models) | 400 |
| Ledger poisoning (negative/huge `max_tokens`) | Boundary validation + `MAX_TOKENS_CEILING` + non-negative clamps in both Lua scripts | 400 |
| Reservation-parking DoS | `MAX_TOKENS_CEILING` bounds a single reservation | Bounded |
| XSS on the dashboard | Strict CSP (no inline script), all output HTML-escaped | Blocked |
| Race conditions on the budget | Reserve/commit inside single atomic Lua scripts | Cannot overshoot |
| Redis outage | Fail closed (`503`, nothing forwarded) | $0 spent while blind |
| Rogue/compromised admin | Structured audit log of every state-changing action | Attributable |
| Info disclosure | Generic errors, upstream-error sanitization, minimal `/healthz`, no stack traces, log redaction | Minimal |

Behind all of it, run OpenAI **prepaid credits with auto-recharge off** — an
absolute account-level ceiling the proxy cannot exceed even if a layer fails.

## Penetration test (2026-07)

The codebase was subjected to a structured penetration test — five independent
reviewers covering budget bypass, auth/access control, injection, infrastructure,
and denial of service — combining white-box code review with live black-box
probing of the production deployment.

### Findings and remediations

| Sev | Finding | Fix | Regression test |
|---|---|---|---|
| CRITICAL | Negative `max_tokens` poisoned the Redis pending ledger (`COMMIT_LUA` built a doubly-signed literal that aborted the script mid-write), eroding the concurrency guard on the agent and fleet ledgers | Reject non-positive/huge `max_tokens`; both Lua scripts clamp non-negative and use numeric negation | `test/pentest.test.js` FIX #1, #1b |
| CRITICAL | Unknown models billed at the cheap `DEFAULT` tier while OpenAI charged real rates → real spend past the ceiling, unrecorded | `REJECT_UNKNOWN_MODELS` fails closed on unpriced models | `test/pentest.test.js` FIX #2 |
| HIGH | `model:"constructor"` resolved to an `Object.prototype` member → NaN cost → Lua crash → free repeatable 503 | `Object.hasOwn` lookup + model validation | `test/pentest.test.js` FIX #2b |
| HIGH | Reservation-parking: huge `max_tokens` reserved the whole global cap → fleet lockout at zero cost | `MAX_TOKENS_CEILING` | `test/pentest.test.js` FIX #3 |
| HIGH | `messages:[null]` threw before the try/catch → unhandled rejection, no response, leaked socket | Validate every message element is a non-null object | `test/pentest.test.js` FIX #4 |
| HIGH | `__global__` ledger reachable via `/v1/budget/:id` and admin routes | `isValidAgentId` guard on all `:agentId` routes | `test/pentest.test.js` FIX #5 |
| MEDIUM | Redis SET bloat: rejected reservations registered the agent | `SADD` only on successful reservation | `test/pentest.test.js` FIX #6 |
| MEDIUM | Body parsed before rate limiting | Per-IP limiter moved ahead of `express.json` | — |
| MEDIUM | Upstream 401/403 echoed a partially-masked key | Generic message + `sk-` redaction | — |
| MEDIUM | Auth-fail lockout counter shared across surfaces | Surface-scoped counter | `test/security.test.js` |
| MEDIUM | Stream abort-before-usage under-metered | Charge `max(estimate, streamed)` | — |
| LOW | `/healthz` disclosed limits/upstream; rate-limit headers leaked on 401; base images unpinned; HSTS missing `preload` | Minimal `/healthz`; headers suppressed on the pre-auth limiter; digest-pinned images; HSTS `preload` | `test/history.test.js` |

Assessed clean (no exploit): SSRF/upstream override, prototype pollution via JSON
body, `X-Agent-ID` injection, dashboard XSS, `X-Forwarded-For` rate-limit spoofing
(with `TRUST_PROXY` set correctly), and ReDoS.

## Production security checklist

- [ ] `PROXY_API_KEY` and `ADMIN_API_KEY` set to long random values
- [ ] `TOTAL_DAILY_LIMIT_USD` sized to your acceptable worst-case daily loss
- [ ] OpenAI prepaid credits, auto-recharge **off**, account usage limit set
- [ ] `TRUST_PROXY` set to the real hop count (so `req.ip` is the client, not the LB)
- [ ] TLS in front; `ENABLE_HSTS=true`
- [ ] Redis not publicly exposed; authenticated/TLS if remote
- [ ] `/metrics` scraped with the admin key; alerts on `budget_halts_total`, `global_budget_halts_total`, `auth_failures_total`
- [ ] `AGENT_ALLOWLIST` set if agent identities are known in advance
