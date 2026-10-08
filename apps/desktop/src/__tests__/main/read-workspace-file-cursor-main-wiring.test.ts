import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('readWorkspaceFile continuation registry lifecycle wiring', () => {
  it('clears the main-process registry during factory reset', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../main.ts'), 'utf8');

    expect(source).toContain(
      "import { clearReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';"
    );
    expect(source).toMatch(
      /name:\s*'read-workspace-file-cursors',\s*stop:\s*clearReadWorkspaceFileCursorRegistry/
    );
  });
});
