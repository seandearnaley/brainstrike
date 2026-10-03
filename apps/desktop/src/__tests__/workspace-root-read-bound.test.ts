import { resetFileSizeConfig, setFileSizeConfig } from '@brainstrike/file-system';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readResolvedWorkspaceFile } from '../ipc-domains/workspace-root-read';

afterEach(resetFileSizeConfig);

describe('mounted workspace read byte ownership', () => {
  it('passes the caller smaller read bound to the same mounted capability', async () => {
    setFileSizeConfig({ maxFileSize: 1024 });
    const readFile = vi.fn().mockResolvedValue({ content: Buffer.from('text'), status: 'ok' });
    await Reflect.apply(readResolvedWorkspaceFile, undefined, [
      '/workspace/a.ts',
      {
        mounted: {
          canonicalPath: '/workspace',
          presentationPath: '/workspace',
          root: { canonicalPath: '/workspace', close: vi.fn(), listDir: vi.fn(), readFile },
          rootId: 'root',
        },
        relativePath: 'a.ts',
        traversedSymlink: false,
      },
      4,
    ]);
    expect(readFile).toHaveBeenCalledExactlyOnceWith('a.ts', 4);
  });
});
