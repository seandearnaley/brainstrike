import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('DatabaseDemoPanel module boundary', () => {
  it('keeps the panel orchestrator below the giant-component threshold', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/database-demo-panel.tsx'), 'utf8');
    const componentSource = source.slice(source.indexOf('export function DatabaseDemoPanel'));

    expect(componentSource.split('\n').length).toBeLessThanOrEqual(300);
    expect(source).not.toContain('Legacy component with complex UI state');
  });
});
