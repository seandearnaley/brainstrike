import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';

/**
 * Shared workspace fixture for the assistant-tools suite family (BST-976
 * review): the shape is LOAD-BEARING — suites assert on `src/main.ts` being
 * exactly four lines with no trailing newline and on the components/lib
 * layout — so there is exactly one source of truth.
 */
export async function createWorkspaceFixture(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-agent-tools-'));
  await fsPromises.mkdir(path.join(root, 'src', 'components'), { recursive: true });
  await fsPromises.mkdir(path.join(root, 'src', 'lib'), { recursive: true });
  await fsPromises.writeFile(path.join(root, 'README.md'), '# Test Workspace\n', 'utf8');
  await fsPromises.writeFile(
    path.join(root, 'src', 'main.ts'),
    'line 1\nline 2\nline 3\nline 4',
    'utf8'
  );
  await fsPromises.writeFile(
    path.join(root, 'src', 'components', 'button.tsx'),
    'export const Button = () => null;\n',
    'utf8'
  );
  await fsPromises.writeFile(
    path.join(root, 'src', 'lib', 'math.ts'),
    'export const add = () => 1;\n',
    'utf8'
  );
  return root;
}

export function workspaceRuntime(
  workspaceRootPath: string,
  threadId = 'assistant-tools-thread'
): RuntimeData {
  return {
    memory: { resourceId: 'assistant-tools-workspace', threadId },
    workspaceRootPath,
    workspaceRoots: [
      {
        displayName: path.basename(workspaceRootPath),
        path: workspaceRootPath,
        rootId: workspaceRootPath,
      },
    ],
  } as RuntimeData;
}
