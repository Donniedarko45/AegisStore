CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"dedupe_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "node_metrics" ADD COLUMN "risk_score" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "node_metrics" ADD COLUMN "uptime_sec" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "draining" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "risk_factors" jsonb;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "risk_state" jsonb;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "risk_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_active_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" IN ('QUEUED', 'RUNNING');--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","priority","run_after");--> statement-breakpoint
CREATE INDEX "jobs_created_idx" ON "jobs" USING btree ("created_at");