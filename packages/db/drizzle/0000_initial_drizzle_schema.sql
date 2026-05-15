CREATE TABLE "embedding_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_key" text NOT NULL,
	"model_id" text NOT NULL,
	"dimensions" integer NOT NULL,
	"distance" text DEFAULT 'cosine',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text,
	"description" text,
	"tags" text,
	"category" text,
	"allow_duplicates" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "file_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_record_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text,
	"token_count" integer,
	"chunk_type" text,
	"chunk_size" integer,
	"start_line" integer,
	"end_line" integer,
	"start_offset" integer,
	"end_offset" integer,
	"embedding" vector,
	"embedding_set_id" uuid,
	"embedding_updated_at" timestamp with time zone,
	"embedding_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content" text,
	"content_hash" text,
	"token_count" integer,
	"processed_at" timestamp with time zone,
	"embedding_set_id" uuid,
	"chunks_processed_at" timestamp with time zone,
	"chunks_count" integer,
	"chunking_strategy" text
);
--> statement-breakpoint
CREATE TABLE "job_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue" text NOT NULL,
	"job_type" text NOT NULL,
	"payload" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"backoff_ms" integer DEFAULT 1000 NOT NULL,
	"lease_token" text,
	"leased_until" timestamp with time zone,
	"worker_id" text,
	"dedupe_key" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_key" text NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text,
	"provider" text,
	"dimensions" integer,
	"max_tokens" integer,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_registry_model_key_unique" UNIQUE("model_key")
);
--> statement-breakpoint
CREATE TABLE "token_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_path" text NOT NULL,
	"content_hash" text NOT NULL,
	"token_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_file_record_id_file_records_id_fk" FOREIGN KEY ("file_record_id") REFERENCES "public"."file_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_file_chunks_file_record_id" ON "file_chunks" USING btree ("file_record_id");--> statement-breakpoint
CREATE INDEX "idx_file_chunks_embedding_set_id" ON "file_chunks" USING btree ("embedding_set_id");--> statement-breakpoint
CREATE INDEX "idx_file_chunks_content_hash" ON "file_chunks" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_file_records_path" ON "file_records" USING btree ("path");--> statement-breakpoint
CREATE INDEX "idx_file_records_content_hash" ON "file_records" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_file_records_embedding_set_id" ON "file_records" USING btree ("embedding_set_id");--> statement-breakpoint
CREATE INDEX "idx_job_queue_state_run_at" ON "job_queue" USING btree ("state","run_at");--> statement-breakpoint
CREATE INDEX "idx_job_queue_dedupe_key" ON "job_queue" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_job_queue_leased_until" ON "job_queue" USING btree ("leased_until");--> statement-breakpoint
CREATE INDEX "idx_model_registry_model_key" ON "model_registry" USING btree ("model_key");--> statement-breakpoint
CREATE INDEX "idx_token_cache_file_path" ON "token_cache" USING btree ("file_path");--> statement-breakpoint
CREATE INDEX "idx_token_cache_content_hash" ON "token_cache" USING btree ("content_hash");
