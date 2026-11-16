/**
 * A message's text as a model should read it. Tagging a member who has no username inserts only
 * their name (a `text_mention` entity links it to the user), so in plain text the tag looks like
 * an ordinary word. Each such span gets an "@", so it reads as a tag like an @username does.
 * Entity offsets are UTF-16 code units, as JS strings index. Malformed entities are skipped.
 */
export function textWithTags(text: string, entities: unknown[] | null): string {
  if (!entities?.length) return text;
  const starts = entities
    .filter(
      (e): e is { type: string; offset: number; length: number } =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: unknown }).type === "text_mention" &&
        Number.isInteger((e as { offset?: unknown }).offset) &&
        Number.isInteger((e as { length?: unknown }).length),
    )
    .map((e) => e.offset)
    .filter((o) => o >= 0 && o < text.length && text[o] !== "@")
    .sort((a, b) => b - a);
  let out = text;
  for (const o of new Set(starts)) out = `${out.slice(0, o)}@${out.slice(o)}`;
  return out;
}
