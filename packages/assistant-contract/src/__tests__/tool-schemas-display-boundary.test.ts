import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DISPLAY_DATA_MODULE_PATTERN = /^tool-schemas-display-(?!types\.ts$).*\.ts$/;

describe('tool schema display module boundary', () => {
  it('keeps display data modules independent from the display value module', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const typesPath = path.join(sourceRoot, 'tool-schemas-display-types.ts');
    const displayDataModules = readdirSync(sourceRoot).filter((fileName) =>
      DISPLAY_DATA_MODULE_PATTERN.test(fileName)
    );

    expect(existsSync(typesPath)).toBe(true);
    expect(displayDataModules.length).toBeGreaterThanOrEqual(4);

    for (const fileName of displayDataModules) {
      const source = readFileSync(path.join(sourceRoot, fileName), 'utf8');
      expect(source, fileName).toContain("from './tool-schemas-display-types.js'");
      expect(source, fileName).not.toContain("from './tool-schemas-display.js'");
    }
  });
});
