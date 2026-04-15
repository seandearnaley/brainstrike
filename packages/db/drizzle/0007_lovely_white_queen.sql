ALTER TABLE "file_records" ADD COLUMN "source_root_path" text;--> statement-breakpoint
CREATE INDEX "idx_file_records_source_root_path" ON "file_records" USING btree ("source_root_path");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_file_records_cache_identity" ON "file_records" USING btree ("embedding_set_id","source_root_path","path") WHERE "file_records"."embedding_set_id" IS NOT NULL AND "file_records"."source_root_path" IS NOT NULL;
