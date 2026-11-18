import { describe, expect, it } from "vitest";
import { messageToRow } from "@/src/bot/ingest";
import { BOT, groupMsg } from "../helpers/fixtures";

const BOT_ID = BOT.id;

describe("messageToRow", () => {
  it("maps text, names and thread", () => {
    const row = messageToRow(groupMsg(5, 3, { from: { id: 10, is_bot: false, first_name: "A", last_name: "B" }, is_topic_message: true, message_thread_id: 77 }), BOT_ID);
    expect(row).toMatchObject({ chatId: 5, messageId: 3, fromName: "A B", fromId: 10, threadId: 77, isBot: false, media: null });
  });
  it("ignores a reply-thread id outside a forum topic", () => {
    expect(messageToRow(groupMsg(5, 3, { message_thread_id: 77 }), BOT_ID).threadId).toBeNull();
  });
  it("keeps a copy of the replied-to message, marked as the bot's own only when this bot sent it", () => {
    const own = messageToRow(groupMsg(5, 3, { reply_to_message: groupMsg(5, 2, { from: BOT, text: "card text" }) }), BOT_ID);
    expect(own.repliedTo).toEqual({ fromName: BOT.first_name, isBot: true, text: "card text", entities: null, label: null, date: new Date((1_800_000_000 + 2) * 1000).toISOString() });
    const other = messageToRow(groupMsg(5, 3, { reply_to_message: groupMsg(5, 2, { from: { id: 77, is_bot: true, first_name: "Other" } }) }), BOT_ID);
    expect(other.repliedTo).toMatchObject({ fromName: "Other", isBot: false });
    const photo = messageToRow(groupMsg(5, 3, { reply_to_message: groupMsg(5, 2, { text: undefined, caption: "cake", photo: [{ file_id: "p", width: 1, height: 1 }] }) }), BOT_ID);
    expect(photo.repliedTo).toMatchObject({ text: "cake", label: "photo" });
    expect(messageToRow(groupMsg(5, 3), BOT_ID).repliedTo).toBeNull();
    const root = groupMsg(5, 9);
    expect(messageToRow(groupMsg(5, 3, { is_topic_message: true, message_thread_id: 9, reply_to_message: root }), BOT_ID).repliedTo).toBeNull();
  });
  it("keeps the quoted words of a reply; no reply, no quote", () => {
    const quote = { text: "just these words", position: 4, is_manual: true };
    expect(messageToRow(groupMsg(5, 3, { reply_to_message: groupMsg(5, 2), quote }), BOT_ID).quote).toBe("just these words");
    expect(messageToRow(groupMsg(5, 3, { reply_to_message: groupMsg(5, 2) }), BOT_ID).quote).toBeNull();
    // In a forum topic, the topic root is not a reply target, so there is nothing quoted either.
    const root = groupMsg(5, 9);
    expect(messageToRow(groupMsg(5, 3, { is_topic_message: true, message_thread_id: 9, reply_to_message: root, quote }), BOT_ID).quote).toBeNull();
  });
  it("picks the largest photo", () => {
    const row = messageToRow(groupMsg(5, 3, { text: undefined, caption: "c", photo: [
      { file_id: "s", width: 10, height: 10, file_size: 1 }, { file_id: "l", width: 100, height: 100, file_size: 9 },
    ] }), BOT_ID);
    expect(row.media).toMatchObject({ kind: "photo", fileId: "l" });
    expect(row.text).toBe("c");
  });
  it("maps a pdf", () => {
    const row = messageToRow(groupMsg(5, 3, { document: { file_id: "d", mime_type: "application/pdf", file_name: "a.pdf" } }), BOT_ID);
    expect(row.media).toMatchObject({ kind: "pdf", fileId: "d", name: "a.pdf" });
  });
  it("labels a non-pdf document", () => {
    expect(messageToRow(groupMsg(5, 3, { document: { file_id: "d", mime_type: "text/plain" } }), BOT_ID).media).toEqual({ kind: "other", label: "document" });
  });
  it("labels an animation, not a document", () => {
    expect(messageToRow(groupMsg(5, 3, { animation: { file_id: "a" }, document: { file_id: "a" } }), BOT_ID).media).toEqual({ kind: "other", label: "animation" });
  });
  it("keeps a static sticker, labels an animated one", () => {
    expect(messageToRow(groupMsg(5, 3, { sticker: { file_id: "s", is_animated: false, is_video: false } }), BOT_ID).media).toMatchObject({ kind: "sticker", fileId: "s" });
    expect(messageToRow(groupMsg(5, 3, { sticker: { file_id: "s", is_animated: true, is_video: false } }), BOT_ID).media).toEqual({ kind: "other", label: "sticker" });
  });
  it("labels video, voice, audio", () => {
    expect(messageToRow(groupMsg(5, 3, { video: { file_id: "v" } }), BOT_ID).media?.label).toBe("video");
    expect(messageToRow(groupMsg(5, 3, { voice: { file_id: "v" } }), BOT_ID).media?.label).toBe("voice");
    expect(messageToRow(groupMsg(5, 3, { audio: { file_id: "v" } }), BOT_ID).media?.label).toBe("audio");
  });
});
