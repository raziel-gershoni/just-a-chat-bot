import { describe, expect, it } from "vitest";
import { messageToRow } from "@/src/bot/ingest";
import { groupMsg } from "../helpers/fixtures";

describe("messageToRow", () => {
  it("maps text, names and thread", () => {
    const row = messageToRow(groupMsg(5, 3, { from: { id: 10, is_bot: false, first_name: "A", last_name: "B" }, is_topic_message: true, message_thread_id: 77 }));
    expect(row).toMatchObject({ chatId: 5, messageId: 3, fromName: "A B", fromId: 10, threadId: 77, isBot: false, media: null });
  });
  it("ignores a reply-thread id outside a forum topic", () => {
    expect(messageToRow(groupMsg(5, 3, { message_thread_id: 77 })).threadId).toBeNull();
  });
  it("picks the largest photo", () => {
    const row = messageToRow(groupMsg(5, 3, { text: undefined, caption: "c", photo: [
      { file_id: "s", width: 10, height: 10, file_size: 1 }, { file_id: "l", width: 100, height: 100, file_size: 9 },
    ] }));
    expect(row.media).toMatchObject({ kind: "photo", fileId: "l" });
    expect(row.text).toBe("c");
  });
  it("maps a pdf", () => {
    const row = messageToRow(groupMsg(5, 3, { document: { file_id: "d", mime_type: "application/pdf", file_name: "a.pdf" } }));
    expect(row.media).toMatchObject({ kind: "pdf", fileId: "d", name: "a.pdf" });
  });
  it("labels a non-pdf document", () => {
    expect(messageToRow(groupMsg(5, 3, { document: { file_id: "d", mime_type: "text/plain" } })).media).toEqual({ kind: "other", label: "document" });
  });
  it("labels an animation, not a document", () => {
    expect(messageToRow(groupMsg(5, 3, { animation: { file_id: "a" }, document: { file_id: "a" } })).media).toEqual({ kind: "other", label: "animation" });
  });
  it("keeps a static sticker, labels an animated one", () => {
    expect(messageToRow(groupMsg(5, 3, { sticker: { file_id: "s", is_animated: false, is_video: false } })).media).toMatchObject({ kind: "sticker", fileId: "s" });
    expect(messageToRow(groupMsg(5, 3, { sticker: { file_id: "s", is_animated: true, is_video: false } })).media).toEqual({ kind: "other", label: "sticker" });
  });
  it("labels video, voice, audio", () => {
    expect(messageToRow(groupMsg(5, 3, { video: { file_id: "v" } })).media?.label).toBe("video");
    expect(messageToRow(groupMsg(5, 3, { voice: { file_id: "v" } })).media?.label).toBe("voice");
    expect(messageToRow(groupMsg(5, 3, { audio: { file_id: "v" } })).media?.label).toBe("audio");
  });
});
