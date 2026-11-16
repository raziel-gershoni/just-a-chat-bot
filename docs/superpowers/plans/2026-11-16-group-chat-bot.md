# just-a-chat-bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude-powered Telegram group bot on Railway. It reads every message and replies to mentions, replies, trigger-emoji reactions and (optionally) on its own. It has web search/fetch, a settings Mini App, and the bakery MCP with proposal cards approved by buttons.

**Architecture:** One always-on Next.js 16 server (`next start`). The webhook route stores updates synchronously and creates `runs` rows. An in-process runner claims runs per chat through a DB lease and drives a checkpointed Claude agent loop. Anthropic's MCP connector calls the bakery server. Cards and decisions go through the bakery's REST endpoints. Startup work lives in `instrumentation.ts`.

**Tech Stack:**
- Node 24, TypeScript 6, Next.js 16.4 (Turbopack, extensionless imports)
- grammY 1.46 + @grammyjs/auto-retry, telegramify-markdown
- @anthropic-ai/sdk 1.8 (beta messages, API version 2026-10-21)
- drizzle-orm 0.45 + drizzle-kit 0.31; Neon (neon-http) in prod, PGlite in tests
- zod 4, jose 6, vitest 5
- Tailwind 4 + lucide-react for the Mini App
- railway 3.17 (IaC)

**Spec:** `docs/superpowers/specs/2026-11-15-group-chat-bot-design.md` (read it before any task).

**Verified API facts** (2026-11-16 research, trust these over memory):
- **Anthropic:**
  - `client.beta.messages.stream(params).finalMessage()`; `betas` is an array.
  - Connector beta: `"mcp-client-2026-09-15"`. Response blocks are `mcp_tool_use {id,name,server_name,input}`, `mcp_tool_result {tool_use_id,is_error,content: string | {type:"text",text}[]}`, and `mcp_tool_listing` (replay unchanged).
  - Toolset: `{type:"mcp_toolset", mcp_server_name, default_config?:{enabled}, configs?:{[tool]:{enabled}}}`. Every `mcp_servers` entry needs exactly one toolset.
  - Fallback beta: `"server-side-fallback-2026-07-01"` with `fallbacks:"default"`. It fires on refusals only. Not for Haiku: sending it to Haiku is a 400.
  - Web tools: `{type:"web_search_20260318",name:"web_search",allowed_callers:["direct"]}` and `{type:"web_fetch_20260318",name:"web_fetch",allowed_callers:["direct"]}`. No beta.
  - Search citations: `text.citations[] {type:"web_search_result_location",url,title}`.
  - Files: `client.files.upload({file: await toFile(buf,name,{type})})` → `{id}`. Use them in beta messages as `{type:"image",source:{type:"file",file_id}}` / `{type:"document",source:{type:"file",file_id}}`.
  - `output_config:{effort, format?:{type:"json_schema",schema}}`; the schema needs `additionalProperties:false`.
  - Mid-conversation system message: `{role:"system",content:string}` placed right after a user message. No beta on Opus/Sonnet/Haiku 5.5.
  - Stop reasons: `end_turn|max_tokens|stop_sequence|tool_use|pause_turn|refusal|model_context_window_exceeded|compaction`. Continue `pause_turn` by resending with the assistant message last.
  - `client.beta.models.list()`: `capabilities.image_input.supported`, `capabilities.effort.{low..max}.supported`, `capabilities.thinking.types.adaptive.supported`, `max_tokens`, `lifecycle`.
  - API v2026-10-21 rejects `temperature/top_p/top_k` and rejects non-empty `citations` on text inside **user** messages.
- **Telegram:**
  - ChatMember statuses: `creator|administrator|member|restricted|left|kicked`.
  - `callback_data` ≤64 bytes; `answerCallbackQuery` text ≤200 chars.
  - `editMessageReplyMarkup(chat, msg)` with no markup removes the buttons.
  - `startapp` allows `[A-Za-z0-9_-]{1,64}`.
  - `bot.handleUpdate` needs `botInfo` or `await bot.init()`.
  - `allowed_updates` must list every type (reactions and chat_member are opt-in).
- **Next 16:**
  - `instrumentation.ts` `register()` runs once at `next start`, not during build. Guard with `process.env.NEXT_RUNTIME==="nodejs"`.
  - With `NEXT_MANUAL_SIG_HANDLE=true` Next installs no SIGTERM handler: we drain and `process.exit`.
  - Turbopack can't resolve `.js` → `.ts`, so **imports are extensionless**.
- **Railway IaC:** `import { defineRailway, project, service, github, preserve } from "railway/iac"`. Deploys don't read it; the owner applies it with `railway config apply`. Fields go in `build:{builder,buildCommand}` / `deploy:{startCommand,preDeployCommand:[],healthcheckPath,healthcheckTimeout,restartPolicyType,drainingSeconds}`.

## Global Constraints

- **Imports:**
  - extensionless relative imports, or `@/` = repo root (tsconfig `paths` + vitest alias)
  - `"type":"module"` in package.json
  - `engines.node: "24.x"`
- **No live services in tests:**
  - The DB is PGlite with the real migrations (`tests/helpers/db.ts`).
  - Claude, Telegram and the bakery are hand-written fakes.
  - No env secrets in tests.
- **No silent failures:**
  - Every `catch` logs via `log(event, fields)` with `errorText(err)`. No empty catches.
  - A user who is waiting gets a localized notice.
- **No artificial timeouts** in app code. The SDK's retries (`maxRetries: 4`) and the run's attempt counter are the only retry mechanisms.
- **Strings:** every user-facing string comes from `src/i18n` (en/he/ru). Hebrew and Russian must read natively.
  - **Exception:** bakery card text and decision messages are passed through verbatim from the bakery.
- **Time:** times shown are Israel time (`Asia/Jerusalem`), 24h, via `Intl.DateTimeFormat`.
- **Secrets:** never in code, logs, DB or commits. `BAKERY_MCP_KEY` is read from env at call time and **never stored in run snapshots**. `errorText` scrubs bot tokens and `bmcp_` keys.
- **Gate before every commit of code:** `npx tsc --noEmit && npx vitest run`. Before push, also `npx next build`. Never run `drizzle-kit migrate` locally against prod.
- **Defaults:**
  - model `claude-opus-5-5`, effort `medium`, `max_tokens` 32000 (capped by the model's max)
  - history window 100 (choices 50/100/200/400)
  - chime on, eagerness `low`, debounce 30 s, cooldown 10 min, classifier input 30 messages, classifier `claude-haiku-5-5` effort `low`
  - trigger emoji `👾`
  - media attached for the last 10 messages + trigger targets
  - retention 800 messages/group; runs pruned after 30 days
  - lease 120 s, renewed every 30 s; typing every 4 s; album wait 2 s; ≤5 `pause_turn` continuations; ≤3 run attempts
  - initData max age 1 h; JWT 1 h
  - Railway draining 120 s
- **Commits:** end every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01UF2rYL9pDZtDpkYpF6XZGz
  ```

## Review Focus

1. **Duplicate webhook deliveries and deploy overlap.** The same `update_id` arriving twice, or two instances alive at once, must produce exactly one stored message, one run, and one answer. Pinned in Task 2 (dedupe, lease claim) and Task 6 (route dedupe + un-dedupe on failure).
2. **Crash mid-run.** After a restart, the run resumes from its last checkpoint and never re-sends an answer or a card already recorded as sent. Pinned in Task 10 (`sent` tracking) and Task 11 (recovery).
3. **The bakery key is wrong or the bakery is down.**
   - During a run: the answer still arrives and the group gets the "bakery couldn't be reached" notice.
   - On a button press: the presser gets an alert and the buttons stay.
   - Pinned in Tasks 9 and 10.
4. **Hebrew/RTL text and long answers.**
   - Answers over 4096 chars split cleanly.
   - Hebrew callback answers over 200 chars are truncated without breaking characters.
   - `callback_data` stays ≤64 bytes.
   - Pinned in Tasks 4 and 9.
5. **A group the bot doesn't know yet.** It was added before deploy or migrated to a supergroup. The first message runs the owner-membership check instead of crashing or being ignored. Pinned in Task 5.

---

## File structure

```
package.json, tsconfig.json, next.config.ts, vitest.config.ts, drizzle.config.ts, postcss.config.mjs, .env.example
instrumentation.ts                      startup hook → src/server/startup
.railway/railway.ts                     Railway IaC
drizzle/                                generated SQL migrations
app/layout.tsx, app/globals.css
app/settings/page.tsx                   Mini App (client)
app/api/health/route.ts
app/api/telegram/route.ts               webhook
app/api/miniapp/session/route.ts        initData → JWT
app/api/miniapp/settings/route.ts       GET/PUT
app/api/miniapp/forget/route.ts         POST
src/config/env.ts                       zod env loader
src/util/log.ts, src/util/errors.ts, src/util/time.ts
src/i18n/{index.ts,en.ts,he.ts,ru.ts}   catalogs + t()
src/settings/{schema.ts,emojis.ts}      group settings + allowed reactions
src/db/{schema.ts,client.ts,types.ts}
src/db/repo/{groups,messages,runs,updates,meta,models}.ts
src/telegram/{client.ts,send.ts,initdata.ts,types.ts}
src/bot/{dispatch.ts,access.ts,ingest.ts,triggers.ts,private.ts}
src/conversation/{build.ts,window.ts,media.ts}
src/agent/{request.ts,prompts.ts,answer.ts,loop.ts,runner.ts,llm.ts}
src/bakery/{config.ts,api.ts,proposals.ts,cards.ts,callback.ts}
src/chime/{scheduler.ts,classifier.ts}
src/models/catalog.ts                   models list + cache
src/miniapp/{auth.ts,jwt.ts,service.ts}
src/server/{startup.ts,deps.ts,shutdown.ts,deploy-ping.ts,sweeper.ts}
tests/**                                mirrors src/
tests/helpers/{db.ts,fake-tg.ts,fake-llm.ts,fake-bakery.ts,fixtures.ts}
```

---

### Task 1: Scaffold, env, logging

**Files:**
- Create:
  - `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `postcss.config.mjs`, `.env.example`
  - `app/layout.tsx`, `app/globals.css` (minimal; Task 15 styles)
  - `src/config/env.ts`, `src/util/log.ts`, `src/util/errors.ts`, `src/util/time.ts`
- Test: `tests/config/env.test.ts`, `tests/util/errors.test.ts`, `tests/util/time.test.ts`

**Interfaces:**
- Produces:
  - `loadEnv(source?: Record<string,string|undefined>): Env` and `env(): Env` (cached). `Env` fields:
    - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_OWNER_ID: number`, `TELEGRAM_MINIAPP_SHORT_NAME`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `JWT_SECRET` (min 32 chars)
    - `BAKERY_URL?`, `BAKERY_MCP_KEY?`
    - `PUBLIC_DOMAIN?` (from `RAILWAY_PUBLIC_DOMAIN`), `GIT_SHA?` (`RAILWAY_GIT_COMMIT_SHA`), `GIT_MESSAGE?` (`RAILWAY_GIT_COMMIT_MESSAGE`)
  - `log(event: string, fields?: Record<string,unknown>): void`: one JSON line with `ts`.
  - `errorText(err: unknown): string`: unwraps `DrizzleQueryError` like mail-manager, then scrubs `/\d{6,}:[A-Za-z0-9_-]{30,}/g` → `[bot-token]` and `/bmcp_[A-Za-z0-9_-]+/g` → `[bakery-key]`.
  - `israelTime(d: Date): string` → `"YYYY-MM-DD HH:MM"` in Asia/Jerusalem.

- [ ] **Step 1: Init the project**
  1. Write `package.json`:
     - `"name":"just-a-chat-bot"`, `"private":true`, `"type":"module"`, `"engines":{"node":"24.x"}`
     - scripts:
       - `dev: "next dev"`
       - `build: "next build"`
       - `start: "next start"`
       - `test: "vitest run"`
       - `typecheck: "tsc --noEmit"`
       - `db:generate: "drizzle-kit generate"`
       - `db:migrate: "drizzle-kit migrate"`
  2. Install deps:
     - `npm i next@16.4.6 react@19.3.1 react-dom@19.3.1 grammy@1.46.0 @grammyjs/auto-retry@2.0.2 telegramify-markdown@1.3.4 @anthropic-ai/sdk@1.8.0 drizzle-orm@0.45.4 drizzle-kit@0.31.11 @neondatabase/serverless@1.2.1 zod@4.6.7 jose@6.2.17 lucide-react@1.73.0`
     - `drizzle-kit` is a runtime dep because Railway's pre-deploy runs it.
  3. Install dev deps:
     - `npm i -D typescript@^6 @types/node@^24 @types/react@^19 @types/react-dom@^19 vitest@5.1.0 @electric-sql/pglite@0.5.16 tailwindcss@4.3.5 @tailwindcss/postcss@4.3.5 railway@3.17.0`
  4. **Install every dependency now**, so no later task touches package.json.
  5. tsconfig:
     - strict, `noUncheckedIndexedAccess`, `moduleResolution: "bundler"`, `paths: {"@/*":["./*"]}`
     - include as in mail-manager
  6. vitest config:
     - `environment:"node"`, `include:["tests/**/*.test.ts"]`
     - alias `@` → repo root via `import.meta.dirname`
- [ ] **Step 2: Write failing tests**
  - `loadEnv({...valid})` returns `TELEGRAM_OWNER_ID` as number `123`.
  - Missing `DATABASE_URL` throws an error whose message contains `"DATABASE_URL"`.
  - `TELEGRAM_OWNER_ID:"abc"` throws.
  - `JWT_SECRET` shorter than 32 chars throws.
  - `RAILWAY_PUBLIC_DOMAIN:"x.up.railway.app"` → `PUBLIC_DOMAIN === "x.up.railway.app"`.
  - `errorText(new Error("GET https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq/sendMessage failed"))` contains `[bot-token]` and not `AAHdq`.
  - `errorText("bad key bmcp_abc-DEF_123")` → `"bad key [bakery-key]"`.
  - `israelTime(new Date("2026-07-01T09:05:00Z"))` → `"2026-07-01 12:05"` (summer UTC+3).
  - `israelTime(new Date("2026-12-01T09:05:00Z"))` → `"2026-12-01 11:05"` (winter UTC+2).
- [ ] **Step 3: Run:** `npx vitest run tests/config tests/util`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** env (zod schema, lazy cache), log, errors, time. `.env.example` lists every env var with empty placeholders and a comment per line.
- [ ] **Step 5: Run** `npx vitest run && npx tsc --noEmit && npx next build`. Expected: all pass. A minimal `app/layout.tsx` and a placeholder `app/page.tsx` returning `null` are allowed so the build works.
- [ ] **Step 6: Commit:** `chore: scaffold next app, env, logging`

### Task 2: Database schema, migrations, repositories

**Files:**
- Create:
  - `drizzle.config.ts`, `src/db/schema.ts`, `src/db/client.ts`, `src/db/types.ts`
  - `src/db/repo/{groups,messages,runs,updates,meta,models}.ts`
  - `drizzle/*` (generated)
  - `tests/helpers/db.ts`, `app/api/health/route.ts`
- Test: `tests/db/{groups,messages,runs,updates,meta}.test.ts`, `tests/api/health.test.ts`

**Interfaces:**
- Produces: `type Db = PgDatabase<PgQueryResultHKT, typeof schema>` (`src/db/types.ts`); `db(): Db` (neon-http, lazy); `testDb(): Promise<Db>` (PGlite in-memory + `migrate(db,{migrationsFolder:"drizzle"})`).
- **Tables** (bigint ids as `bigint({mode:"number"})`):
  - **`groups`:**
    - `chatId` pk, `token` unique text, `title`, `active` bool
    - `settings` jsonb (`GroupSettings`, Task 3)
    - `forgetBefore` timestamptz null, `nextSeq` bigint default 1
    - `adminHintSent` bool, `createdAt`, `updatedAt`
  - **`messages`:**
    - pk (`chatId`, `messageId`); `seq` bigint (per-chat, monotonic); `threadId` null
    - `fromId` null, `fromName`, `isBot` bool, `date` timestamptz
    - `text` (text or caption, may be empty), `entities` jsonb null, `replyToId` null
    - `media` jsonb null `{kind:"photo"|"pdf"|"sticker"|"other", fileId?, fileSize?, mime?, name?, label}`
    - `mediaGroupId` null, `anthropicFileId` null, `reactionRunDone` bool default false
    - index (`chatId`,`seq`)
  - **`runs`:**
    - `id` bigserial pk, `chatId`, `threadId` null
    - `trigger` jsonb `RunTrigger`
    - `status` text `queued|running|done|failed`
    - `snapshot` jsonb null `RunSnapshot`, `steps` int 0, `attempts` int 0
    - `sent` jsonb `RunSent` default `{"answerIds":[],"answered":false,"cards":[]}`
    - `leaseOwner` null, `leaseUntil` timestamptz null, `error` null
    - `createdAt`, `updatedAt`
    - index (`chatId`,`status`,`id`)
  - **`processed_updates`:** `updateId` pk, `at`.
  - **`meta`:** `key` pk, `value` text.
  - **`models_cache`:** `id` pk int (always 1), `fetchedAt`, `models` jsonb.
- **Repo functions** (all take `db: Db` first):
  - `groups.ts`:
    - `getGroup(db, chatId)`, `getGroupByToken(db, token)`
    - `upsertGroup(db, {chatId,title,settings,token})` (insert; on conflict sets active=true + title)
    - `setGroupActive(db, chatId, active)`, `updateSettings(db, chatId, settings)`, `setForgetBefore(db, chatId, at)`, `markAdminHintSent(db, chatId)`
    - `migrateChat(db, oldId, newId)`: moves groups/messages/runs rows; idempotent; if a fresh row for `newId` exists, it is replaced by the old row
  - `messages.ts`:
    - `insertMessage(db, m: NewMessage): Promise<StoredMessage|null>`: allocates `seq` via `UPDATE groups SET next_seq=next_seq+1 RETURNING next_seq-1`; on conflict (chatId,messageId) does nothing → null. After insert it deletes rows with `seq <= newSeq-800` and returns their `anthropicFileId`s in `pruned: string[]`.
    - `updateMessageText(db, chatId, messageId, text, entities)`
    - `getMessage(db, chatId, messageId)`
    - `windowMessages(db, {chatId, threadId, window, after}): StoredMessage[]` (ascending): the newest rows with `seq >= startSeq`, where `startSeq = max(1, floor((newestSeq - window)/20)*20 + 1)`, filtered by thread when `threadId != null` and by `date > after` when set. The step keeps the window start fixed for 20 messages.
    - `recentMessages(db, chatId, limit)`
    - `lastBotMessageAt(db, chatId)`
    - `setAnthropicFileId(db, chatId, messageId, fileId)`
    - `claimReactionRun(db, chatId, messageId): boolean`: sets `reactionRunDone=true` only if false
    - `deleteChatMessages(db, chatId): string[]`: returns file ids
  - `runs.ts`:
    - `createRun(db, {chatId, threadId, trigger}): RunRow`
    - `claimNextRun(db, chatId, owner, leaseMs, now): RunRow|null`: atomically leases the **oldest** run of the chat whose status is queued/running, only if its lease is null or expired; it never skips past a head run that is leased by someone else. Sets status `running`.
    - `renewLease(db, runId, owner, leaseMs, now): boolean`
    - `saveCheckpoint(db, runId, owner, patch: {snapshot?, steps?, sent?, attempts?})`: write only if `leaseOwner = owner`; returns boolean
    - `finishRun(db, runId, owner, status: "done"|"failed", error?)`
    - `releaseLease(db, runId, owner)`
    - `chatsWithPendingRuns(db, now): number[]`: chats whose head run is claimable
    - `hasActiveRun(db, chatId, now): boolean`: queued, or running with a live lease
    - `pruneRuns(db, olderThan)`, `deleteChatRuns(db, chatId)`: finished runs only
  - `updates.ts`: `markUpdate(db, updateId): boolean` (true = first time), `unmarkUpdate(db, updateId)`, `pruneUpdates(db, olderThan)`.
  - `meta.ts`:
    - `getMeta(db, key)`
    - `casMeta(db, key, value): boolean`: true only if the stored value differed or was absent; atomic via `INSERT ... ON CONFLICT DO UPDATE ... WHERE meta.value <> excluded.value RETURNING`
  - `models.ts`: `readModelsCache(db)`, `writeModelsCache(db, models, at)`.
- **JSON types** (exported from `src/db/schema.ts`):
  - `RunTrigger = {type:"mention"|"reply"|"reaction"|"chime"; messageId:number; targetMessageId:number; requesterId:number|null; requesterName:string|null; emoji?:string}`
  - `RunSent = {answerIds:number[]; answered:boolean; cards:number[]; bakeryNoticeSent?:boolean}`
  - `RunSnapshot = {model:string; effort:string; maxTokens:number; thinking:boolean; fallbacks:boolean; bakery:"full"|"read"|null; system:string; context:string; messages:unknown[]; pauseCount:number; startIndex:number; bakeryDropped?:boolean}`

- [ ] **Step 1: Write schema + `drizzle.config.ts`**, then run `npx drizzle-kit generate`. Expected: `drizzle/0000_*.sql` created. No DB connection is needed.
- [ ] **Step 2: Write failing tests** (each uses `await testDb()`):
  - `markUpdate` returns true then false for the same id; `unmarkUpdate` makes it true again.
  - `insertMessage` gives seq 1, 2, 3 for three messages in one chat and seq 1 in another chat. A duplicate (chatId,messageId) returns null and doesn't advance seq.
  - With 805 messages inserted, the 805th insert result has `pruned` containing the file id of seq 5 (set on that row beforehand), and `count(*)` for the chat is 800.
  - `windowMessages`:
    - with seqs 1..130 and window 100, it returns seq 21..130 (startSeq = floor(30/20)*20+1 = 21)
    - with seqs 1..139 it still starts at 21
    - with seqs 1..140 it starts at 41
    - with threadId 7, only thread-7 rows come back
    - `after` excludes older dates
  - `claimNextRun`:
    - two queued runs A<B in chat 1 → claim returns A
    - a second claim (another owner) returns null while A's lease is live
    - after `finishRun(A,"done")` the claim returns B
    - with A leased by owner "x" and its lease expired at `now`, owner "y" claims A
  - `saveCheckpoint` by a non-owner returns false and doesn't write.
  - `casMeta("deploy_sha","abc")` → true, again `"abc"` → false, `"def"` → true.
  - `claimReactionRun` returns true once, then false.
  - `migrateChat(-1, -1001)` moves the group and its messages; calling it twice is a no-op.
  - Health route: `GET()` with an injected db returns 200 `{ok:true}`. The route exports `handleHealth(db)` for testing; `GET` calls it with `db()`.
- [ ] **Step 3: Run** `npx vitest run tests/db tests/api/health.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement the repos.** Only use the query builder (no raw `execute`), because results differ between neon-http and PGlite. The health route does `select 1` via `db.select({one: sql\`1\`})`.
- [ ] **Step 5: Run the tests + `npx tsc --noEmit`.** Expected: PASS.
- [ ] **Step 6: Commit:** `feat: db schema, migrations, repositories`

### Task 3: i18n catalogs and group settings

**Files:**
- Create: `src/i18n/{index.ts,en.ts,he.ts,ru.ts}`, `src/settings/{schema.ts,emojis.ts}`
- Test: `tests/i18n/i18n.test.ts`, `tests/settings/schema.test.ts`

**Interfaces:**
- Produces:
  - `type Lang = "he"|"en"|"ru"`
  - `pickLang(code?: string|null): Lang`: `he*`→he, `ru*`→ru, else en; `iw` → he
  - `t(lang: Lang, key: MsgKey, vars?: Record<string,string|number>): string`: `{name}` placeholders
  - `MsgKey = keyof typeof en`; `he` and `ru` are typed `Record<MsgKey,string>`
- **Required keys** (bot side; Mini App keys are added in Task 15):
  - `groupsOnly`, `ownerMissingLeaving`, `welcome`, `settingsButton`, `adminHint`
  - `refusal`, `cutShort`, `runFailed`, `sourcesLabel`
  - `bakeryApprove` (he "אשר"), `bakeryReject` (he "בטל"), `bakeryUnreachable`, `bakeryUnavailableNotice`
  - `noNewerMessages`
- **Settings** (`src/settings/schema.ts`):
  - `GroupSettings` zod schema with defaults:
    - `{model:"claude-opus-5-5", effort:"medium", chime:{enabled:true, eagerness:"low"}, triggerEmoji:"👾", historyWindow:100, language:"en", bakery:false}`
    - effort enum `low|medium|high|xhigh|max`; eagerness enum `low|medium|high`; historyWindow ∈ {50,100,200,400}
    - triggerEmoji ∈ `REACTION_EMOJIS`
  - `parseSettings(raw: unknown): GroupSettings`: merges defaults and drops invalid fields with a log line; never throws
  - `defaultSettings(lang: Lang): GroupSettings`
- **Emojis** (`src/settings/emojis.ts`): `REACTION_EMOJIS: readonly string[]`, exactly: ❤ 👍 👎 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡

- [ ] **Step 1: Write failing tests**
  - `pickLang("he-IL")==="he"`, `pickLang("ru")==="ru"`, `pickLang("fr")==="en"`, `pickLang(undefined)==="en"`.
  - Every key in `en` exists and is non-empty in `he` and `ru`.
  - `t("he","bakeryApprove")==="אשר"`.
  - `t("en","welcome",{settings:"x"})` contains no `{`.
  - `parseSettings({effort:"bogus", historyWindow:200})` → effort `"medium"`, historyWindow 200.
  - `parseSettings({triggerEmoji:"🤖"})` → `"👾"`.
  - `REACTION_EMOJIS.includes("👾")` and `!includes("🤖")`.
- [ ] **Step 2: Run** `npx vitest run tests/i18n tests/settings`. Expected: FAIL.
- [ ] **Step 3: Implement.** Write Hebrew and Russian natively, not word for word. The welcome text explains briefly how to call the bot (mention, reply, react with the trigger emoji) and that settings are behind the button.
- [ ] **Step 4: Run.** Expected: PASS. **Step 5: Commit** `feat: i18n catalogs and group settings`

### Task 4: Telegram plumbing (client, send, initData)

**Files:**
- Create: `src/telegram/{client.ts,send.ts,initdata.ts,types.ts}`
- Test: `tests/telegram/{send.test.ts,initdata.test.ts}`, `tests/helpers/fake-tg.ts`

**Interfaces:**
- Produces:
  - `type TgApi = Pick<Api, "sendMessage"|"editMessageReplyMarkup"|"answerCallbackQuery"|"getChatMember"|"leaveChat"|"sendChatAction"|"getFile"|"setWebhook">` (grammY `Api`).
  - `telegramBot(token): Bot`: copied from `/Users/razielgershoni/development/mail-manager/src/telegram/client.ts`.
  - `fileUrl(token, filePath): string`.
  - `send.ts` (adapted from mail-manager `send.ts`; keep `splitMessage`/`messageParts`/fallback logic):
    - `sendAnswer(api: TgApi, chatId: number, markdown: string, opts: {replyTo?: number; threadId?: number|null; tailMd2?: string}): Promise<number[]>`
      - every part is sent with `reply_parameters:{message_id, allow_sending_without_reply:true}` (first part only) and `message_thread_id`
      - `tailMd2` is pre-escaped MarkdownV2. It is appended to the last part's MarkdownV2 when the result is ≤4096 chars, else sent as its own message.
    - `sendText(api, chatId, text, opts: {replyTo?, threadId?, buttons?: {text:string; data?:string; url?:string}[][]}): Promise<number>`: plain text, no parse mode, link previews off.
  - `escapeMd2(s: string): string`.
  - `sourcesBlock(label: string, sources: {url:string; title:string|null}[]): string`: expandable blockquote MarkdownV2 (`**>label` then `>` lines with `[title](url)`, last line ends `||`), ≤5 sources; returns `""` for none.
  - `initdata.ts`:
    - `verifyInitData(initData, botToken, now, maxAgeMs = 3_600_000): {user:{id:number; firstName:string; languageCode?:string}; startParam: string|null}|null`
    - HMAC per `/Users/razielgershoni/development/mail-manager/src/telegram/initdata.ts`
  - `tests/helpers/fake-tg.ts`: `fakeTg(): TgApi & {calls: {method:string; args:unknown[]}[]}`. `sendMessage` returns incrementing `message_id` from 1000; `getChatMember` is configurable via `fake.members.set(userId, status)`.

- [ ] **Step 1: Write failing tests**
  - `sendAnswer` with 5000 chars of plain paragraphs sends 2 messages; only the first has `reply_parameters.message_id === 42`; both carry `message_thread_id: 7`.
  - `sendAnswer` with a `tailMd2` of 10 chars on a short answer sends 1 message ending with that tail.
  - `sourcesBlock("Sources",[{url:"https://a.com/x_y",title:"A (b)"}])` starts with `**>Sources` and escapes `(`, `)` and `_`.
  - `escapeMd2("a.b!")==="a\\.b\\!"`.
  - initData:
    - a string signed in the test with token `"123:abc"` returns user id and `startParam:"tok_1"`
    - a tampered hash → null
    - `auth_date` 2 h old → null
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: telegram client, sending and initData verification`

### Task 5: Access control, ingestion, triggers

**Files:**
- Create: `src/bot/{triggers.ts,access.ts,ingest.ts,private.ts,dispatch.ts}`, `tests/helpers/fixtures.ts` (update builders)
- Test: `tests/bot/{triggers,access,ingest,dispatch}.test.ts`

**Interfaces:**
- Consumes: Task 2 repos, Task 3 `t`/`pickLang`/`defaultSettings`, Task 4 `TgApi`/`sendText`.
- Produces:
  - `type BotDeps = {db: Db; tg: TgApi; env: Pick<Env,"TELEGRAM_OWNER_ID"|"TELEGRAM_MINIAPP_SHORT_NAME">; botId: number; botUsername: string; enqueue(chatId:number, delayMs?:number): void; chime: {onHumanMessage(chatId:number): void}; onCallback(q: CallbackQuery): Promise<void>; deleteFiles(ids: string[]): void; now(): Date}` (`deleteFiles` is fire-and-forget, logs failures; called with `insertMessage(...).pruned`)
  - `handleUpdate(update: Update, deps: BotDeps): Promise<void>`: routes by update kind; throws on DB failure so the route can 500
  - `detectTrigger(msg: Message, ctx: {botId; botUsername; botMessage: (id:number)=>boolean}): "mention"|"reply"|null`, pure:
    - mention: a `mention` entity whose text equals `@botUsername` (case-insensitive), or a `text_mention` with `user.id===botId`, in `entities` or `caption_entities`
    - reply: `reply_to_message.from.id===botId`
  - `reactionTrigger(upd: MessageReactionUpdated, emoji: string): boolean`: true when `emoji` is in `new_reaction` and not in `old_reaction` (type `"emoji"` only)
  - `ensureGroup(deps, chat, adder: User|undefined): Promise<GroupRow|null>`:
    1. If the group exists and is active → return it.
    2. Otherwise check `getChatMember(chat.id, OWNER)`. Allowed statuses: `creator|administrator|member`, or `restricted` with `is_member`.
    3. If allowed: upsert with `defaultSettings(pickLang(adder?.language_code))` and a token of 16 random bytes in base64url, then post the welcome message with a URL button `https://t.me/<botUsername>/<SHORT_NAME>?startapp=<token>` → return the group.
    4. If not allowed: send `ownerMissingLeaving` → `leaveChat` → `setGroupActive(false)` → return null.
    5. A `getChatMember` error is logged and treated as "not allowed" (strangers must not get in), with the reason logged.
  - `messageToRow(msg: Message): NewMessage`, pure:
    - photo → largest size `{kind:"photo"}`
    - document with `mime_type==="application/pdf"` → `pdf`
    - sticker with `!is_animated && !is_video` → `sticker` (use `file_id`)
    - other media → `{kind:"other", label:"video"|"voice"|"animation"|"audio"|"document"|"sticker"}`
    - `fromName` = first + last name
- **Routing rules:**
  - **`my_chat_member`:**
    - bot became `member|administrator` from `left|kicked` → `ensureGroup`; if the new status is `member` and the hint hasn't been sent → send `adminHint` + `markAdminHintSent`
    - bot became `left|kicked` → `setGroupActive(false)`
    - non-group chats (channel) → `leaveChat`
  - **`chat_member`:** the owner's new status is `left|kicked` → `leaveChat` + inactive.
  - **`message` in a private chat:** reply `groupsOnly` in `pickLang(from.language_code)`.
  - **`message` in a group/supergroup:**
    1. If `migrate_to_chat_id` → `migrateChat`, stop.
    2. Skip if `from.is_bot`.
    3. `ensureGroup` (null → stop); `insertMessage` (null → duplicate, stop).
    4. If `detectTrigger` matches → `createRun` with `targetMessageId` (reply: the message itself; mention: the message itself) → `enqueue(chatId, media_group_id ? 2000 : 0)`.
    5. Else if `settings.chime.enabled` → `chime.onHumanMessage`.
  - **`edited_message`:** `updateMessageText` only.
  - **`message_reaction`:** if the group is active, the emoji matches `settings.triggerEmoji`, the stored message exists, and `claimReactionRun` succeeds → `createRun({type:"reaction", messageId: msgId, targetMessageId: msgId, requesterId: user?.id, emoji})` → `enqueue`.
  - **`callback_query`:** → `deps.onCallback`.
  - Each ignored path logs `bot.ignored` with a `reason`.

- [ ] **Step 1: Write failing tests** (PGlite + fake tg + fixture builders):
  - `detectTrigger`:
    - text `"hi @MyBot"` with a mention entity at offset 3 len 6 → `"mention"`
    - `"@otherbot"` → null
    - reply to bot → `"reply"`
    - caption mention → `"mention"`
  - `reactionTrigger`: `old:[] new:[👾]` → true; `old:[👾] new:[👾,👍]` → false; custom emoji → false.
  - Bot added by an adder with `language_code:"he"` while the owner is a member → group row with `settings.language==="he"`, a welcome message whose button URL matches `/^https:\/\/t\.me\/MyBot\/settings\?startapp=[A-Za-z0-9_-]{22}$/`, and an admin hint sent once.
  - Bot added while the owner is not a member → `ownerMissingLeaving` sent, `leaveChat` called, group inactive.
  - A message in an unknown group where the owner is a member → the group gets created and the message stored. **(Review Focus 5)**
  - The same message delivered twice → one row, one run.
  - Mention → a run with `type:"mention"`, and `enqueue` called with delay 0; with `media_group_id` → delay 2000.
  - A non-trigger message in a chime-enabled group → `chime.onHumanMessage` called; in a chime-disabled group → not called.
  - `edited_message` that newly contains a mention → text updated, no run.
  - Reaction 👾 twice by two users → one run.
  - Reaction 👍 when the trigger is 👾 → no run.
  - The owner leaves (`chat_member`) → `leaveChat`.
  - A private message → a `groupsOnly` reply.
  - `migrate_to_chat_id` moves rows.
  - A message from `is_bot` is ignored.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: access control, ingestion and trigger detection`

### Task 6: Webhook route

**Files:**
- Create: `app/api/telegram/route.ts`, `src/server/deps.ts` (lazy singletons, see below)
- Test: `tests/api/telegram-route.test.ts`

**Interfaces:**
- Consumes: Task 5 `handleUpdate`, Task 2 `markUpdate`/`unmarkUpdate`.
- Produces:
  - `handleWebhook(req: Request, deps: {secret: string; db: Db; handle(update: Update): Promise<void>}): Promise<Response>`:
    1. Header `x-telegram-bot-api-secret-token` ≠ secret → 401 (logged).
    2. Bad JSON → 400.
    3. `markUpdate` false → 200 (`webhook.duplicate`).
    4. `handle` throws → `unmarkUpdate`, log, 500.
    5. Otherwise 200.
  - `route.ts`: `export const runtime="nodejs"; export const dynamic="force-dynamic"`. `POST` calls `handleWebhook(req, serverDeps().webhook)`.
  - `src/server/deps.ts`: `serverDeps()` builds the process-wide singletons once:
    - db, `tg` (`telegramBot(token)` with `botInfo` from a cached `getMe`, so `bot.init()` runs once)
    - Anthropic client, runner, chime scheduler, bakery
  - Later tasks register into it. Keep it a single factory with a `globalThis` guard so dev hot-reload doesn't duplicate timers.

- [ ] **Step 1: Write failing tests:** wrong secret → 401 and `handle` not called; the same update twice → `handle` called once; `handle` throwing → 500 and a redelivery calls `handle` again.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: telegram webhook route with dedupe`

### Task 7: Conversation builder and media

**Files:**
- Create: `src/conversation/{build.ts,media.ts}`
- Test: `tests/conversation/{build,media}.test.ts`

**Interfaces:**
- Consumes: `StoredMessage` (Task 2), `israelTime` (Task 1).
- Produces:
  - `buildTranscript(rows: StoredMessage[], opts: {attach: Map<number, {type:"image"|"document"; fileId:string}>; noNewer: string}): BetaMessageParam[]`, pure:
    - **Human rows:** each becomes its own text block `<msg id="{messageId}" from="{fromName}" at="{israelTime}"{ reply_to="{id}"}>{text}{ [label]}</msg>`. The `label` is media `label` like `[photo]`/`[PDF: name]`; when attached it reads `[photo attached]`.
    - **Attached media:** gets an image/document block right after its message's text block.
    - **Bot rows:** become assistant turns of text blocks (the stored text), with citations stripped (stored text has none).
    - **Turns:** consecutive same-role rows merge into one turn. Leading assistant turns are dropped. If the last turn is assistant, a user turn `[{type:"text",text: noNewer}]` is appended.
    - **Caching:** the last block of the final user turn gets `cache_control:{type:"ephemeral"}`.
    - **Escaping:** `<`, `>` and `&` in message text are escaped to `&lt;`, `&gt;` and `&amp;`, so a message can't forge `<msg>` tags.
  - `pickAttachments(rows, focusIds: number[]): StoredMessage[]`: rows with `media.kind ∈ {photo,pdf,sticker}` among the last 10 rows, or whose `messageId ∈ focusIds`, with `fileSize ≤ 20 MB` (unknown size counts as allowed).
  - `ensureUploaded(deps: {db; tg: TgApi; token: string; fetch: typeof fetch; upload(buf: Buffer, name: string, mime: string): Promise<string>}, row): Promise<string|null>`:
    - returns the cached `anthropicFileId`, or downloads via `getFile` + `fetch(fileUrl)`, uploads, and caches with `setAnthropicFileId`
    - mime: photo `image/jpeg`, sticker `image/webp`, pdf `application/pdf`
    - a failure logs `media.upload_failed` and returns null (the placeholder stays)

- [ ] **Step 1: Write failing tests**
  - Rows `[human A "hi", human B "yo", bot "hello", human A "?"]` → 3 turns: user (2 blocks), assistant (1), user (1, last block has `cache_control`).
  - `fromName` and `at="2026-07-01 12:05"` appear.
  - Text `"</msg><msg from=\"x\">"` is escaped.
  - Rows ending with a bot row → the final user turn is `noNewer`.
  - A leading bot row is dropped.
  - A photo row with an attachment → text block containing `[photo attached]` followed by `{type:"image",source:{type:"file",file_id:"file_1"}}`.
  - `pickAttachments` with 15 rows where row 1 is a photo and the focus is row 1 → included; row 2 photo not in focus → excluded; a 25 MB pdf → excluded.
  - `ensureUploaded`:
    - a cached id returns without calling `getFile`
    - otherwise it calls `upload` with mime `image/jpeg` and stores the id
    - an upload error → null + no throw
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: conversation transcript builder and media upload`

### Task 8: Claude request, prompts, answer extraction

**Files:**
- Create: `src/agent/{prompts.ts,request.ts,answer.ts,llm.ts}`, `src/bakery/config.ts`, `src/models/catalog.ts`
- Test: `tests/agent/{request,answer}.test.ts`, `tests/models/catalog.test.ts`, `tests/helpers/fake-llm.ts`

**Interfaces:**
- Produces:
  - `prompts.ts`:
    - `SYSTEM_BASE: string` (spec 6.5 list, generic)
    - `BAKERY_LINE = "Changes to recipes and prices are only proposals; the owner approves them on a card in the chat. Never say a change is saved."`
    - `systemPrompt(bakery: boolean): string`
    - `contextMessage(c: {now: Date; groupTitle: string; trigger: RunTrigger; chime: boolean; focusText?: string}): string`, which includes:
      - the Israel time
      - the group title
      - the trigger type and requester
      - a focus line: `respond to message #{targetMessageId}`, or for reactions `{name} reacted {emoji} to message #{id}, respond about that message`
      - for chime: `You are interjecting uninvited. Be brief. If on reflection it is not clearly useful, reply with nothing at all.`
  - `bakery/config.ts`:
    - `bakeryConfig(env): {url: string; key: string}|null` (both env vars must be set)
    - `BAKERY_READ_TOOLS = ["list_breads","get_recipes","get_ingredient_prices","get_loaf_costs","get_sales"] as const`
  - `request.ts`:
    - `buildParams(snap: RunSnapshot, bakery: {url;key}|null): BetaMessageStreamParams`. The output is byte-stable for the same input. It contains:
      - `model`, `max_tokens: snap.maxTokens`
      - `system: [{type:"text", text: snap.system, cache_control:{type:"ephemeral"}}]`
      - `messages: snap.messages`
      - `output_config: {effort: snap.effort}`
      - `thinking: {type:"adaptive"}` when `snap.thinking`
      - `tools`: the web search + web fetch tools (verified shapes above), plus, when `snap.bakery && bakery && !snap.bakeryDropped`, `{type:"mcp_toolset", mcp_server_name:"bakery"}`. For `"read"` it adds `default_config:{enabled:false}, configs: {each read tool: {enabled:true}}`.
      - `mcp_servers: [{type:"url", name:"bakery", url: bakery.url+"/api/mcp", authorization_token: bakery.key}]` in that same case
      - `betas`: `"mcp-client-2026-09-15"` when MCP is included; `"server-side-fallback-2026-07-01"` + `fallbacks:"default"` when `snap.fallbacks`
    - `newSnapshot(input: {settings: GroupSettings; model: ModelInfoLite|undefined; bakeryAvailable: boolean; chime: boolean; transcript; context: string}): RunSnapshot`:
      - `maxTokens = min(32000, model?.maxTokens ?? 32000)`
      - `thinking = model?.adaptive ?? true`
      - `fallbacks = !model id startsWith "claude-haiku"`
      - `bakery = settings.bakery && bakeryAvailable ? (chime ? "read" : "full") : null`
      - `messages = [...transcript, {role:"system", content: context}]`
  - `answer.ts`:
    - `answerText(blocks: BetaContentBlock[]): string`: take the text blocks after the last block whose type is `web_search_tool_result|web_fetch_tool_result|mcp_tool_result`; if there are none after it, all text blocks; join with `""` and trim
    - `answerSources(blocks): {url;title}[]`: unique `web_search_result_location` citations from those same text blocks, in order
    - `runBlocks(messages: unknown[], fromIndex: number): BetaContentBlock[]`: flattens the content of assistant messages from `fromIndex` on
  - `llm.ts`:
    - `type Llm = {stream(params: BetaMessageStreamParams): Promise<BetaMessage>; classify(params): Promise<BetaMessage>; upload(buf, name, mime): Promise<string>; deleteFile(id: string): Promise<void>; listModels(): Promise<ModelInfoLite[]>}` (`deleteFile` via `client.files.delete`)
    - `anthropicLlm(apiKey)`: `new Anthropic({apiKey, maxRetries: 4})`; `stream` = `client.beta.messages.stream(p).finalMessage()`; `upload` via `client.files.upload` + `toFile`; `listModels` iterates `client.beta.models.list()`
  - `models/catalog.ts`:
    - `type ModelInfoLite = {id; displayName; maxTokens; efforts: string[]; adaptive: boolean}`
    - `toLite(m: BetaModelInfo)`
    - `getModels(deps:{db; llm; now}): Promise<ModelInfoLite[]>`: cache for 24 h; keep `lifecycle==="active"` and `capabilities.image_input.supported`; on fetch failure, log and return the stale cache, or `[{id:"claude-opus-5-5",...defaults}]` if there is none
  - `tests/helpers/fake-llm.ts`: `fakeLlm(script: Array<BetaMessage | Error>)` returns responses in order and records the params.

- [ ] **Step 1: Write failing tests**
  - `buildParams` for `bakery:"full"` contains the toolset without `default_config` and `mcp_servers[0].url === "https://b.example/api/mcp"`. For `"read"`, `default_config.enabled === false` and `configs.get_sales.enabled === true`, with no `propose_*` key. With a null bakery config → no `mcp_servers`, no MCP beta.
  - JSON of `buildParams(snap)` is identical across two calls, and no snapshot field contains the key (`JSON.stringify(snap)` has no `bmcp_`).
  - `newSnapshot` for a haiku model → `fallbacks:false`.
  - `systemPrompt(true)` includes `BAKERY_LINE`; `systemPrompt(false)` doesn't.
  - `answerText([text "Let me check", server_tool_use, web_search_tool_result, text "It is 5°"])` → `"It is 5°"`; `[text "Hi"]` → `"Hi"`.
  - `answerSources` dedupes by url.
  - `getModels` filters out a model without image input, reads the cache within 24 h without calling `listModels`, and on a `listModels` error returns the stale cache.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: claude request builder, prompts, answer extraction, models catalog`

### Task 9: Bakery proposals, cards and decisions

**Files:**
- Create: `src/bakery/{api.ts,proposals.ts,cards.ts,callback.ts}`
- Test: `tests/bakery/{api,proposals,cards,callback}.test.ts`, `tests/helpers/fake-bakery.ts`

**Interfaces:**
- Produces:
  - **`api.ts`:**
    - `type BakeryApi = {getProposal(id:number): Promise<{summaryHe:string}|null>; decide(id:number, telegramUserId:number, decision:"approve"|"reject"): Promise<DecisionResult>}`
    - `type DecisionResult = {status:number; outcome?: string; message?: string}`
    - `bakeryApi(cfg:{url;key}, fetchImpl = fetch)`:
      - `GET {url}/api/mcp/proposals/{id}` and `POST {url}/api/mcp/proposals/{id}/decision`, with `Authorization: Bearer key` and a JSON body `{telegramUserId, decision}`
      - `getProposal`: a non-200 or a network error logs `bakery.proposal_fetch_failed {id,status}` and returns null
      - `decide`: a network error returns `{status:0}` and logs; an unparseable body returns `{status}`
  - **`proposals.ts`:** `extractProposals(blocks: BetaContentBlock[]): {proposalId:number; summary:string|null}[]`. It takes each `mcp_tool_result` with `!is_error` whose matching `mcp_tool_use` (same id, `server_name==="bakery"`) name starts with `propose_`. The content is a string or text blocks joined; JSON parse → `proposalId` (number). A parse failure logs `bakery.proposal_parse_failed` and skips.
  - **`cards.ts`:** `postCards(deps:{tg; bakery: BakeryApi; lang: Lang}, args:{chatId; threadId; replyTo: number; proposals; already: number[]}): Promise<number[]>`.
    - For each proposal not in `already`, it posts `sendText(summaryHe ?? summary)` with buttons:
      - `[[{text: t(lang,"bakeryApprove"), data:`mcp:approve:${id}`}, {text: t(lang,"bakeryReject"), data:`mcp:reject:${id}`}]]`
    - It returns the posted proposal ids. The caller persists them after **each** card.
    - If both the summary from `getProposal` and the fallback are missing, it posts nothing and logs.
  - **`callback.ts`:** `handleBakeryCallback(q: CallbackQuery, deps:{tg; bakery: BakeryApi|null; lang: (chatId:number)=>Promise<Lang>}): Promise<boolean>`. Returns false when the data doesn't match `/^mcp:(approve|reject):(\d+)$/`. Otherwise:
    1. `decide(id, q.from.id, approve? "approve":"reject")`.
    2. **Result has `outcome` and `message`:**
       - `answerCallbackQuery(q.id, {text: truncate200(message), show_alert: outcome==="not_owner"})`
       - if outcome ≠ `not_owner`: `editMessageReplyMarkup(chat, msg)` (no markup), then `sendText(message, {replyTo: card msg id, threadId})`
    3. **Otherwise** (status 0, 401, missing body, or bakery not configured): `answerCallbackQuery(q.id, {text: t(lang,"bakeryUnreachable"), show_alert:true})` and keep the buttons.
    4. Log every status ≠ 200 as `bakery.decision {id,status,outcome}`.
    5. Errors from edit/send are logged, not thrown, after the callback has been answered.
  - `truncate200(s)`: at most 200 code points, cut on a code-point boundary (`Array.from`), with `…` when cut.

- [ ] **Step 1: Write failing tests**
  - `extractProposals`:
    - blocks with `mcp_tool_use{id:"u1",name:"propose_bread_price",server_name:"bakery"}` + `mcp_tool_result{tool_use_id:"u1",is_error:false,content:'{"proposalId":12,"status":"pending","summary":"שינוי","expiresAt":"x"}'}` → `[{proposalId:12, summary:"שינוי"}]`
    - `is_error:true` → `[]`
    - a `get_sales` result → `[]`
    - content as `[{type:"text",text:"{\"proposalId\":3,...}"}]` works
  - `postCards`:
    - posts `summaryHe` from `getProposal` (not the fallback) with `callback_data` `mcp:approve:12` (≤64 bytes)
    - `getProposal` null → uses the fallback summary
    - `already:[12]` → posts nothing
  - Callback, one test per outcome:
    - `applied` / `rejected` / `not_found` / `already_decided` / `expired` / `stale` / `failed`: an answer with the message and `show_alert:false`, the buttons removed, and a reply with the message
    - `not_owner`: `show_alert:true`, no edit, no reply
    - status 401 without an outcome: a `bakeryUnreachable` alert, no edit
    - network error (status 0): the same
    - a 300-char Hebrew message: the answer text is ≤200 code points and ends with `…`, the reply has the full text
    - `decide` is called with `q.from.id`
    - data `"other"` returns false
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: bakery proposal cards and decision handler`

### Task 10: Agent run loop

**Files:**
- Create: `src/agent/loop.ts`
- Test: `tests/agent/loop.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 4, 7, 8, 9.
- Produces:
  - `processRun(run: RunRow, deps: LoopDeps): Promise<void>`, where `LoopDeps = {db; tg; llm: Llm; owner: string; leaseMs: number; now(): Date; bakeryCfg: {url;key}|null; bakery: BakeryApi|null; token: string; fetch: typeof fetch; models(): Promise<ModelInfoLite[]>}`.
  - **Build:** if `run.snapshot` is null:
    1. Load the group (inactive → `finishRun failed "inactive"`).
    2. `windowMessages` with the settings window and `forgetBefore`.
    3. Attachments via `pickAttachments` with focus `[messageId, targetMessageId, target.replyToId]` → `ensureUploaded`.
    4. `buildTranscript`, `contextMessage`, `newSnapshot` (chime = `trigger.type==="chime"`).
    5. Checkpoint. Set `snapshot.startIndex = snapshot.messages.length` (where this run's assistant messages begin).
  - **Step loop:**
    1. `llm.stream(buildParams(snap, bakeryCfg))`.
    2. Append `{role:"assistant", content: msg.content}`, `steps+1`, checkpoint (a false return → lost lease → stop quietly with a log).
    3. Switch on `stop_reason`:
       - `pause_turn`: `pauseCount+1`; if ≤5 continue, else finalize.
       - `end_turn|stop_sequence`: finalize.
       - `max_tokens|model_context_window_exceeded`: finalize with a `cutShort` note appended.
       - `refusal`: finalize with the `refusal` text, replacing any partial answer.
       - `tool_use` or other: log `run.unexpected_stop`, finalize as failed.
  - **Finalize:**
    1. `blocks = runBlocks(messages, startIndex)`.
    2. If `!sent.answered`: `text = answerText(blocks)` (+ note).
       - non-empty → `sendAnswer` (reply to `targetMessageId`, thread, `tailMd2 = sourcesBlock(t(lang,"sourcesLabel"), answerSources(blocks))`)
       - store each part as a bot message row (`isBot:true`, `fromName` = bot name, text = that part's markdown), then `sent={...answered:true, answerIds}` + checkpoint
       - empty → `answered:true` with no send (chime silence), logged `run.silent`
    3. **Cards:** `extractProposals(blocks)` → `postCards(..., already: sent.cards, replyTo: answerIds[0] ?? targetMessageId)`. Checkpoint after each card id.
    4. If `snap.bakeryDropped && !sent.bakeryNoticeSent` → send `bakeryUnavailableNotice`, then checkpoint.
    5. `finishRun done`.
  - **Errors** (thrown by `llm.stream`, send, etc.):
    - An `Anthropic.APIError` with status 400 whose message matches `/mcp/i` while the snapshot has bakery and is not yet dropped: set `bakeryDropped:true`, log `run.bakery_dropped`, checkpoint, retry immediately (no attempt consumed). A dropped bakery stays dropped for the rest of the run, so the request stays byte-stable.
    - Other 4xx (except 408/409/429): finish failed and send `runFailed` (reply to the target).
    - Anything else: `attempts+1`. If <3 → checkpoint and `releaseLease` (the runner retries after a backoff of `attempts*30 s`). If ≥3 → failed + `runFailed`.
    - Sending `runFailed` itself failing is logged.
  - **Logging:** usage from every step (`input_tokens`, `cache_read_input_tokens`, `output_tokens`, `model`) is logged as `run.step`.

- [ ] **Step 1: Write failing tests** (PGlite, fake tg, fake llm, fake bakery):
  - `end_turn` with text "Hello" → one Telegram message replying to the target, a stored bot row, run `done`, `sent.answered`.
  - `pause_turn` then `end_turn` → 2 llm calls. The second call's messages end with the first assistant content unchanged (deep-equal), and its params JSON prefix matches the first call's.
  - 6× `pause_turn` → 6 calls, then finalize (no 7th).
  - `refusal` → the `refusal` text.
  - `max_tokens` → the text plus the `cutShort` note.
  - Chime with empty text → nothing sent, run done.
  - Web search citations → the last message contains `**>`.
  - Bakery `propose_bread_price` result → a card posted after the answer, replying to the answer id. A restart is simulated by calling `processRun` again with the stored run row (answered + cards [12]): no new sends. **(Review Focus 2)**
  - A crash after the step checkpoint and before the send: a new `processRun` with the stored row re-enters finalize **without** calling llm again and sends once.
  - `APIError(400,"MCP server bakery: 401 Unauthorized")` → the retry has no `mcp_servers`, the answer is sent, the `bakeryUnavailableNotice` is sent once, and the run is done. **(Review Focus 3)**
  - A generic error 3 times across 3 `processRun` calls → failed + `runFailed` sent once.
  - A 400 non-MCP error → failed immediately.
  - Lost lease (`saveCheckpoint` false, simulated by another owner claiming the run) → no send.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: checkpointed agent run loop`

### Task 11: Runner (per-chat claiming, lease heartbeat, typing, drain, recovery)

**Files:**
- Create: `src/agent/runner.ts`, `src/server/sweeper.ts`
- Test: `tests/agent/runner.test.ts`, `tests/server/sweeper.test.ts`

**Interfaces:**
- Produces:
  - `createRunner(deps: {db; tg; owner: string; leaseMs: number; renewMs: number; typingMs: number; now(): Date; process(run: RunRow): Promise<void>; setTimeout?; setInterval?}): Runner`
  - `Runner = {enqueue(chatId: number, delayMs?: number): void; stopAccepting(): void; drain(): Promise<void>; activeChats(): number[]}`
  - **`enqueue`:**
    - Unless stopped and no loop is running for that chat in this process, it starts `loop(chatId)` after `delayMs`.
    - `loop`: `while (run = claimNextRun(...))`:
      1. Start the heartbeat (`renewLease` every `renewMs`; a false return logs).
      2. Start typing (`sendChatAction(chatId,"typing",{message_thread_id})` every `typingMs`, errors logged).
      3. `await process(run)`.
      4. Stop both.
      5. If the run is still unfinished after `process` (a released lease for retry) → schedule `enqueue(chatId, attempts*30_000)` and break.
    - Loop errors are logged and the loop ends; the sweeper retries.
  - **`drain`:** resolves when all running loops finish.
  - **`sweep(deps:{db; runner; now}): Promise<void>`:** calls `runner.enqueue` for each id in `chatsWithPendingRuns`, then `pruneRuns(now-30d)` and `pruneUpdates(now-2d)`. `startSweeper(intervalMs=60_000)` returns a stop function.

- [ ] **Step 1: Write failing tests** (PGlite, `vi.useFakeTimers` where needed):
  - Two runs in one chat process sequentially in id order (the second `process` starts after the first resolves).
  - Runs in two chats run concurrently.
  - `enqueue` twice for the same chat while running → still one loop.
  - After `stopAccepting`, `enqueue` doesn't start anything; `drain` resolves after the in-flight `process` resolves.
  - Typing is sent at least twice during a `process` that takes 9 s of fake time with `typingMs` 4000.
  - A run left `running` with an expired lease (from a "crashed" owner) is picked up by `sweep`. **(Review Focus 1/2)**
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: per-chat runner with lease heartbeat and sweeper`

### Task 12: Auto-chime

**Files:**
- Create: `src/chime/{scheduler.ts,classifier.ts}`
- Test: `tests/chime/{scheduler,classifier}.test.ts`

**Interfaces:**
- Produces:
  - `classifyChime(deps:{llm}, input:{transcript: string; eagerness; bakery: boolean}): Promise<{chime: boolean; reason: string}|null>`:
    - Haiku `claude-haiku-5-5`, `max_tokens` 400, `output_config:{effort:"low", format:{type:"json_schema", schema:{type:"object", properties:{chime:{type:"boolean"}, reason:{type:"string"}}, required:["chime","reason"], additionalProperties:false}}}`, **no `fallbacks`**
    - the system prompt is the spec 6.4 rules plus an eagerness sentence; when `bakery` it adds that the bot can look up bakery breads, recipes, prices, costs and sales
    - parse the first text block and validate with zod; one retry on invalid output; then null and a log
  - `chimeTranscript(rows: StoredMessage[]): string`: lines `[HH:MM] Name: text [label]`, with bot rows as `Bot:`.
  - `createChimeScheduler(deps:{db; llm; now; debounceMs=30_000; cooldownMs=600_000; enqueueRun(chatId: number, trigger: RunTrigger): Promise<void>; setTimeout?; clearTimeout?}): {onHumanMessage(chatId: number): void; stop(): void}`
  - **On fire:** skip with a logged reason (`chime.skip {reason}`) for each of:
    - the group is inactive or chime is off
    - `hasActiveRun`
    - `lastBotMessageAt` is within the cooldown
    - the latest stored message is from the bot

    Otherwise:
    1. Take the last 30 rows (after `forgetBefore`) and classify (`bakery` = settings.bakery && bakery configured).
    2. Log `chime.decision {chime, reason}`.
    3. If chime → `enqueueRun(chatId, {type:"chime", messageId: lastRow.messageId, targetMessageId: lastRow.messageId, requesterId:null, requesterName:null})`. `enqueueRun` does `createRun` + `runner.enqueue`; it is wired in Task 13.

- [ ] **Step 1: Write failing tests**
  - 3 messages within 10 s, then 30 s of silence → exactly one classify call.
  - A bot message 5 min ago → skip `cooldown`, no classify.
  - An active run → skip.
  - Classifier `{chime:true}` → `enqueueRun` with `type:"chime"`.
  - Invalid JSON twice → null, no run.
  - The classify params have no `fallbacks` and have `output_config.effort === "low"`.
  - `bakery:true` puts "bakery" in the system prompt.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: debounced auto-chime with haiku classifier`

### Task 13: Startup, deploy ping, shutdown, wiring

**Files:**
- Create: `instrumentation.ts`, `src/server/{startup.ts,shutdown.ts,deploy-ping.ts}`
- Modify: `src/server/deps.ts` (wire runner, chime, bakery, loop, `onCallback`)
- Test: `tests/server/{deploy-ping,startup}.test.ts`

**Interfaces:**
- Produces:
  - `deployPing(deps:{db; tg; ownerId; sha?; message?}): Promise<boolean>`: no sha → false. If `casMeta("deploy_sha", sha)` → send the owner `just-a-chat-bot deployed {sha7}: {first line of message}` in plain text → true.
  - `startup(deps)`:
    1. `setWebhook("https://{PUBLIC_DOMAIN}/api/telegram", {secret_token, allowed_updates:["message","edited_message","callback_query","message_reaction","my_chat_member","chat_member"]})`, skipped with a log when there's no domain.
    2. `deployPing`.
    3. `sweep` once.
    4. `startSweeper`.
    5. `installShutdown`.

    Each step's failure is logged and doesn't block the others.
  - `installShutdown(runner, stops: (() => void)[])`: `process.once("SIGTERM"|"SIGINT")` → `runner.stopAccepting()`, stop the sweeper and chime timers, `await runner.drain()`, log `shutdown.done`, `process.exit(0)`.
  - `instrumentation.ts`: `export async function register(){ if (process.env.NEXT_RUNTIME==="nodejs" && process.env.NEXT_PHASE!=="phase-production-build") { const {startup} = await import("./src/server/startup"); await startup(); } }`. `startup()` uses `serverDeps()` and must not throw.
  - **`deps.ts` wiring:**
    - owner id: `RAILWAY_DEPLOYMENT_ID ?? random`
    - lease 120 s, renew 30 s, typing 4 s
    - `onCallback`: `handleBakeryCallback`; if it returns false, answer the callback with nothing, and log
    - language lookup from the group settings

- [ ] **Step 1: Write failing tests**
  - `deployPing` sends once for sha "abc", not again for "abc", and sends again for "def".
  - `startup` with a fake tg calls `setWebhook` with exactly those 6 `allowed_updates` and the secret.
  - A `setWebhook` failure still runs the deploy ping.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run** the tests + `npx tsc --noEmit && npx next build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: startup, deploy ping, graceful shutdown and wiring`

### Task 14: Mini App API

**Files:**
- Create:
  - `src/miniapp/{jwt.ts,auth.ts,service.ts}`
  - `app/api/miniapp/session/route.ts`, `app/api/miniapp/settings/route.ts`, `app/api/miniapp/forget/route.ts`
- Test: `tests/miniapp/{auth,service}.test.ts`

**Interfaces:**
- Produces:
  - `signSession({userId, chatId, owner: boolean, lang}, secret): Promise<string>` (HS256, 1 h) and `verifySession(token, secret)` → claims | null (jose).
  - `createSession(deps:{db; tg; env; now}, initData: string)` → `{token, ...}`, or `{error:"invalid"|"unknown_group"|"not_member"}` with HTTP 401/404/403. Steps:
    1. `verifyInitData` (1 h).
    2. `getGroupByToken(startParam)`, active only.
    3. `getChatMember(chatId, user.id)`, member-like statuses only.
    4. `owner = user.id === OWNER`; `lang = pickLang(user.languageCode)`.
  - `getSettingsView(deps, claims)`:
    - `{groupTitle, settings, models: ModelInfoLite[], emojis: REACTION_EMOJIS, isOwner, bakeryConfigured}`
    - `settings.bakery` is included only when `isOwner`
  - `updateSettings(deps, claims, patch: unknown)`:
    - zod partial of `GroupSettings`
    - a `bakery` key from a non-owner → 403
    - `model` must be in `getModels`; `effort` must be in that model's `efforts`, else it is set to the closest supported (`medium`, else the first)
    - logs `settings.changed {chatId, by, keys}`; returns the new view
  - `forgetHistory(deps, claims)`:
    1. `deleteChatMessages` → delete the returned Anthropic file ids via `llm` (best effort, logged).
    2. `deleteChatRuns` (finished only).
    3. `setForgetBefore(now)`.
    4. Log `settings.forget {chatId, by}`.
  - Routes read `Authorization: Bearer <jwt>` (initData goes only in the POST body of `session`). Responses are JSON; errors are `{error}` with the status code.

- [ ] **Step 1: Write failing tests**
  - Valid initData for a member → a token whose claims have the chatId.
  - Wrong `start_param` → `unknown_group`.
  - A `left` user → `not_member`.
  - A non-owner view lacks `bakery`.
  - A non-owner patch `{bakery:true}` → 403.
  - The owner patch `{bakery:true}` → saved.
  - Patch `{model:"claude-haiku-5-5", effort:"max"}` when haiku supports only low/medium/high → effort `"medium"`.
  - Patch `{historyWindow: 7}` → 400.
  - `forgetHistory` removes messages, keeps a running run, and sets `forgetBefore`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: mini app session and settings API`

### Task 15: Mini App UI

**Files:**
- Create: `app/settings/page.tsx`, `app/settings/SettingsApp.tsx` (client), `app/globals.css` (tokens)
- Modify: `app/layout.tsx` (Telegram script + RTL pre-hydration), `src/i18n/{en,he,ru}.ts` (Mini App keys)

**Interfaces:**
- Consumes: the Task 14 routes.
- **Before writing UI:** invoke the `frontend-design` skill (owner's CLAUDE.md rule). Mirror the look and tokens of `/Users/razielgershoni/development/just-a-list-manager`:
  - `app/globals.css` OKLCH tokens, light/dark following the device
  - the inline RTL pre-hydration script in `app/layout.tsx`
  - lucide icons; no shadcn dependency (plain Tailwind)
- **Behaviour:**
  1. On load, read `window.Telegram.WebApp.initData`, then `POST /api/miniapp/session`.
  2. Show a loading state; an error state per error code (`unknown_group`, `not_member`, `invalid`) with localized text.
  3. Then one page with sections:
     - **Model:** select of `models[].displayName`.
     - **Thinking effort:** segmented control, only the selected model's `efforts`.
     - **Auto-chime:** switch + eagerness segmented.
     - **Trigger reaction:** grid of `emojis`, selected highlighted.
     - **Bot language:** he/en/ru.
     - **Memory:** 50/100/200/400.
     - **Bakery:** switch, rendered only when `isOwner`; disabled with a note when `!bakeryConfigured`.
     - **Forget history:** danger button with an in-page confirm step.
  4. Each change `PUT`s immediately, with an inline saving/saved/error indicator. Failures revert the control and show a localized error.
- **Strings:** UI language comes from the viewer's `language_code` via `pickLang`; `dir="rtl"` for he. All strings go through `t()`. No emoji used as icons (the reaction grid is content, not icons). Inputs are ≥16px font (no iOS zoom). No horizontal overflow at 360px.
- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `npx tsc --noEmit && npx vitest run && npx next build`. Expected: PASS (the i18n completeness test covers the new keys).
- [ ] **Step 3: Check the page renders.** Run `npx next start` with dummy env, open `/settings` in a headless check (or `curl` for HTML that has the root element). Expected: no runtime error in the server log. Stop the server afterwards.
- [ ] **Step 4: Commit** `feat: settings mini app UI`

### Task 16: Railway IaC, docs, final gate

**Files:**
- Create: `.railway/railway.ts`, `README.md`, `CLAUDE.md`

**Interfaces:**
- **`.railway/railway.ts`:**
  - `service("just-a-chat-bot", { source: github("raziel-gershoni/just-a-chat-bot",{branch:"main"}), build:{builder:"RAILPACK", buildCommand:"npm run build"}, deploy:{startCommand:"node_modules/.bin/next start", preDeployCommand:["node_modules/.bin/drizzle-kit migrate"], healthcheckPath:"/api/health", healthcheckTimeout:120, restartPolicyType:"ON_FAILURE", restartPolicyMaxRetries:10, drainingSeconds:120} })`
  - `env`: literal `NEXT_MANUAL_SIG_HANDLE:"true"`, `NODE_ENV:"production"`, and `preserve()` for every secret env var from Task 1
  - wrapped in `project(<existing project name placeholder from env RAILWAY_PROJECT_NAME or "just-a-chat-bot">)`
  - verify it type-checks with `npx tsc --noEmit` (include `.railway` in tsconfig)
- **`README.md`:** what it is, setup steps (BotFather, Neon, Railway, env vars, applying IaC), how to run tests.
- **`CLAUDE.md`:** architecture map, gate commands, conventions (extensionless imports, PGlite tests, i18n rule, never store the bakery key, migrations via pre-deploy).
- [ ] **Step 1: Write the files.**
- [ ] **Step 2: Full gate:** `npx tsc --noEmit && npx vitest run && npx next build`. Expected: all pass.
- [ ] **Step 3: Commit** `chore: railway iac and docs`

---

## After the tasks (controller)
1. Run a whole-branch review on Opus covering security (initData, JWT, owner checks, secret handling), correctness against the spec, and the Review Focus list. Fix every valid finding and re-run the gate.
2. Push `main` to origin.
3. Publish the setup artifact (env vars, BotFather, Neon, Railway, IaC apply, first test).
4. Send a push notification.
