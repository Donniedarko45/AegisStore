CREATE TABLE "multipart_parts" (
	"upload_id" uuid NOT NULL,
	"part_no" integer NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"node_ids" uuid[] NOT NULL,
	"entropy" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "multipart_parts_upload_id_part_no_pk" PRIMARY KEY("upload_id","part_no")
);
--> statement-breakpoint
CREATE TABLE "multipart_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid NOT NULL,
	"key" text NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"created_by" uuid,
	"node_ids" uuid[] NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"max_downloads" integer,
	"downloads" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "multipart_parts" ADD CONSTRAINT "multipart_parts_upload_id_multipart_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."multipart_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multipart_uploads" ADD CONSTRAINT "multipart_uploads_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multipart_uploads" ADD CONSTRAINT "multipart_uploads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "multipart_uploads_state_idx" ON "multipart_uploads" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "multipart_uploads_bucket_idx" ON "multipart_uploads" USING btree ("bucket_id");--> statement-breakpoint
CREATE INDEX "share_links_object_idx" ON "share_links" USING btree ("object_id");