CREATE TABLE "file_token_cache" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "file_token_cache_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"folder_id" text NOT NULL,
	"file_path" text NOT NULL,
	"content_hash" text NOT NULL,
	"file_size" text NOT NULL,
	"mtime_ms" text,
	"token_count" integer NOT NULL,
	"counting_mode" text NOT NULL,
	"model_encoding" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_file_token_cache_lookup" ON "file_token_cache" USING btree ("folder_id","file_path");--> statement-breakpoint
CREATE INDEX "idx_file_token_cache_hash" ON "file_token_cache" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_file_token_cache_folder" ON "file_token_cache" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "idx_file_token_cache_mode" ON "file_token_cache" USING btree ("folder_id","counting_mode");