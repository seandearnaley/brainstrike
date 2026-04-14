ALTER TABLE "file_records" ADD COLUMN "source_root_path" text;--> statement-breakpoint
CREATE INDEX "idx_file_records_source_root_path" ON "file_records" USING btree ("source_root_path");