import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  uniqueIndex,
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
  /**
   * `message`: a human message with no tag and no reply to the bot. The run first judges whether
   * it is meant for the bot and ends silently when it isn't.
   */
  type: "mention" | "reply" | "reaction" | "chime" | "message";
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
  /** How many answer parts are delivered (each recorded as it lands); a retry sends only the rest. */
  partsSent?: number;
  /** The sources message that follows the last part when it doesn't fit in it is delivered. */
  tailSent?: boolean;
  /** A reply or message run was judged to be meant for the bot, so a retry doesn't judge it again. */
  judged?: boolean;
};

export type RunSnapshot = {
  model: string;
  /** Null when the model has no effort setting (output_config.effort is then not sent). */
  effort: string | null;
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
  /** stop_reason of the last step, so a resumed run knows whether to call Claude again or finalize. */
  stopReason?: string | null;
};

export type MessageMedia = {
  kind: "photo" | "pdf" | "sticker" | "other";
  fileId?: string;
  fileSize?: number;
  mime?: string;
  name?: string;
  label: string;
};

/**
 * A copy of the message a reply replies to, as Telegram sends it along with the reply. Used when
 * that message isn't stored (bakery cards and notices, messages pruned or sent before the bot
 * joined).
 */
export type RepliedCopy = {
  fromName: string;
  /** Sent by this bot. */
  isBot: boolean;
  text: string;
  entities: unknown[] | null;
  /** Media label (e.g. "photo"), when it has media. */
  label: string | null;
  /** When it was sent (ISO): a copy of a message from before a "forget" stays forgotten. */
  date: string;
};

export type RunStatus = "queued" | "running" | "done" | "failed";

export const groups = pgTable("groups", {
  chatId: big("chat_id").primaryKey(),
  token: text("token").notNull().unique(),
  // The token of a row that migrateChat replaced (an update from the new supergroup was handled
  // before the move): settings links posted with it keep working.
  altToken: text("alt_token"),
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
    // The words of the replied-to message the sender selected (Telegram's `quote`), on a reply only.
    quote: text("quote"),
    repliedTo: jsonb("replied_to").$type<RepliedCopy>(),
    media: jsonb("media").$type<MessageMedia>(),
    mediaGroupId: text("media_group_id"),
    anthropicFileId: text("anthropic_file_id"),
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
  (t) => [
    index("runs_chat_status_id_idx").on(t.chatId, t.status, t.id),
    // One run per user trigger (a mention, a reply, or the first trigger-emoji reaction on a
    // message), so a redelivered or re-handled update never creates a second run. Chime runs
    // are not user triggers and are not covered.
    uniqueIndex("runs_user_trigger_uq")
      .on(t.chatId, sql`(${t.trigger}->>'type')`, sql`(${t.trigger}->>'messageId')`)
      .where(sql`${t.trigger}->>'type' <> 'chime'`),
  ],
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
