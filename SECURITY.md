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

- Every dependency is pinned to an exact version, and no package version in `package-lock.json` (direct or transitive) was published less than 30 days before the date it was locked. Locking is done with `npm install --before=<cutoff date>`; Dependabot is configured with a 30-day `cooldown` for the same reason.
- GitHub Actions in `.github/workflows` are pinned to full commit SHAs of releases that are also older than the cutoff, and the workflow token is read-only (`permissions: contents: read`).

## Open advisories

Status as of 2026-10-30 from `npm audit` (full and `--omit=dev`). The fixed versions of the packages below were published after the dependency cutoff of 2026-09-30, so they are deliberately **not** taken yet. Each entry says whether this repository is reachable. Re-check when the fixed versions are older than 30 days; the Dependabot configuration will propose them.

### Production dependency: `next@16.3.7` (fixed in 16.3.8 and later, published 2026-09-30 or later)

`npm audit --omit=dev` reports `next` as critical. Reachability for this repository, which has one App Router page, four route handlers, no `next/image`, no images configuration, no Server Actions and no Cache Components:

| Advisory | Condition for impact | Reachable here? |
| --- | --- | --- |
| [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw) (critical, RCE in Image Optimization) | A vulnerable `sharp` used by Next.js's image optimizer. The advisory's workaround is `sharp` >= 0.35.5. | Mitigated per the advisory's workaround: the lockfile resolves `sharp@0.35.5`. The app also uses no images. |
| [GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr) (critical, RCE in `use cache`) | A `use cache` function (Cache Components) returning typed arrays. | No. No `use cache` and no `cacheComponents` in the code or in `next.config.ts`. |
| [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r) (high, DoS) | At least one Server Action in an App Router app. | No. No Server Actions. |
| [GHSA-cjq9-62q9-8jv4](https://github.com/advisories/GHSA-cjq9-62q9-8jv4) (high, SSRF in Image Optimization) | `images.remotePatterns` configured with an untrusted host. | No. No `images` configuration. |
| [GHSA-3w37-wq28-93x7](https://github.com/advisories/GHSA-3w37-wq28-93x7), [GHSA-h694-7cp9-m8p3](https://github.com/advisories/GHSA-h694-7cp9-m8p3) (medium, `use cache` leaks) | Cache Components enabled. | No. |
| [GHSA-4jqv-mc3x-m676](https://github.com/advisories/GHSA-4jqv-mc3x-m676), [GHSA-mcj8-r9mp-w47p](https://github.com/advisories/GHSA-mcj8-r9mp-w47p) (medium, SSG/ISR cache poisoning) | Pages Router SSG/ISR pages, or a root catch-all page together with SSG/ISR routes. | No. No Pages Router, no catch-all route, no ISR. |
| [GHSA-f87g-xv8r-7p7x](https://github.com/advisories/GHSA-f87g-xv8r-7p7x) (medium, metadata image routes) | Metadata image routes such as `opengraph-image` on dynamic segments. | No. None exist. |
| [GHSA-39w2-rjm5-chcv](https://github.com/advisories/GHSA-39w2-rjm5-chcv) (low, dev-server MCP endpoint) | Running `next dev` while visiting a malicious website. | Development only; production does not serve the endpoint. Do not browse untrusted sites while `npm run dev` is running. |

Because the exposure depends on features this repository does not use, adding any of them (images, Server Actions, `use cache`, ISR) means upgrading Next.js first.

### Production dependency (build time): `source-map-js@1.2.1` (fixed in 1.2.2, published 2026-09-30)

[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) (high): event-loop denial of service from an attacker-supplied indexed source map. It is a transitive dependency of `postcss`, which both Next.js and Vite use. The code path needs an attacker to supply a source map to the process that parses it; this app does not parse user-supplied source maps at runtime. Not reachable.

### Development-only dependencies: `vitest@5.0.2` (and `@vitest/mocker`) and `vite@8.3.1`

These are used only by `npm test` (`vitest run`). They are not installed in a production image that uses `npm ci --omit=dev`, and they never serve traffic.

| Advisory | Condition | Reachable here? |
| --- | --- | --- |
| [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp) (`@vitest/mocker`, medium; fixed in 5.0.3, published 2026-09-30) | A client that can reach a Vite dev server WebSocket with the mocker interceptor. | Only while a Vite dev server is reachable. This repository's scripts run `vitest run` and start no `vite` dev server, Vitest UI or browser mode. |
| [GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw), [GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22), [GHSA-vfpm-58rq-9qcg](https://github.com/advisories/GHSA-vfpm-58rq-9qcg) (`vite`, low/medium) | A Vite dev server, exposed to the network for two of them. | No Vite dev server is started or exposed by this repository's scripts. |
| [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv), [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw), [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) (`launch-editor` via `vite`, medium/high) | Opening files in an editor from a dev server; two of the three also require Windows. | No dev server, no "open in editor" flow. |

Alternatives were tried: `vitest@4.1.11` with `vite@8.2.2` (both inside the cutoff) is flagged by the same advisories, so no combination that satisfies the cutoff avoids them.
