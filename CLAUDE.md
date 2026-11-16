# just-a-chat-bot

Claude-powered Telegram group bot on Railway. Spec: `docs/superpowers/specs/2026-11-15-group-chat-bot-design.md` (binding). README.md covers setup.

## Architecture map
- `app/api/telegram` webhook: verifies the secret, dedupes `update_id`, stores the message, creates `runs` rows, answers 200 at once.
- `app/api/health`, `app/api/miniapp/{session,settings,forget}`, `app/settings` Mini App (Tailwind 4, lucide-react).
- `instrumentation.ts` -> `src/server/startup.ts`: set webhook, deploy-ping, run recovery, sweeper. `src/server/shutdown.ts` drains on SIGTERM (`NEXT_MANUAL_SIG_HANDLE=true`).
- `src/bot/*` dispatch, access control, ingestion, triggers, private chat.
- `src/agent/*` request building, prompts, checkpointed agent loop, per-chat runner with a DB lease.
- `src/bakery/*` bakery REST client, proposals, cards, button callbacks. `src/chime/*` auto-chime scheduler and Haiku classifier.
- `src/conversation/*` history window and media. `src/models/catalog.ts` model list cache.
- `src/miniapp/*` initData auth, JWT, settings service. `src/settings/*` settings schema.
- `src/db/*` drizzle schema, client, repos. `src/i18n/*` en/he/ru catalogs. `src/config/env.ts` zod env loader.
- `.railway/railway.ts` Railway IaC (applied by hand with `railway config apply`).
- `tests/**` mirrors `src/`; helpers in `tests/helpers`.

## Gate
- Before a commit: `npx tsc --noEmit && npx vitest run`.
- Before a push: also `npx next build`.
- Never run `drizzle-kit migrate` locally against prod, and never use `npm run db:migrate` as part of build.

## Conventions
- Relative imports are extensionless (Turbopack cannot map `.js` to `.ts`), or use `@/` (repo root).
- Tests use PGlite with the real migrations (`tests/helpers/db.ts`). Claude, Telegram and the bakery are hand-written fakes. No live services, no env secrets.
- i18n: every user-facing string comes from `src/i18n` (en/he/ru, native wording). Only bakery card text and decision messages pass through verbatim.
- No silent failures: every `catch` calls `log(event, fields)` with `errorText(err)`. No artificial timeouts in app code.
- Times shown are Israel time, 24h, via `Intl.DateTimeFormat`.
- Never store the bakery key (`BAKERY_MCP_KEY`): read it from env at call time, never put it in run snapshots, DB, logs or commits. `errorText` scrubs bot tokens and `bmcp_` keys.
- Migrations: generate with `npm run db:generate`, commit the SQL in `drizzle/`. They are applied by the Railway pre-deploy command (`drizzle-kit migrate`), never by the build.
- Railway deploys do not read `.railway/railway.ts`; changing it needs `railway config plan` then `apply`.
