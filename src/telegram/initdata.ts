// Telegram Mini App initData verification (HMAC-SHA256, per Telegram's WebApp spec).
// This is the auth boundary: a valid result means the request genuinely came from this
// bot's Mini App for the returned Telegram user.
import { createHmac, timingSafeEqual } from "node:crypto";
import { log } from "../util/log";
import { errorText } from "../util/errors";

const DEFAULT_MAX_AGE_MS = 3_600_000;

export type InitDataResult = {
  user: { id: number; firstName: string; languageCode?: string };
  startParam: string | null;
};

export function verifyInitData(
  initData: string, botToken: string, now: Date, maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): InitDataResult | null {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  // data_check_string: every field except `hash`, "key=value", sorted by key, joined by
  // "\n" (URLSearchParams yields URL-decoded values, which is what Telegram signs).
  const pairs: string[] = [];
  for (const [k, v] of params.entries()) if (k !== "hash") pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = createHmac("sha256", secret).update(pairs.join("\n")).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== computed.length || !timingSafeEqual(computed, given)) return null;

  if (!params.has("auth_date")) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) return null;
  if (now.getTime() - authDate * 1000 >= maxAgeMs) return null;

  const userJson = params.get("user");
  if (!userJson) return null;
  let user: { id?: unknown; first_name?: unknown; language_code?: unknown };
  try {
    user = JSON.parse(userJson);
  } catch (err) {
    log("initdata.bad_user_json", { error: errorText(err) });
    return null;
  }
  const id = Number(user.id);
  if (!Number.isSafeInteger(id)) return null;
  return {
    user: {
      id,
      firstName: typeof user.first_name === "string" ? user.first_name : "",
      ...(typeof user.language_code === "string" ? { languageCode: user.language_code } : {}),
    },
    startParam: params.get("start_param") || null,
  };
}
