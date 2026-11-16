import { jwtVerify, SignJWT } from "jose";
import type { Lang } from "../i18n";
import { errorText } from "../util/errors";
import { languageSchema } from "../settings/schema";
import { log } from "../util/log";

export type SessionClaims = { userId: number; chatId: number; owner: boolean; lang: Lang };


function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** HS256 session token, valid for 1 hour. */
export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key(secret));
}

/** The claims of a valid, unexpired token; null otherwise (logged: an expired token is the normal case). */
export async function verifySession(token: string, secret: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"] });
    const { userId, chatId, owner, lang } = payload;
    if (
      typeof userId !== "number" || typeof chatId !== "number" || typeof owner !== "boolean" ||
      typeof lang !== "string" || !languageSchema.safeParse(lang).success
    ) {
      log("miniapp.jwt_bad_claims");
      return null;
    }
    return { userId, chatId, owner, lang: lang as Lang };
  } catch (err) {
    log("miniapp.jwt_invalid", { error: errorText(err) });
    return null;
  }
}
