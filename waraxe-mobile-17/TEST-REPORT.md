# WarAxe Mobile 17.0 — build/test report

Date: 2026-11-08

## Passed
- TypeScript/TSX syntax transpilation: `src/App.tsx`, `src/main.tsx`, `server/src/index.ts` — no syntax diagnostics.
- No remaining literal escaped-newline artifacts in those source files.
- Presence checks for the v16/v17 Prisma models and major raid/leaderboard/world PvP API routes.
- Static guard check for one-time raid reward claim (`updateMany` with `claimed: false` and count check).
- Fixed malformed source newline escapes and an unbalanced Prisma query object in `/api/alliances`.
- Fixed raid reward claim to verify the claimant still belongs to the contributing clan and prevent duplicate concurrent claims.

## Blocked / not run
- `npm install` could not complete: network DNS failure reaching `registry.npmjs.org` (`EAI_AGAIN`).
- Client `npm run build` blocked because React, Vite, and related dependencies are not installed.
- Server `npm run server:build` blocked because `@types/node` and other dependencies are not installed.
- Prisma schema validation/client generation and database migrations were not run because Prisma CLI/client are not installed.
- No live API, PostgreSQL integration, browser, multiplayer, concurrency, or load tests were run.

## Conclusion
This is a successful static syntax/smoke check, **not** a full production build or full integration test. Install dependencies and run the commands in README on a machine with npm registry access and PostgreSQL/Docker before deployment.
