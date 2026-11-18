# just-a-chat-bot

A Claude-powered Telegram group bot. It reads every message in the groups it is in and replies when it is mentioned, replied to, or when someone reacts with the trigger emoji, and also to an untagged message that is clearly meant for it (its name in any language, or a follow-up to its answer). It can also chime in on its own (optional). It can search and fetch web pages, and it can talk to the bakery MCP server, where changes are shown as proposal cards that only the owner can approve with buttons. A Telegram Mini App lets any member of a group change that group's settings (only the owner sees the bakery switch).

One always-on Next.js 16 server on Railway, Neon Postgres, no queue service. Design: `docs/superpowers/specs/2026-11-15-group-chat-bot-design.md`.

## Setup

1. **BotFather**
   - `/newbot`, keep the token.
   - `/setprivacy` -> Disable (the bot must see all group messages).
   - `/setjoingroups` -> Enable.
   - Bot Settings -> Mini Apps -> **Main App**: enable it with URL `https://<your-railway-domain>`. The group's settings button opens it (`https://t.me/<bot>?startapp=<group token>`). No direct link (`/newapp`) is needed.
2. **Neon**: create a project and copy the pooled connection string (`DATABASE_URL`).
3. **Railway**
   - Create a project and a service linked to this GitHub repo (branch `main`), then generate a public domain.
   - Set the env vars below in the service.
4. **Env vars** (see `.env.example`)

   | Variable | Notes |
   | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | from BotFather |
   | `TELEGRAM_WEBHOOK_SECRET` | any random string |
   | `TELEGRAM_OWNER_ID` | your numeric Telegram user id |
   | `ANTHROPIC_API_KEY` | Anthropic API key |
   | `DATABASE_URL` | Neon connection string |
   | `JWT_SECRET` | at least 32 random characters |
   | `BAKERY_URL`, `BAKERY_MCP_KEY` | optional; create the key in the bakery app |

   `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_GIT_COMMIT_SHA` and `RAILWAY_GIT_COMMIT_MESSAGE` are set by Railway.
5. **Apply the IaC.** Install the Railway CLI with `brew install railway` (not `npx railway`: that runs the IaC SDK's own bin, not the CLI). Then, from the directory linked to your Railway project:
   ```bash
   railway config plan
   railway config apply
   ```
   `.railway/railway.ts` sets build, pre-deploy migration, start command, healthcheck, restart policy and draining. Secrets are declared with `preserve()`, so the values you set in the dashboard are kept. It is a named partial (`export const partial = "just-a-chat-bot"`), so it only manages, and only ever deletes, the resources it owns; your other services in the same project are left alone. **Before `apply`, read the `plan` output:** it must only touch the `just-a-chat-bot` service, with no deletions and no project rename.
6. Open the bot in a private chat and press **Start**. Telegram only lets a bot message you after that, and the deploy ping is a private message.
7. Add the bot to your group **as admin**. On the next deploy it registers the webhook and pings you.

## Tests and gate

```bash
npx tsc --noEmit
npx vitest run
npx next build
```

Tests use PGlite (in-process Postgres) with the real migrations and hand-written fakes for Claude, Telegram and the bakery. They never touch a live service and need no secrets.

Never run `drizzle-kit migrate` against prod from your machine; Railway runs it before each deploy.
