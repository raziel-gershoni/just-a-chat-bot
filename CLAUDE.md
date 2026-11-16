# just-a-chat-bot

Claude-powered Telegram group bot on Railway. Spec: `docs/superpowers/specs/2026-11-15-group-chat-bot-design.md` (binding). README.md covers setup.

## Architecture map
- `app/api/telegram` webhook: verifies the secret, handles the update (stores the message, creates `runs` rows), and only then marks its `update_id` seen. Handling is idempotent: a message row is stored once, and a user trigger (mention, reply, first trigger-emoji reaction per message) has at most one run (partial unique index on `runs (chat_id, trigger->>'type', trigger->>'messageId')`, chime excluded, `ON CONFLICT DO NOTHING`). A failed handle answers 500 and stays unmarked, so Telegram's redelivery is handled again; a failed mark after a good handle is logged and still answers 200. Shutdown waits for in-flight handlers.
- `app/api/health`, `app/api/miniapp/{session,settings,forget}`, `app/settings` Mini App (Tailwind 4, lucide-react), also served at `/`. It is the bot's Main App (BotFather URL = the domain); the group's settings button links to `t.me/<bot>?startapp=<group token>`, no named direct link.
- `instrumentation.ts` -> `src/server/startup.ts`: set webhook, deploy-ping, run recovery, sweeper. `src/server/shutdown.ts` drains on SIGTERM (`NEXT_MANUAL_SIG_HANDLE=true`).
- `src/bot/*` dispatch, access control, ingestion, triggers, private chat. Topics: a message's thread is stored only when `is_topic_message` (General and non-forum reply threads are null); the history window and the chime classifier read one thread, while chime debounce and cooldown stay per chat.
- Basic group -> supergroup (switching topics on changes the chat id): `migrateChat` (on `migrate_to_chat_id`; `migrate_from` is ignored) moves the group, its messages and its runs, negating the message ids (in runs too), because the supergroup numbers messages from 1. A held lease passes to a placeholder owner, so a process still working on a moved run stops at its next checkpoint (LeaseLost) and the run resumes under the new id once that lease runs out. A group row created for the new id first (an update from the new chat won the race) is replaced, its token kept as `groups.alt_token` so its settings link still works; only the row it read is deleted, so a later one fails the rename and Telegram's redelivery handles it. Logged as `bot.chat_migrated`. `send.ts` never replies to an id below 1. A run whose send fails with `migrate_to_chat_id` releases its lease (`run.chat_migrated`) and finishes in the new chat.
- `src/agent/*` request building, prompts, checkpointed agent loop, per-chat runner with a DB lease. Run attempts are counted atomically at claim time (`claimNextRun`), so a run that crashes its process still runs out; a claim past 3 fails the run with the apology, and `onError` only picks fail vs backoff. Answer parts are checkpointed one by one (`sent.answerIds`, `sent.partsSent`), so a retry sends only the parts not yet delivered. A reply-to-bot run is first judged by Haiku (`src/agent/reply-judge.ts`: the thread up to the reply, the replied-to bot message, the bot's names; logs `run.reply_judged` / `run.reply_skipped` / `run.reply_judge_failed`); one meant for someone else ends silently, a failed judge answers, and a verdict to answer is saved in `sent.replyJudged` so a retry doesn't judge again. The loop, not the runner, starts the typing indicator (`LoopDeps.startTyping`): never for chime, after the judge for a reply. Small JSON decisions from Haiku go through `classifyJson` (`src/agent/classify.ts`), shared with the chime classifier.
- `src/bakery/*` bakery REST client, proposals, cards, button callbacks. `src/chime/*` auto-chime scheduler and Haiku classifier.
- `src/conversation/*` history window and media. Every model-facing transcript (main, chime, reply judge) renders text through `textWithTags` (`mentions.ts`): a tag of a member without a username (`text_mention`) is plain name text, so it gets an `@` to read as a tag. `src/models/catalog.ts` model list cache.
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
- The repo is public, and GitHub secret scanning flags fake credentials too. Test fixtures never contain provider-shaped credential literals (Telegram bot token, `sk-ant-`, `ghp_`, `AKIA`, PEM, JWT, a postgres URL with a password): build fakes at runtime, e.g. `["123456789", "AA" + "x".repeat(33)].join(":")`.
- Migrations: generate with `npm run db:generate`, commit the SQL in `drizzle/`. They are applied by the Railway pre-deploy command (`drizzle-kit migrate`), never by the build.
- The pre-deploy migration runs while the old deployment still serves traffic, so every migration must work with the old code too. To drop or rename a column, first ship code that no longer uses it, then drop it in a later deploy.
- Railway deploys do not read `.railway/railway.ts`; changing it needs `railway config plan` then `apply`.

## Unverified connector behaviour
Confirm both on the first live bakery test; until then they are assumptions.
- **How a bakery 401 or outage surfaces** is not documented. The code handles a 400 whose message mentions MCP by dropping the bakery for the rest of the run and posting `bakeryUnavailableNotice` after the answer (log `run.bakery_dropped`). A tool-level failure that comes back as an `mcp_tool_result` with `is_error: true` goes to Claude as is, with no notice; each one is logged as `run.bakery_tool_error` with its scrubbed text (also `run.step` -> `mcp_tools[].error`).
- **Whether MCP and server-side fallback combine** (`mcp-client-2026-09-15` with `server-side-fallback-2026-07-01` and `fallbacks: "default"`) is assumed from the fallback doc. If they don't, every bakery run gets a 400: look for `run.error` with `status: 400` on bakery runs, or `run.bakery_dropped` on every bakery run.
