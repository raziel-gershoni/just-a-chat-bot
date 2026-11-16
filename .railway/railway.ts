import { defineRailway, github, preserve, service } from "railway/iac";

// Applied by the owner with `railway config plan` / `railway config apply`.
// Railway deploys never read this file. Secret values stay in Railway:
// preserve() keeps whatever value the dashboard already holds.
//
// A named partial: the Railway project also runs other services from other repos, and a
// whole-project file deletes every resource it omits. A partial only manages (and only ever
// deletes) the resources it owns, so the owner's other services are never touched.
export const partial = "just-a-chat-bot";

export default defineRailway((ctx, project) => {
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
    // NODE_ENV is not set here: `next start` sets it, and a build-time NODE_ENV=production
    // could make the install skip the devDependencies `next build` needs.
    env: {
      NEXT_MANUAL_SIG_HANDLE: "true",
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

  // The linked project's own name, so applying never renames the owner's project.
  return project(ctx.projectName ?? "just-a-chat-bot", { resources: [bot] });
});
