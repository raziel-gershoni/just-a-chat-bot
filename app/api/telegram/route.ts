import type { Update } from "grammy/types";
import { markUpdate, unmarkUpdate } from "@/src/db/repo/updates";
import type { Db } from "@/src/db/types";
import { serverDeps } from "@/src/server/deps";
import { errorText } from "@/src/util/errors";
import { log } from "@/src/util/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type WebhookDeps = {
  secret: string;
  db: Db;
  handle(update: Update): Promise<void>;
};

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Telegram redelivers an update until it gets a 2xx, so each update is marked as seen first
 * (a repeat answers 200 without being handled) and un-marked if handling fails (the 500 makes
 * Telegram redeliver, and the redelivery must be handled again).
 */
export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.headers.get(SECRET_HEADER) !== deps.secret) {
    log("webhook.unauthorized");
    return new Response("unauthorized", { status: 401 });
  }

  let update: Update;
  try {
    update = (await req.json()) as Update;
  } catch (err) {
    log("webhook.bad_json", { error: errorText(err) });
    return new Response("bad request", { status: 400 });
  }
  if (typeof update?.update_id !== "number") {
    log("webhook.bad_update");
    return new Response("bad request", { status: 400 });
  }

  try {
    if (!(await markUpdate(deps.db, update.update_id))) {
      log("webhook.duplicate", { update_id: update.update_id });
      return new Response("ok");
    }
  } catch (err) {
    log("webhook.mark_failed", { update_id: update.update_id, error: errorText(err) });
    return new Response("error", { status: 500 });
  }

  try {
    await deps.handle(update);
  } catch (err) {
    log("webhook.handle_failed", { update_id: update.update_id, error: errorText(err) });
    try {
      await unmarkUpdate(deps.db, update.update_id);
    } catch (unmarkErr) {
      log("webhook.unmark_failed", { update_id: update.update_id, error: errorText(unmarkErr) });
    }
    return new Response("error", { status: 500 });
  }
  return new Response("ok");
}

export async function POST(req: Request): Promise<Response> {
  return handleWebhook(req, serverDeps().webhook);
}
