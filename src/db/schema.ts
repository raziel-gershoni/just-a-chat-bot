import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const big = (name: string) => bigint(name, { mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type RunTrigger = {
  type: "mention" | "reply" | "reaction" | "chime";
  messageId: number;
  targetMessageId: number;
  requesterId: number | null;
  requesterName: string | null;
  emoji?: string;
};

export type RunSent = {
  answerIds: number[];
  answered: boolean;
  cards: number[];
  bakeryNoticeSent?: boolean;
};

export type RunSnapshot = {
  model: string;
  effort: string;
  maxTokens: number;
  thinking: boolean;
  fallbacks: boolean;
  bakery: "full" | "read" | null;
  system: string;
  context: string;
  messages: unknown[];
  pauseCount: number;
  startIndex: number;
  bakeryDropped?: boolean;
};

export type MessageMedia = {
  kind: "photo" | "pdf" | "sticker" | "other";
  fileId?: string;
  fileSize?: number;
  mime?: string;
  name?: string;
  label: string;
};

export type RunStatus = "queued" | "running" | "done" | "failed";

export const groups = pgTable("groups", {
  chatId: big("chat_id").primaryKey(),
  token: text("token").notNull().unique(),
  title: text("title").notNull(),
  active: boolean("active").notNull().default(true),
  // GroupSettings (Task 3) is validated at the edges; stored as plain JSON here.
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
  forgetBefore: ts("forget_before"),
  nextSeq: big("next_seq").notNull().default(1),
  adminHintSent: boolean("admin_hint_sent").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    chatId: big("chat_id").notNull(),
    messageId: big("message_id").notNull(),
    seq: big("seq").notNull(),
    threadId: big("thread_id"),
    fromId: big("from_id"),
    fromName: text("from_name").notNull(),
    isBot: boolean("is_bot").notNull().default(false),
    date: ts("date").notNull(),
    text: text("text").notNull().default(""),
    entities: jsonb("entities").$type<unknown[]>(),
    replyToId: big("reply_to_id"),
    media: jsonb("media").$type<MessageMedia>(),
    mediaGroupId: text("media_group_id"),
    anthropicFileId: text("anthropic_file_id"),
    reactionRunDone: boolean("reaction_run_done").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.messageId] }),
    index("messages_chat_seq_idx").on(t.chatId, t.seq),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chatId: big("chat_id").notNull(),
    threadId: big("thread_id"),
    trigger: jsonb("trigger").$type<RunTrigger>().notNull(),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    snapshot: jsonb("snapshot").$type<RunSnapshot>(),
    steps: integer("steps").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    sent: jsonb("sent")
      .$type<RunSent>()
      .notNull()
      .default(sql`'{"answerIds":[],"answered":false,"cards":[]}'::jsonb`),
    leaseOwner: text("lease_owner"),
    leaseUntil: ts("lease_until"),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("runs_chat_status_id_idx").on(t.chatId, t.status, t.id)],
);

export const processedUpdates = pgTable("processed_updates", {
  updateId: big("update_id").primaryKey(),
  at: ts("at").notNull().defaultNow(),
});

export const meta = pgTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const modelsCache = pgTable("models_cache", {
  id: integer("id").primaryKey(),
  fetchedAt: ts("fetched_at").notNull(),
  models: jsonb("models").$type<unknown>().notNull(),
});
