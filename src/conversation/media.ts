import { setAnthropicFileId, type StoredMessage } from "../db/repo/messages";
import type { Db } from "../db/types";
import { fileUrl } from "../telegram/client";
import type { TgApi } from "../telegram/types";
import { errorText } from "../util/errors";
import { log } from "../util/log";

export type UploadDeps = {
  db: Db;
  tg: TgApi;
  token: string;
  fetch: typeof fetch;
  upload(buf: Buffer, name: string, mime: string): Promise<string>;
};

const MIME = { photo: "image/jpeg", sticker: "image/webp", pdf: "application/pdf" } as const;
const EXT = { photo: "jpg", sticker: "webp", pdf: "pdf" } as const;

/** The Anthropic file id for a media row, uploading it first when needed. Null on failure. */
export async function ensureUploaded(deps: UploadDeps, row: StoredMessage): Promise<string | null> {
  if (row.anthropicFileId) return row.anthropicFileId;
  const media = row.media;
  try {
    if (!media?.fileId || !(media.kind in MIME)) throw new Error("row has no uploadable media");
    const kind = media.kind as keyof typeof MIME;
    const file = await deps.tg.getFile(media.fileId);
    if (!file.file_path) throw new Error("getFile returned no file_path");
    const res = await deps.fetch(fileUrl(deps.token, file.file_path));
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const name = media.name ?? `${row.messageId}.${EXT[kind]}`;
    const id = await deps.upload(buf, name, MIME[kind]);
    await setAnthropicFileId(deps.db, row.chatId, row.messageId, id);
    return id;
  } catch (err) {
    log("media.upload_failed", { chatId: row.chatId, messageId: row.messageId, error: errorText(err) });
    return null;
  }
}
