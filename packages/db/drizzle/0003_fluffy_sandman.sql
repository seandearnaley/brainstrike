CREATE TABLE "embedding_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_hash" text NOT NULL,
	"model_key" text NOT NULL,
	"embedding" vector NOT NULL,
	"dimensions" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"access_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_embedding_cache_content_model" ON "embedding_cache" USING btree ("content_hash","model_key");--> statement-breakpoint
CREATE INDEX "idx_embedding_cache_content_hash" ON "embedding_cache" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_embedding_cache_accessed_at" ON "embedding_cache" USING btree ("accessed_at");