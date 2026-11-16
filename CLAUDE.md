# just-a-chat-bot

Claude-powered Telegram group bot on Railway. Spec: `docs/superpowers/specs/2026-11-15-group-chat-bot-design.md` (binding). README.md covers setup.

## Architecture map
- `app/api/telegram` webhook: verifies the secret, handles the update (stores the message, creates `runs` rows), and only then marks its `update_id` seen. Handling is idempotent: a message row is stored once, and a user trigger (mention, reply, first trigger-emoji reaction per message) has at most one run (partial unique index on `runs (chat_id, trigger->>'type', trigger->>'messageId')`, chime excluded, `ON CONFLICT DO NOTHING`). A failed handle answers 500 and stays unmarked, so Telegram's redelivery is handled again; a failed mark after a good handle is logged and still answers 200. Shutdown waits for in-flight handlers.
- `app/api/health`, `app/api/miniapp/{session,settings,forget}`, `app/settings` Mini App (Tailwind 4, lucide-react).
- `instrumentation.ts` -> `src/server/startup.ts`: set webhook, deploy-ping, run recovery, sweeper. `src/server/shutdown.ts` drains on SIGTERM (`NEXT_MANUAL_SIG_HANDLE=true`).
- `src/bot/*` dispatch, access control, ingestion, triggers, private chat.
- `src/agent/*` request building, prompts, checkpointed agent loop, per-chat runner with a DB lease. Run attempts are counted atomically at claim time (`claimNextRun`), so a run that crashes its process still runs out; a claim past 3 fails the run with the apology, and `onError` only picks fail vs backoff. Answer parts are checkpointed one by one (`sent.answerIds`, `sent.partsSent`), so a retry sends only the parts not yet delivered.
- `src/bakery/*` bakery REST client, proposals, cards, button callbacks. `src/chime/*` auto-chime scheduler and Haiku classifier.
- `src/conversation/*` history window and media. `src/models/catalog.ts` model list cache.
- `src/miniapp/*` initData auth, JWT, settings service. `src/settings/*` settings schema.
- `src/db/*` drizzle schema, client, repos. `src/i18n/*` en/he/ru catalogs. `src/config/env.ts` zod env loader.
- `.railway/railway.ts` Railway IaC (applied by hand with `railway config apply`). It is a named partial (`export const partial = "just-a-chat-bot"`): the Railway project also runs the owner's other app, and a whole-project file would delete every resource it omits. The project name comes from the linked project (`ctx.projectName`).
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

## Unverified connector behaviour
Confirm both on the first live bakery test; until then they are assumptions.
- **How a bakery 401 or outage surfaces** is not documented. The code handles a 400 whose message mentions MCP by dropping the bakery for the rest of the run and posting `bakeryUnavailableNotice` after the answer (log `run.bakery_dropped`). A tool-level failure that comes back as an `mcp_tool_result` with `is_error: true` goes to Claude as is, with no notice; each one is logged as `run.bakery_tool_error` with its scrubbed text (also `run.step` -> `mcp_tools[].error`).
- **Whether MCP and server-side fallback combine** (`mcp-client-2026-09-15` with `server-side-fallback-2026-07-01` and `fallbacks: "default"`) is assumed from the fallback doc. If they don't, every bakery run gets a 400: look for `run.error` with `status: 400` on bakery runs, or `run.bakery_dropped` on every bakery run.
