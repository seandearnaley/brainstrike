import { beforeEach, describe, expect, it, vi } from 'vitest';

const parserInitMock = vi.fn(async () => {});
const languageLoadMock = vi.fn(async () => ({ language: 'python' }));
const fetchMock = vi.fn<typeof fetch>(
  async () => new Response(new Uint8Array([0, 97, 115, 109]), { status: 200 })
);

vi.mock('web-tree-sitter', () => ({
  Language: {
    load: languageLoadMock,
  },
  Parser: {
    init: parserInitMock,
  },
}));

describe('tree-sitter grammar loader', () => {
  beforeEach(() => {
    parserInitMock.mockClear();
    languageLoadMock.mockClear();
    fetchMock.mockClear();
    vi.stubGlobal('self', {});
    vi.stubGlobal('fetch', fetchMock);
  });

  it('loads grammar WASM from its source location in Vite development', async () => {
    const { loadLanguage, resetLoaderForTests } = await import(
      '../parsers/tree-sitter-grammar-loader'
    );
    resetLoaderForTests();

    await loadLanguage('python');

    expect(parserInitMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [grammarUrl] = fetchMock.mock.calls[0] ?? [];
    expect(new URL(String(grammarUrl)).pathname).toMatch(
      /\/packages\/chunking-worker\/grammars\/python\.wasm$/
    );
    expect(languageLoadMock).toHaveBeenCalledWith(new Uint8Array([0, 97, 115, 109]));
  });
});
