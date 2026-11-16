# just-a-chat-bot

A Claude-powered Telegram group bot. It reads every message in the groups it is in and replies when it is mentioned, replied to, or when someone reacts with the trigger emoji. It can also chime in on its own (optional). It can search and fetch web pages, and it can talk to the bakery MCP server, where changes are shown as proposal cards that only the owner can approve with buttons. A Telegram Mini App lets group admins change each group's settings.

One always-on Next.js 16 server on Railway, Neon Postgres, no queue service. Design: `docs/superpowers/specs/2026-11-15-group-chat-bot-design.md`.

## Setup

1. **BotFather**
   - `/newbot`, keep the token.
   - `/setprivacy` -> Disable (the bot must see all group messages).
   - `/setjoingroups` -> Enable.
   - `/newapp` for the Mini App with short name `settings` (URL: `https://<your-railway-domain>/settings`).
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
   | `TELEGRAM_MINIAPP_SHORT_NAME` | `settings` |
   | `ANTHROPIC_API_KEY` | Anthropic API key |
   | `DATABASE_URL` | Neon connection string |
   | `JWT_SECRET` | at least 32 random characters |
   | `BAKERY_URL`, `BAKERY_MCP_KEY` | optional; create the key in the bakery app |

   `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_GIT_COMMIT_SHA` and `RAILWAY_GIT_COMMIT_MESSAGE` are set by Railway.
5. **Apply the IaC** (needs Railway CLI 5.42.1+), from the directory linked to your Railway project:
   ```bash
   railway config plan
   railway config apply
   ```
   `.railway/railway.ts` sets build, pre-deploy migration, start command, healthcheck, restart policy and draining. Secrets are declared with `preserve()`, so the values you set in the dashboard are kept. Set `RAILWAY_PROJECT_NAME` if your project is not called `just-a-chat-bot`.
6. Add the bot to your group **as admin**. On the next deploy it registers the webhook and pings you.

## Tests and gate

```bash
npx tsc --noEmit
npx vitest run
npx next build
```

Tests use PGlite (in-process Postgres) with the real migrations and hand-written fakes for Claude, Telegram and the bakery. They never touch a live service and need no secrets.

Never run `drizzle-kit migrate` against prod from your machine; Railway runs it before each deploy.
