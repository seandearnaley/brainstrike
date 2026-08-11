import type { FixtureDefinition, FixtureLoadOptions } from '@brainstrike/file-system';
import type { Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockBrowserApis } from '../mock-fs';

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
    writable: true,
  });

  (
    window as unknown as {
      __BRAINSTRIKE_LOAD_FIXTURE__:
        | ((
            fixture?: FixtureDefinition,
            options?: FixtureLoadOptions
          ) => Promise<unknown> | unknown)
        | undefined;
    }
  ).__BRAINSTRIKE_LOAD_FIXTURE__ = undefined;
});

describe('mockBrowserApis', () => {
  it('initializes browser APIs without clipboard', async () => {
    const addInitScript = vi.fn().mockResolvedValue(undefined);
    const page = { addInitScript } as unknown as Page;

    await mockBrowserApis(page, 'root', { foo: null });

    expect(addInitScript).toHaveBeenCalledTimes(1);
    expect(addInitScript).toHaveBeenCalledWith(expect.any(String));
    expect(addInitScript.mock.calls[0]?.[0]).toContain('"rootName":"root"');
    expect(addInitScript.mock.calls[0]?.[0]).toContain('"enableClipboard":false');
  });

  it('passes clipboard option', async () => {
    const addInitScript = vi.fn().mockResolvedValue(undefined);
    const page = { addInitScript } as unknown as Page;

    await mockBrowserApis(page, 'root', { foo: null }, { clipboard: true });

    expect(addInitScript).toHaveBeenCalledTimes(1);
    expect(addInitScript).toHaveBeenCalledWith(expect.any(String));
    expect(addInitScript.mock.calls[0]?.[0]).toContain('"enableClipboard":true');
  });
});

describe('Fixture Loader Script', () => {
  const getInjectedScript = async (
    tree: import('../mock-fs').FileTree,
    options: { clipboard?: boolean; directoryReadDelayMs?: number; rootId?: string } = {}
  ) => {
    const addInitScript = vi.fn();
    const page = { addInitScript } as unknown as Page;
    await mockBrowserApis(page, 'root', tree, options);
    const firstCall = addInitScript.mock.calls[0];
    if (!firstCall) {
      throw new Error('addInitScript was not called');
    }
    const [script] = firstCall;
    if (typeof script !== 'string') {
      throw new Error('Expected mock browser init script to be a string');
    }
    return () => {
      const runScript = new Function(script);
      runScript();
    };
  };

  it('loads the provided fixture through the official testing API', async () => {
    const directoryHandle = { kind: 'directory', name: 'root', path: 'root', platform: 'web' };
    const loadFixture = vi.fn().mockResolvedValue(directoryHandle);
    (
      window as unknown as {
        __BRAINSTRIKE_LOAD_FIXTURE__?: (
          fixture?: FixtureDefinition,
          options?: FixtureLoadOptions
        ) => Promise<typeof directoryHandle>;
      }
    ).__BRAINSTRIKE_LOAD_FIXTURE__ = loadFixture;

    const runScript = await getInjectedScript({
      dir1: {
        'file1.txt': null,
      },
    });

    runScript();
    const handle = await (
      window as unknown as {
        showDirectoryPicker: () => Promise<typeof directoryHandle>;
      }
    ).showDirectoryPicker();

    expect(loadFixture).toHaveBeenCalledWith(
      {
        name: 'root',
        tree: {
          dir1: {
            'file1.txt': null,
          },
        },
      },
      undefined
    );
    expect(handle).toEqual(directoryHandle);
  });

  it('passes directory read delay through the official fixture API', async () => {
    const directoryHandle = { kind: 'directory', name: 'root', path: 'root', platform: 'web' };
    const loadFixture = vi.fn().mockResolvedValue(directoryHandle);
    (
      window as unknown as {
        __BRAINSTRIKE_LOAD_FIXTURE__?: (
          fixture?: FixtureDefinition,
          options?: FixtureLoadOptions
        ) => Promise<typeof directoryHandle>;
      }
    ).__BRAINSTRIKE_LOAD_FIXTURE__ = loadFixture;

    const runScript = await getInjectedScript({ 'file.txt': null }, { directoryReadDelayMs: 25 });

    runScript();
    await (
      window as unknown as {
        showDirectoryPicker: () => Promise<typeof directoryHandle>;
      }
    ).showDirectoryPicker();

    expect(loadFixture).toHaveBeenCalledWith(
      {
        name: 'root',
        tree: {
          'file.txt': null,
        },
      },
      {
        directoryReadDelayMs: 25,
      }
    );
  });

  it('passes a durable root id through the official fixture API', async () => {
    const directoryHandle = { kind: 'directory', name: 'root', path: 'root', platform: 'web' };
    const loadFixture = vi.fn().mockResolvedValue(directoryHandle);
    (
      window as unknown as {
        __BRAINSTRIKE_LOAD_FIXTURE__?: (
          fixture?: FixtureDefinition,
          options?: FixtureLoadOptions
        ) => Promise<typeof directoryHandle>;
      }
    ).__BRAINSTRIKE_LOAD_FIXTURE__ = loadFixture;

    const rootId = '8a69fc45-04a2-4e48-92d1-2c974a7ced41';
    const runScript = await getInjectedScript({ 'file.txt': null }, { rootId });

    runScript();
    await (
      window as unknown as {
        showDirectoryPicker: () => Promise<typeof directoryHandle>;
      }
    ).showDirectoryPicker();

    expect(loadFixture).toHaveBeenCalledWith(
      {
        name: 'root',
        rootId,
        tree: {
          'file.txt': null,
        },
      },
      undefined
    );
  });

  it('keeps the clipboard mock when enabled', async () => {
    const runScript = await getInjectedScript({}, { clipboard: true });
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText');

    runScript();
    await navigator.clipboard.writeText('test');

    expect(writeTextSpy).toHaveBeenCalledWith('test');
    writeTextSpy.mockRestore();
  });
});
