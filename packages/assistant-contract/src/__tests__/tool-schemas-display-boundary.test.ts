import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DISPLAY_DATA_MODULES = [
  'tool-schemas-display-execution.ts',
  'tool-schemas-display-search.ts',
  'tool-schemas-display-tasks.ts',
  'tool-schemas-display-workspace.ts',
] as const;

describe('tool schema display module boundary', () => {
  it('keeps display data modules independent from the display value module', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const typesPath = path.join(sourceRoot, 'tool-schemas-display-types.ts');

    expect(existsSync(typesPath)).toBe(true);

    for (const fileName of DISPLAY_DATA_MODULES) {
      const source = readFileSync(path.join(sourceRoot, fileName), 'utf8');
      expect(source, fileName).toContain("from './tool-schemas-display-types.js'");
      expect(source, fileName).not.toContain("from './tool-schemas-display.js'");
    }
  });
});
