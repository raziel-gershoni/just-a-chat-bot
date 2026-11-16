import type { BetaModelInfo } from "@anthropic-ai/sdk/resources/beta/models";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Llm } from "@/src/agent/llm";

export type FakeLlm = Llm & {
  /** Params of every stream() call, in order. */
  calls: BetaMessageStreamParams[];
  classifyCalls: BetaMessageStreamParams[];
  uploads: { name: string; mime: string }[];
  deleted: string[];
};

// Returns the scripted responses in order (an Error entry is thrown) and records the params.
export function fakeLlm(
  script: Array<BetaMessage | Error> = [],
  opts: { models?: BetaModelInfo[] | Error; classify?: Array<BetaMessage | Error> } = {},
): FakeLlm {
  const calls: BetaMessageStreamParams[] = [];
  const classifyCalls: BetaMessageStreamParams[] = [];
  const uploads: { name: string; mime: string }[] = [];
  const deleted: string[] = [];
  const classifyScript = [...(opts.classify ?? [])];
  const queue = [...script];
  const next = (q: Array<BetaMessage | Error>): BetaMessage => {
    const item = q.shift();
    if (!item) throw new Error("fakeLlm: script exhausted");
    if (item instanceof Error) throw item;
    return item;
  };
  return {
    calls,
    classifyCalls,
    uploads,
    deleted,
    async stream(params) {
      calls.push(params);
      return next(queue);
    },
    async classify(params) {
      classifyCalls.push(params);
      return next(classifyScript);
    },
    async upload(_buf, name, mime) {
      uploads.push({ name, mime });
      return `file_${uploads.length}`;
    },
    async deleteFile(id) {
      deleted.push(id);
    },
    async listModels() {
      const m = opts.models ?? [];
      if (m instanceof Error) throw m;
      return m;
    },
  };
}
