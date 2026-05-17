import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('main agent devtools startup wiring', () => {
  it('configures agent devtools before E2E path isolation', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../main.ts'), 'utf8');
    const importIndex = source.indexOf("from './agent-devtools-config'");
    const callIndex = source.indexOf('configureAgentDevtoolsCommandLine(');
    const isolationIndex = source.indexOf('applyE2EPathIsolation();');
    expect(importIndex).toBeGreaterThanOrEqual(0);
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(isolationIndex).toBeGreaterThan(callIndex);
  });
});
