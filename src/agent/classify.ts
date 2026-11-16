import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod";
import { errorText } from "../util/errors";
import { log } from "../util/log";
import type { Llm } from "./llm";

/** The cheap model for small yes/no decisions (auto-chime, whether a reply is meant for the bot). */
export const CLASSIFIER_MODEL = "claude-haiku-5-5";

function parse<T>(msg: BetaMessage, schema: z.ZodType<T>): T {
  const block = msg.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("no text block");
  return schema.parse(JSON.parse(block.text));
}

/**
 * A small JSON decision from the classifier model, validated against `schema`: one call plus one
 * retry when the call fails or the output is invalid; null when both fail. Logs `<event>_invalid`
 * per failed attempt and `<event>_failed` when giving up.
 */
export async function classifyJson<T>(
  llm: Pick<Llm, "classify">,
  p: {
    event: string;
    system: string;
    user: string;
    jsonSchema: Record<string, unknown>;
    schema: z.ZodType<T>;
    /** Added to the failure log lines (e.g. the run and chat ids). */
    logFields?: Record<string, unknown>;
  },
): Promise<T | null> {
  const params = {
    model: CLASSIFIER_MODEL,
    max_tokens: 400,
    system: p.system,
    messages: [{ role: "user" as const, content: p.user }],
    output_config: { effort: "low" as const, format: { type: "json_schema" as const, schema: p.jsonSchema } },
  };
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return parse(await llm.classify(params as never), p.schema);
    } catch (err) {
      lastError = errorText(err);
      log(`${p.event}_invalid`, { ...p.logFields, attempt, error: lastError });
    }
  }
  log(`${p.event}_failed`, { ...p.logFields, error: lastError });
  return null;
}
