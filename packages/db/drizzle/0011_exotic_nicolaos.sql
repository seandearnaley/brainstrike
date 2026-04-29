CREATE TABLE "file_relationships" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"relationship_type" text NOT NULL,
	"metadata" jsonb,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_chunks" DROP CONSTRAINT IF EXISTS "file_chunks_file_record_id_file_records_id_fk";--> statement-breakpoint
ALTER TABLE "embedding_sets" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "embedding_sets" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "embedding_sets" ALTER COLUMN "created_at" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "embedding_sets" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE "file_chunks" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "file_chunks" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "file_chunks" ALTER COLUMN "file_record_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "file_chunks" ALTER COLUMN "embedding_set_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "file_chunks" ALTER COLUMN "embedding_updated_at" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "file_chunks" ALTER COLUMN "created_at" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "file_chunks" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE "file_chunks" ALTER COLUMN "updated_at" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "file_chunks" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE "file_records" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "file_records" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "file_records" ALTER COLUMN "created_at" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "file_records" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE "file_records" ALTER COLUMN "updated_at" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "file_records" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE "file_records" ALTER COLUMN "processed_at" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "file_records" ALTER COLUMN "embedding_set_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "file_records" ALTER COLUMN "chunks_processed_at" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "file_token_cache" ALTER COLUMN "file_size" SET DATA TYPE bigint USING "file_size"::bigint;--> statement-breakpoint
ALTER TABLE "file_token_cache" ALTER COLUMN "mtime_ms" SET DATA TYPE bigint USING "mtime_ms"::bigint;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "payload" SET DATA TYPE jsonb USING "payload"::jsonb;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "run_at" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "run_at" SET DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "max_attempts" SET DEFAULT 5;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "backoff_ms" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "leased_until" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "created_at" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "updated_at" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "job_queue" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_file_record_id_file_records_id_fk" FOREIGN KEY ("file_record_id") REFERENCES "public"."file_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_relationships" ADD CONSTRAINT "file_relationships_source_id_file_records_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."file_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_relationships" ADD CONSTRAINT "file_relationships_target_id_file_records_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."file_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_tags" ADD CONSTRAINT "file_tags_file_id_file_records_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_file_relationships_source" ON "file_relationships" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_file_relationships_target" ON "file_relationships" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "idx_file_relationships_type" ON "file_relationships" USING btree ("relationship_type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_file_tags_unique" ON "file_tags" USING btree ("file_id","tag");--> statement-breakpoint
CREATE INDEX "idx_file_tags_tag" ON "file_tags" USING btree ("tag");
