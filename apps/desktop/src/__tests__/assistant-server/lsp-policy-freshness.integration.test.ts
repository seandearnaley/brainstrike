import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import {
  countPooledLspServers,
  disposeLspServers,
  getEditDiagnostics,
  getLspInspection,
} from '../../assistant-server/lsp-diagnostics';

let scratch: string;
let root: string;

beforeEach(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bs-lsp-policy-')));
  root = path.join(scratch, 'workspace');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"lsp-policy-fixture"}');
});

afterEach(async () => {
  await disposeLspServers();
  await fs.rm(scratch, { force: true, recursive: true });
});

function args(file: string, content: string) {
  return { absolutePath: path.join(root, file), content, rootId: 'policy-root', rootPath: root };
}

const SECRET = 'FAKE_LSP_PRIVATE_LITERAL';

it.each([
  'llmignore',
  'brainstrikeignore',
  'ignored-alias',
  'credential-alias',
  'outside-alias',
  'outside-import',
])(
  'withholds inferred locals and diagnostics from %s sources',
  async (scenario) => {
    let dependency = './hidden';
    const hidden = `export const secret = "${SECRET}" as const;\n`;
    if (scenario === 'ignored-alias') {
      await fs.writeFile(path.join(root, 'public.ts'), hidden);
      await fs.symlink('public.ts', path.join(root, 'hidden.ts'));
      await fs.writeFile(path.join(root, '.llmignore'), 'hidden.ts\n');
    } else if (scenario === 'credential-alias') {
      await fs.writeFile(path.join(root, '.env.local.ts'), hidden);
      await fs.symlink('.env.local.ts', path.join(root, 'hidden.ts'));
    } else if (scenario.startsWith('outside-')) {
      await fs.writeFile(path.join(scratch, 'hidden.ts'), hidden);
      if (scenario === 'outside-alias') {
        await fs.symlink('../hidden.ts', path.join(root, 'hidden.ts'));
      } else {
        dependency = '../hidden';
      }
    } else {
      await fs.writeFile(path.join(root, 'hidden.ts'), hidden);
      await fs.writeFile(path.join(root, `.${scenario}`), 'hidden.ts\n');
    }
    const content = `import { secret } from "${dependency}";\nconst derived = secret;\nconst reject: "public" = derived;\n`;
    await fs.writeFile(path.join(root, 'use.ts'), content);
    // The definition of this local is allowed. Filtering only returned
    // definition locations cannot protect the inferred literal in its hover.
    const inspection = await getLspInspection({
      ...args('use.ts', content),
      position: { character: 8, line: 1 },
    });
    const diagnostics = await getEditDiagnostics(args('use.ts', content));
    for (const result of [inspection, diagnostics]) {
      expect(result).toMatchObject({ available: false, reason: 'read-policy' });
      expect(result.message).toMatch(/withheld|cannot verify/i);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  },
  30_000
);

it('honors ignore rules tightened after a successful query and recovers when removed', async () => {
  const content = 'import { value } from "./value";\nvalue;\n';
  await fs.writeFile(path.join(root, 'value.ts'), 'export const value: number = 1;\n');
  await fs.writeFile(path.join(root, 'use.ts'), content);
  const inspect = () =>
    getLspInspection({ ...args('use.ts', content), position: { character: 1, line: 1 } });
  expect((await inspect()).hover).toContain('number');
  await fs.writeFile(path.join(root, '.llmignore'), 'value.ts\n');
  expect(await inspect()).toMatchObject({ available: false, reason: 'read-policy' });
  await fs.rm(path.join(root, '.llmignore'));
  expect((await inspect()).hover).toContain('number');
}, 30_000);

it('isolates concurrent queries from another file’s temporary open buffer', async () => {
  const disk = 'export const value: string = "disk";\n';
  const oldBuffer = 'export const value: number = 1;\n';
  const content = 'import { value } from "./value";\nvalue;\n';
  await fs.writeFile(path.join(root, 'value.ts'), disk);
  await fs.writeFile(path.join(root, 'use.ts'), content);
  const [first, second] = await Promise.all([
    getLspInspection({ ...args('value.ts', oldBuffer), position: { character: 14, line: 0 } }),
    getLspInspection({ ...args('use.ts', content), position: { character: 1, line: 1 } }),
  ]);
  expect(first.hover).toContain('number');
  expect(second.hover).toContain('string');
  expect(second.definition?.[0]?.preview).toBe(disk.trim());
}, 30_000);

it('refreshes inspected and diagnosed dependencies after disk edits, rename, deletion and recreation', async () => {
  const original = 'export const value: number = 1;\n';
  const changed = 'export const value: string = "current";\n';
  const content = 'import { value } from "./value";\nconst target: number = value;\n';
  await fs.writeFile(path.join(root, 'value.ts'), original);
  await fs.writeFile(path.join(root, 'use.ts'), content);
  const inspect = () =>
    getLspInspection({ ...args('use.ts', content), position: { character: 24, line: 1 } });
  expect((await getEditDiagnostics(args('value.ts', original))).available).toBe(true);
  expect((await inspect()).hover).toContain('number');
  await fs.writeFile(path.join(root, 'value.ts'), changed);
  const fresh = await inspect();
  expect(fresh.hover).toContain('string');
  expect(fresh.definition?.[0]?.preview).toBe(changed.trim());
  expect((await getEditDiagnostics(args('use.ts', content))).diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('string') }),
    ])
  );
  await fs.rename(path.join(root, 'value.ts'), path.join(root, 'renamed.ts'));
  const missing = await getEditDiagnostics(args('use.ts', content));
  expect(missing.available).toBe(true);
  expect(missing.diagnostics?.some((entry) => entry.message.includes('Cannot find module'))).toBe(
    true
  );
  await fs.rm(path.join(root, 'renamed.ts'));
  await fs.writeFile(path.join(root, 'value.ts'), 'export const value: boolean = true;\n');
  expect((await inspect()).hover).toContain('boolean');
  expect(countPooledLspServers()).toBe(1);
}, 30_000);
