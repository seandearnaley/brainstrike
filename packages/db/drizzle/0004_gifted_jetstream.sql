-- Rollback: drop selection_snapshot_files and selection_snapshots (see 0004_gifted_jetstream_down.sql).
CREATE TABLE "selection_snapshot_files" (
	"snapshot_id" uuid NOT NULL,
	"file_path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "selection_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "selection_snapshot_files" ADD CONSTRAINT "selection_snapshot_files_snapshot_id_selection_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."selection_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_selection_snapshot_files_snapshot_id" ON "selection_snapshot_files" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "idx_selection_snapshot_files_file_path" ON "selection_snapshot_files" USING btree ("file_path");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_selection_snapshot_files_unique" ON "selection_snapshot_files" USING btree ("snapshot_id","file_path");--> statement-breakpoint
CREATE INDEX "idx_selection_snapshots_created_at" ON "selection_snapshots" USING btree ("created_at");
