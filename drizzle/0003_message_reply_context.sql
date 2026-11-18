ALTER TABLE "messages" ADD COLUMN "quote" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "replied_to" jsonb;