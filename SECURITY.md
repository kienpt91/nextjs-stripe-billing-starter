# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

- Use GitHub's private vulnerability reporting: the **Report a vulnerability** button under this repository's **Security** tab.
- Or email kienphan.dev@gmail.com.

Include what you found, how to reproduce it, and the affected version or commit. You will get an answer as soon as I can give one; this is a small personal project, so there is no formal response-time commitment.

## Scope and deployment notes

This repository is a starter. Things that matter when you build on it:

- **Demo authentication must never be used in production.** `ALLOW_DEMO_AUTH=true` makes the server trust an `x-demo-user-id` request header, so anyone can act as any user. `.env.example` ships it as `false`, `loadConfig` refuses it when `NODE_ENV=production`, and the server logs a `demo_auth_enabled` warning at startup when it is on. Wire a real `AuthResolver` (see the README, "Authentication") before exposing the app.
- The webhook endpoint verifies Stripe's signature on the raw body, accepts at most 1 MiB, and records event ids so redeliveries are applied once.
- The duplicate-subscription guard in `POST /api/checkout` is best effort, not a guarantee; the README describes exactly what it covers.
- The SQLite store is single-node. There is no retention job for processed event ids.

## Dependency policy

- Every dependency is pinned to an exact version, and no package version in `package-lock.json` (direct or transitive) was published less than 7 days before the date it was locked (current cutoff: 2026-10-23). Locking is done with `npm install --before=<cutoff date>`; Dependabot is configured with a 7-day `cooldown` for the same reason.
- Installs, tests, type checks and builds run in a throwaway container, never directly on a developer machine, and installs use `--ignore-scripts` (`npm ci --ignore-scripts` in CI), so package install scripts never run. No dependency needs an install script here (`fsevents` is an optional macOS file-watcher with a script that is not required).
- GitHub Actions in `.github/workflows` are pinned to full commit SHAs of releases that are also older than the cutoff, and the workflow token is read-only (`permissions: contents: read`).

## Open advisories

Status as of 2026-10-30: `npm audit` and `npm audit --omit=dev` report 0 vulnerabilities for the locked tree (`next@16.4.2`, `vitest@5.0.5`, `vite@8.3.5`, `source-map-js@1.2.2`). The advisories previously listed here (Next.js 16.3.7 image optimization, `use cache`, Server Actions, SSG/ISR cache poisoning, Draft Mode; `source-map-js` 1.2.1; `@vitest/mocker` and `vite` dev-server issues) are fixed by the versions now locked. There are no open advisories.
