import type { Update } from "grammy/types";
import { isUpdateSeen, markUpdate } from "@/src/db/repo/updates";
import type { Db } from "@/src/db/types";
import { serverDeps } from "@/src/server/deps";
import type { Inflight } from "@/src/server/inflight";
import { errorText } from "@/src/util/errors";
import { log } from "@/src/util/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type WebhookDeps = {
  secret: string;
  db: Db;
  handle(update: Update): Promise<void>;
  /** Counts handlers in flight so shutdown can wait for them. */
  inflight?: Inflight;
};

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Telegram redelivers an update until it gets a 2xx. Handling is idempotent (a message is
 * stored once, a user trigger has at most one run), so an update is marked as seen only AFTER
 * it was handled: a failure answers 500 and leaves it unmarked, and the redelivery is handled
 * again. The mark is only a fast path that skips repeats of an update already handled.
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
  const id = update.update_id;
  const track = <T>(fn: () => Promise<T>) => (deps.inflight ? deps.inflight.track(fn) : fn());

  return track(async () => {
    try {
      if (await isUpdateSeen(deps.db, id)) {
        log("webhook.duplicate", { update_id: id });
        return new Response("ok");
      }
    } catch (err) {
      // Handling is idempotent, so going on without the fast path is safe.
      log("webhook.seen_check_failed", { update_id: id, error: errorText(err) });
    }

    try {
      await deps.handle(update);
    } catch (err) {
      log("webhook.handle_failed", { update_id: id, error: errorText(err) });
      return new Response("error", { status: 500 });
    }

    try {
      await markUpdate(deps.db, id);
    } catch (err) {
      // Handled already: a redelivery is handled again harmlessly, so still answer 200.
      log("webhook.mark_failed", { update_id: id, error: errorText(err) });
    }
    return new Response("ok");
  });
}

export async function POST(req: Request): Promise<Response> {
  return handleWebhook(req, serverDeps().webhook);
}
