import { defineRailway, github, preserve, project, service } from "railway/iac";

// Applied by the owner with `railway config plan` / `railway config apply`.
// Railway deploys never read this file. Secret values stay in Railway:
// preserve() keeps whatever value the dashboard already holds.
export default defineRailway(() => {
  const bot = service("just-a-chat-bot", {
    source: github("raziel-gershoni/just-a-chat-bot", { branch: "main" }),
    build: { builder: "RAILPACK", buildCommand: "npm run build" },
    deploy: {
      startCommand: "node_modules/.bin/next start",
      preDeployCommand: ["node_modules/.bin/drizzle-kit migrate"],
      healthcheckPath: "/api/health",
      healthcheckTimeout: 120,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      drainingSeconds: 120,
    },
    env: {
      NEXT_MANUAL_SIG_HANDLE: "true",
      NODE_ENV: "production",
      TELEGRAM_BOT_TOKEN: preserve(),
      TELEGRAM_WEBHOOK_SECRET: preserve(),
      TELEGRAM_OWNER_ID: preserve(),
      TELEGRAM_MINIAPP_SHORT_NAME: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      DATABASE_URL: preserve(),
      JWT_SECRET: preserve(),
      BAKERY_URL: preserve(),
      BAKERY_MCP_KEY: preserve(),
    },
  });

  return project(process.env.RAILWAY_PROJECT_NAME ?? "just-a-chat-bot", { resources: [bot] });
});
