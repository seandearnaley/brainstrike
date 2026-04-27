-- Snapshot correction: 0008 now creates these defaults as expressions, but this
-- migration preserves the generated Drizzle manifest history.
ALTER TABLE "models" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE "providers" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE "providers" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
