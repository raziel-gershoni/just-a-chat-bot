import { getGroupByToken } from "../db/repo/groups";
import { pickLang } from "../i18n";
import { isDefiniteRefusal } from "../telegram/client";
import { verifyInitData } from "../telegram/initdata";
import { errorText } from "../util/errors";
import { log } from "../util/log";
import { signSession, verifySession, type SessionClaims } from "./jwt";
import type { MiniDeps } from "./service";

export type SessionError =
  | { error: "invalid"; status: 401 }
  | { error: "unknown_group"; status: 404 }
  | { error: "not_member"; status: 403 }
  /** Telegram couldn't answer the membership check right now; the page shows "try again". */
  | { error: "unavailable"; status: 502 };
export type SessionOk = { token: string; groupTitle: string; isOwner: boolean; lang: SessionClaims["lang"] };

// "unavailable" when Telegram couldn't answer (network, 429, 5xx): no session either way, so
// strangers never get in, but a real member is told to try again, not that they aren't one.
async function membership(deps: MiniDeps, chatId: number, userId: number): Promise<"member" | "not_member" | "unavailable"> {
  try {
    const m = await deps.tg.getChatMember(chatId, userId);
    if (m.status === "creator" || m.status === "administrator" || m.status === "member") return "member";
    return m.status === "restricted" && m.is_member ? "member" : "not_member";
  } catch (err) {
    const definite = isDefiniteRefusal(err);
    log("miniapp.member_check_failed", { chat_id: chatId, user_id: userId, definite, error: errorText(err) });
    return definite ? "not_member" : "unavailable";
  }
}

/** initData (+ start_param group token) -> a session token, after confirming the user is in the group. */
export async function createSession(deps: MiniDeps, initData: string): Promise<SessionOk | SessionError> {
  const data = verifyInitData(initData, deps.env.TELEGRAM_BOT_TOKEN, deps.now(), 3_600_000);
  if (!data) {
    log("miniapp.session_invalid_initdata");
    return { error: "invalid", status: 401 };
  }
  const group = data.startParam ? await getGroupByToken(deps.db, data.startParam) : null;
  if (!group?.active) {
    log("miniapp.session_unknown_group", {
      user_id: data.user.id,
      reason: !data.startParam ? "no_start_param" : group ? "inactive" : "no_group",
      chat_type: data.chatType,
    });
    return { error: "unknown_group", status: 404 };
  }
  const member = await membership(deps, group.chatId, data.user.id);
  if (member === "unavailable") return { error: "unavailable", status: 502 };
  if (member === "not_member") {
    log("miniapp.session_not_member", { chat_id: group.chatId, user_id: data.user.id });
    return { error: "not_member", status: 403 };
  }
  const claims: SessionClaims = {
    userId: data.user.id,
    chatId: group.chatId,
    owner: data.user.id === deps.env.TELEGRAM_OWNER_ID,
    lang: pickLang(data.user.languageCode),
  };
  const token = await signSession(claims, deps.env.JWT_SECRET);
  log("miniapp.session", { chat_id: group.chatId, user_id: claims.userId });
  return { token, groupTitle: group.title, isOwner: claims.owner, lang: claims.lang };
}

/** Claims from `Authorization: Bearer <jwt>`, or null. */
export async function claimsFromRequest(req: Request, secret: string): Promise<SessionClaims | null> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(header);
  return m ? verifySession(m[1]!, secret) : null;
}
