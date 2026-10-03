CREATE TABLE "object_access" (
	"object_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"reads" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "object_access_object_id_hour_pk" PRIMARY KEY("object_id","hour")
);
--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "last_accessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "last_hot_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "class_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "object_access" ADD CONSTRAINT "object_access_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "object_access_hour_idx" ON "object_access" USING btree ("hour");