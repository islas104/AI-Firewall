# Contributing to AI Firewall

Thanks for your interest. This is a focused project — a budget-enforcing proxy —
so contributions that keep it small, correct, and well-tested are the most
welcome.

## Development setup

```bash
git clone https://github.com/islas104/AI-Firewall.git
cd AI-Firewall
npm install
docker compose up -d redis        # tests need Redis (uses DBs 11-15)
npm test
```

Run the proxy locally with zero OpenAI spend:

```bash
npm run demo                       # MOCK_UPSTREAM=true
# dashboard: http://localhost:3000/dashboard
```

## Before you open a PR

All of these run in CI and must pass:

```bash
npm run lint          # ESLint
npm run format:check  # Prettier
npm test              # node:test suite (needs Redis)
```

Auto-fix formatting with `npm run format`.

## Guidelines

- **Keep the money-path paranoid.** Anything touching cost estimation, the Lua
  reserve/commit scripts, or budget keys must clamp/validate untrusted input and
  ship with a regression test. See `test/pentest.test.js` for the style.
- **Fail closed on the budget, fail open on convenience.** If Redis is
  unreachable, refuse to spend (503). A rate-limiter blip may pass traffic
  through — the budget check behind it is the enforcement layer.
- **Small, cohesive modules.** Match the existing structure in `src/`.
- **No secrets in code, tests, or fixtures.** Use env vars.
- **Security-relevant changes** should update `SECURITY.md`'s threat model.

## Commit messages

Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`,
`perf:`, `ci:`, `security:`.

## Reporting security issues

See [SECURITY.md](SECURITY.md) — please do not open public issues for
undisclosed vulnerabilities.
