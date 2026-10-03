CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"bucket_id" uuid,
	"actor_id" uuid,
	"actor_label" text,
	"actor_type" text,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attack_start" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"protected_versions" integer DEFAULT 0 NOT NULL,
	"contained" boolean DEFAULT false NOT NULL,
	"notes" text,
	"recovery" jsonb,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buckets" ADD COLUMN "auto_lock" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "object_versions" ADD COLUMN "entropy" real;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_events_status_idx" ON "security_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "security_events_bucket_actor_idx" ON "security_events" USING btree ("bucket_id","actor_id");