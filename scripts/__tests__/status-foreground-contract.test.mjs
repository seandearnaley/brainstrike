// This guard finds raw palette regressions in audited consumers. Semantic token
// contrast (all four modes, surfaces and tints) is measured by
// semantic-status-contrast.test.mjs; semantic-theme-contract.test.mjs compiles
// both real app @theme mappings, including success/info and fill utilities.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { it } from 'node:test';
import { contrastRatio, hslToRgb } from '../lib/color-contrast.mjs';
import { collectForegroundViolations, parsePalette } from '../lib/foreground-contrast.mjs';
import { themeModes } from '../lib/semantic-theme-contract.mjs';
import { staticColorClasses } from '../lib/static-color-classes.mjs';

const root = join(import.meta.dirname, '..', '..');
const require = createRequire(join(root, 'packages/ui/package.json'));
const palette = parsePalette(readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8'));
const light = themeModes(readFileSync(join(root, 'packages/ui/src/globals.css'), 'utf8')).light;
const surfaces = Object.fromEntries(
  ['background', 'card', 'muted'].map((name) => [
    name,
    hslToRgb(light.get(`--bs-${name}`).replaceAll('%', '').split(/\s+/).map(Number)),
  ])
);
const paths = [
  'packages/app-shell/src/changes/ui/changed-files-tree-columns.tsx',
  'packages/app-shell/src/git-panel/git-changes-view.tsx',
  'packages/app-shell/src/prompt-workbench-builder-dialog.tsx',
  'packages/app-shell/src/prompt-workbench-panel.tsx',
  'packages/assistant-ui/src/run-verdict-control.tsx',
  'packages/assistant-ui/src/todo-progress.tsx',
  'packages/db-explorer/src/components/embedding-coverage-notice.tsx',
  'packages/db-explorer/src/components/import-progress-bar.tsx',
  'packages/file-explorer-ui/src/components/watcher-health-chip.tsx',
  'packages/file-explorer-ui/src/file-explorer-error-boundary.tsx',
  'packages/file-explorer-ui/src/indexing/token-meter.tsx',
  'packages/file-explorer-ui/src/indexing/token-summary-bar.tsx',
  'packages/file-explorer-ui/src/preview/preview-panel-summary.tsx',
  'packages/file-explorer-ui/src/shell/breadcrumb-mini-tree.tsx',
  'packages/file-explorer-ui/src/shell/file-tab-status-screens.tsx',
  'packages/file-explorer-ui/src/shell/workspace-tab-strip.tsx',
  'packages/settings-ui/src/settings/providers/provider-card.tsx',
  'packages/settings-ui/src/settings/providers/provider-test-connection.tsx',
  'packages/settings-ui/src/settings/secrets/credential-inventory/credential-oauth-actions.tsx',
  'packages/settings-ui/src/settings/secrets/credential-inventory/credential-row.tsx',
  'packages/settings-ui/src/settings/secrets/environment/environment-section.tsx',
  'packages/settings-ui/src/settings/tools/mcp-config-alert.tsx',
  'packages/settings-ui/src/settings/tools/tool-group-accordion.tsx',
  'packages/settings-ui/src/settings/tools/tool-playground.tsx',
  'packages/settings-ui/src/settings/tools/tool-row.tsx',
  'packages/ui/src/collection-browser/search-config-panel.tsx',
  'packages/ui/src/collection-picker/collection-picker-item.tsx',
  'packages/vector-management/src/queue-diagnostics-panel.tsx',
  'packages/vector-management/src/queue-hud.tsx',
  'packages/vector-management/src/queue-status-popover.tsx',
  'packages/ui/src/collection-browser/types.ts',
];

// These icons identify authoring tools/favorites, not status; adjacent text or
// labelled controls carry their meaning. Keep exact counts so exceptions expire.
const decorative = [
  ['packages/app-shell/src/prompt-workbench-builder-dialog.tsx', 'text-sky-500', 1],
  ['packages/app-shell/src/prompt-workbench-panel.tsx', 'text-sky-500', 1],
];

it('keeps audited status foregrounds legible and warning colors semantic', () => {
  const violations = [];
  const used = new Map();
  for (const path of paths) {
    for (const paint of staticColorClasses(readFileSync(join(root, path), 'utf8'), path)) {
      if (paint.dark) {
        continue;
      }
      const exemption = decorative.find(
        ([file, utility]) => file === path && utility === paint.utility
      );
      if (exemption) {
        const key = `${path}:${paint.utility}`;
        used.set(key, (used.get(key) ?? 0) + 1);
        continue;
      }
      const minimum = 4.5;
      for (const violation of collectForegroundViolations({
        minimum,
        palette,
        surfaces,
        text: paint.utility,
      })) {
        violations.push(
          path +
            ':' +
            paint.line +
            ' ' +
            paint.utility +
            ' (' +
            violation.ratio.toFixed(3) +
            ':1 on ' +
            violation.surface +
            ')'
        );
      }
    }
  }
  assert.deepEqual(violations, []);
  for (const [path, utility, count] of decorative) {
    assert.equal(
      used.get(`${path}:${utility}`),
      count,
      `Stale decorative exception: ${path}:${utility}`
    );
  }
});

it('keeps non-status collection categories distinct and contrast-qualified in every theme mode', () => {
  const path = 'packages/ui/src/collection-browser/types.ts';
  const colors = staticColorClasses(readFileSync(join(root, path), 'utf8'), path);
  assert.equal(colors.length, 8, 'Four category hues need a light and dark foreground each');
  const modes = themeModes(readFileSync(join(root, 'packages/ui/src/globals.css'), 'utf8'));
  for (const [mode, tokens] of Object.entries(modes)) {
    const active = colors.filter((paint) => paint.dark === mode.endsWith('dark'));
    assert.equal(new Set(active.map((paint) => paint.color)).size, 4);
    for (const paint of active) {
      for (const surface of [
        'background',
        'card',
        'popover',
        'muted',
        'secondary',
        'accent',
        'sidebar',
        'sidebar-accent',
      ]) {
        const background = hslToRgb(
          tokens.get(`--bs-${surface}`).replaceAll('%', '').split(/\s+/).map(Number)
        );
        const ratio = contrastRatio(palette.get(paint.color), background);
        assert.ok(ratio >= 4.5, `${mode}/${surface} ${paint.utility}: ${ratio.toFixed(4)}:1`);
      }
    }
  }
});
