import { DEFAULT_VIEW_FILTER_PRESETS } from '@brainstrike/types';
import type { Migration } from './migration-runner';

/**
 * Migration 027: Add view filter presets table
 *
 * This table stores user-defined and default presets for file filtering
 * in the file explorer. Presets define include/exclude patterns with
 * optional regex support.
 */
export const migration027ViewFilterPresets: Migration = {
  down: `
    DROP TABLE IF EXISTS view_filter_presets;
  `,
  ledgerKey: 'custom-027-view-filter-presets-seed',
  name: 'view_filter_presets',
  up: `
    -- View filter presets table
    CREATE TABLE IF NOT EXISTS view_filter_presets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT NOT NULL DEFAULT 'file',
      includes TEXT[] NOT NULL DEFAULT '{}',
      excludes TEXT[] NOT NULL DEFAULT '{}',
      use_regex BOOLEAN NOT NULL DEFAULT FALSE,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Index for sorting and default preset lookup
    CREATE INDEX IF NOT EXISTS idx_view_filter_presets_sort_order
      ON view_filter_presets (sort_order);
    CREATE INDEX IF NOT EXISTS idx_view_filter_presets_is_default
      ON view_filter_presets (is_default);

    -- Seed default presets
    INSERT INTO view_filter_presets (name, description, icon, includes, excludes, use_regex, is_default, sort_order)
    VALUES ${DEFAULT_VIEW_FILTER_PRESETS.map(
      (preset) =>
        `(${[
          quote(preset.name),
          quote(preset.description),
          quote(preset.icon),
          array(preset.includes),
          array(preset.excludes),
          String(preset.useRegex),
          String(preset.isDefault),
          String(preset.sortOrder),
        ].join(',')})`
    ).join(',')};
  `,
  version: 27,
};

function quote(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}
function array(values: readonly string[]): string {
  return `ARRAY[${values.map(quote).join(',')}]::TEXT[]`;
}
