/** The bot's Telegram names: `firstName` is its display name (set in BotFather), `username` its handle. */
export type BotIdentity = { username: string; firstName: string };

// People rarely write a bot's name the way BotFather has it: they shorten it, write it in their
// own alphabet, or just say "bot". Every model that reads the chat is told so. Names are
// JSON-quoted, so they read as data.
const ANY_FORM =
  "in any language or script (transliterated, e.g. written in Hebrew or Cyrillic letters, or translated), shortened to part of it, misspelled, as a nickname, by its @username, or simply as \"bot\"";

/** For the classifiers that watch the chat on the assistant's behalf. */
export function assistantNameLine(bot: BotIdentity): string {
  return `The assistant is called ${JSON.stringify(bot.firstName)} (@${bot.username}). People may write its name ${ANY_FORM}; each of these means the assistant.`;
}

/** For the answering model's per-run context. */
export function ownNameLine(bot: BotIdentity): string {
  return `Your name: ${JSON.stringify(bot.firstName)} (@${bot.username}). People may write it ${ANY_FORM}; each of these means you.`;
}
