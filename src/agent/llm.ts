import Anthropic, { toFile } from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { BetaModelInfo } from "@anthropic-ai/sdk/resources/beta/models";

export type Llm = {
  stream(params: BetaMessageStreamParams): Promise<BetaMessage>;
  classify(params: BetaMessageStreamParams): Promise<BetaMessage>;
  upload(buf: Buffer, name: string, mime: string): Promise<string>;
  deleteFile(id: string): Promise<void>;
  listModels(): Promise<BetaModelInfo[]>;
};

// Retries (maxRetries) are the SDK's; no timeouts of our own.
export function anthropicLlm(apiKey: string): Llm {
  const client = new Anthropic({ apiKey, maxRetries: 4 });
  const run = (p: BetaMessageStreamParams) => client.beta.messages.stream(p).finalMessage();
  return {
    stream: run,
    classify: run,
    async upload(buf, name, mime) {
      const f = await client.files.upload({ file: await toFile(buf, name, { type: mime }) });
      return f.id;
    },
    async deleteFile(id) {
      await client.files.delete(id);
    },
    async listModels() {
      const out: BetaModelInfo[] = [];
      for await (const m of client.beta.models.list()) out.push(m);
      return out;
    },
  };
}
