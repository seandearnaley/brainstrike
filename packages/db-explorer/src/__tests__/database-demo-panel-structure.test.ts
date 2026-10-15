// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('DatabaseDemoPanel module boundary', () => {
  it('keeps the panel orchestrator below the giant-component threshold', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/database-demo-panel.tsx'), 'utf8');
    const componentIndex = source.indexOf('export function DatabaseDemoPanel');

    expect(componentIndex).toBeGreaterThanOrEqual(0);
    // React Doctor's no-giant-component rule flags components above 300 lines.
    const componentSource = source.slice(componentIndex);
    expect(componentSource.split('\n').length).toBeLessThanOrEqual(300);
    expect(source).not.toContain('Legacy component with complex UI state');
  });
});
