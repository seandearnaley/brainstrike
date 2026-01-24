CREATE TABLE "view_filter_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text DEFAULT 'file' NOT NULL,
	"includes" text[] DEFAULT '{}' NOT NULL,
	"excludes" text[] DEFAULT '{}' NOT NULL,
	"use_regex" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_view_filter_presets_sort_order" ON "view_filter_presets" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "idx_view_filter_presets_is_default" ON "view_filter_presets" USING btree ("is_default");