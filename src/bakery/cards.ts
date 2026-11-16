import { t, type Lang } from "../i18n";
import { sendText } from "../telegram/send";
import type { TgApi } from "../telegram/types";
import { log } from "../util/log";
import type { BakeryApi } from "./api";
import type { ExtractedProposal } from "./proposals";

// Posts one card per proposal not in `already`: the bakery's own summary (fresh from the
// bakery, else the one in the propose result) with approve/reject buttons. Returns the ids
// posted. A send failure throws: the caller has persisted the earlier ids (it does so
// after each card), so a retry posts only what is missing.
export async function postCards(
  deps: { tg: TgApi; bakery: BakeryApi; lang: Lang },
  args: { chatId: number; threadId: number | null; replyTo: number; proposals: ExtractedProposal[]; already: number[] },
  onPosted?: (id: number) => Promise<void> | void,
): Promise<number[]> {
  const posted: number[] = [];
  for (const p of args.proposals) {
    if (args.already.includes(p.proposalId) || posted.includes(p.proposalId)) continue;
    const fetched = await deps.bakery.getProposal(p.proposalId);
    if (!fetched && p.summary) log("bakery.card_summary_fallback", { id: p.proposalId });
    const text = fetched?.summaryHe ?? p.summary;
    if (!text) {
      log("bakery.card_skipped_no_summary", { id: p.proposalId });
      continue;
    }
    const messageId = await sendText(deps.tg, args.chatId, text, {
      replyTo: args.replyTo,
      threadId: args.threadId,
      buttons: [[
        { text: t(deps.lang, "bakeryApprove"), data: `mcp:approve:${p.proposalId}` },
        { text: t(deps.lang, "bakeryReject"), data: `mcp:reject:${p.proposalId}` },
      ]],
    });
    posted.push(p.proposalId);
    log("bakery.card_posted", { id: p.proposalId, chat_id: args.chatId, message_id: messageId });
    await onPosted?.(p.proposalId);
  }
  return posted;
}
