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
    VALUES
      (
        'TypeScript/JavaScript',
        'Source files for TypeScript and JavaScript projects',
        'file-code',
        ARRAY['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'],
        ARRAY['node_modules', 'dist', 'build', '.next', 'coverage', '*.test.*', '*.spec.*'],
        FALSE,
        TRUE,
        1
      ),
      (
        'All Code',
        'All programming language source files',
        'code',
        ARRAY['*.ts', '*.tsx', '*.js', '*.jsx', '*.py', '*.rs', '*.go', '*.java', '*.c', '*.cpp', '*.h', '*.hpp', '*.cs', '*.rb', '*.php', '*.swift', '*.kt'],
        ARRAY['node_modules', 'dist', 'build', 'target', '__pycache__', '.git', 'vendor'],
        FALSE,
        TRUE,
        2
      ),
      (
        'Documentation',
        'Markdown and documentation files',
        'file-text',
        ARRAY['*.md', '*.mdx', '*.txt', '*.rst', 'README*', 'LICENSE*', 'CHANGELOG*'],
        ARRAY['node_modules', '.git'],
        FALSE,
        TRUE,
        3
      ),
      (
        'Config Files',
        'Configuration and environment files',
        'settings',
        ARRAY['*.json', '*.yaml', '*.yml', '*.toml', '*.ini', '*.env*', '*.config.*', 'tsconfig*', 'package.json', 'Cargo.toml'],
        ARRAY['node_modules', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
        FALSE,
        TRUE,
        4
      ),
      (
        'Styles',
        'CSS and styling files',
        'palette',
        ARRAY['*.css', '*.scss', '*.sass', '*.less', '*.styl', '*.styled.*'],
        ARRAY['node_modules', 'dist'],
        FALSE,
        TRUE,
        5
      ),
      (
        'Tests',
        'Test files only',
        'flask-conical',
        ARRAY['*.test.*', '*.spec.*', '**/__tests__/**', '**/tests/**', '**/test/**'],
        ARRAY['node_modules', 'coverage'],
        FALSE,
        TRUE,
        6
      ),
      (
        'All Files',
        'Show all files without filtering',
        'folder-open',
        ARRAY['*'],
        ARRAY['node_modules', '.git', 'dist', 'build'],
        FALSE,
        TRUE,
        7
      );
  `,
  version: 27,
};
