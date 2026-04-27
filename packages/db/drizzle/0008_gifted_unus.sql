CREATE TABLE IF NOT EXISTS "collection_indexing_stats" (
	"embedding_set_id" text PRIMARY KEY NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"embedded_chunk_count" integer DEFAULT 0 NOT NULL,
	"pending_chunk_count" integer DEFAULT 0 NOT NULL,
	"dirty" boolean DEFAULT false NOT NULL,
	"last_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tagline" text,
	"best_for" jsonb,
	"icon" text,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"capabilities" jsonb,
	"parameters" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
DROP TABLE "model_registry" CASCADE;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_collection_indexing_stats_dirty" ON "collection_indexing_stats" USING btree ("dirty","last_refreshed_at");--> statement-breakpoint
CREATE INDEX "idx_models_provider_id" ON "models" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_models_sort_order" ON "models" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "idx_providers_sort_order" ON "providers" USING btree ("sort_order");
