# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses date-based
releases rather than semver tags.

## [Unreleased]

### Added
- **Spend history & export** — committed spend now persists beyond the 48h
  daily-key TTL (`HISTORY_RETENTION_DAYS`, default 90). New admin endpoints
  `GET /admin/history` (JSON) and `GET /admin/history.csv` (spreadsheet export).
- **Observability assets** — Prometheus alert rules (`ops/prometheus/alerts.yml`),
  a scrape-config example, and a Grafana dashboard (`ops/grafana/dashboard.json`).
- **Lint gate** — ESLint + Prettier with a CI job; `npm run lint` / `format`.
- `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `LICENSE`.
- New metrics: `global_budget_halts_total`, `auth_failures_total`.

### Security
Penetration test (5 reviewers, white-box + live) findings fixed — see
`SECURITY.md` for the full table:
- **CRITICAL** negative `max_tokens` ledger poisoning — boundary validation +
  non-negative clamps in both Lua scripts.
- **CRITICAL** unknown models billed at the cheap DEFAULT tier — `REJECT_UNKNOWN_MODELS`
  fails closed.
- **HIGH** prototype-collision `model` 503 — `Object.hasOwn` lookup.
- **HIGH** reservation-parking fleet lockout — `MAX_TOKENS_CEILING`.
- **HIGH** `messages:[null]` silent connection leak — message-element validation.
- **HIGH** `__global__` ledger reachable via routes — `isValidAgentId` guards.
- **MEDIUM/LOW** Redis SET bloat, pre-parse rate limiting, upstream-error
  sanitization, surface-scoped auth lockout, conservative stream metering,
  minimal `/healthz`, digest-pinned images, HSTS `preload`.
- Conservative cost estimate (`chars/3` + image token floors); default
  completion estimate raised to 4096.

### Added (fleet controls, earlier in this line)
- Fleet-wide daily cap (`TOTAL_DAILY_LIMIT_USD`) closing the agent-ID rotation
  loophole, agent allowlist, per-IP rate limiting, failed-auth lockout.

## [2.0.0]

- Modular rewrite (single file → `src/`), atomic Redis Lua reserve/commit,
  SSE streaming with usage metering, mock upstream mode, admin API, live
  dashboard, Prometheus metrics, structured logging, Docker/Compose, CI.

## [1.0.0]

- Initial single-file proxy: per-agent daily budget, 402 kill-switch,
  token-usage metering, Redis daily counters.
