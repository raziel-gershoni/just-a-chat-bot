CREATE TABLE "groups" (
	"chat_id" bigint PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"title" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"settings" jsonb NOT NULL,
	"forget_before" timestamp with time zone,
	"next_seq" bigint DEFAULT 1 NOT NULL,
	"admin_hint_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"seq" bigint NOT NULL,
	"thread_id" bigint,
	"from_id" bigint,
	"from_name" text NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"entities" jsonb,
	"reply_to_id" bigint,
	"media" jsonb,
	"media_group_id" text,
	"anthropic_file_id" text,
	"reaction_run_done" boolean DEFAULT false NOT NULL,
	CONSTRAINT "messages_chat_id_message_id_pk" PRIMARY KEY("chat_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models_cache" (
	"id" integer PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"models" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"thread_id" bigint,
	"trigger" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"snapshot" jsonb,
	"steps" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent" jsonb DEFAULT '{"answerIds":[],"answered":false,"cards":[]}'::jsonb NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "messages_chat_seq_idx" ON "messages" USING btree ("chat_id","seq");--> statement-breakpoint
CREATE INDEX "runs_chat_status_id_idx" ON "runs" USING btree ("chat_id","status","id");