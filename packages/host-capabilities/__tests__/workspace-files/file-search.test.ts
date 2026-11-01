import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FileSearchBatch } from '@brainstrike/agent-host';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setMaxLiveCandidateFilesForTests } from '../../src/native-tools/live-grep.ts';
import {
  createHostFileSearch,
  FILE_SEARCH_MATCH_LIMIT,
} from '../../src/workspace-files/file-search.ts';
import { createWorkspaceRootPins } from '../../src/workspace-files/root-pins.ts';
import { grantedMounts } from './granted-mounts.ts';

const ROOT_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ID = '00000000-0000-4000-8000-000000000002';

let base: string;
let workspace: string;

const write = (relative: string, content: string, root = workspace): void => {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'host-file-search-')));
  workspace = path.join(base, 'repo');
  mkdirSync(workspace);
});

const opened: { close(): Promise<void> | void }[] = [];
afterEach(async () => {
  setMaxLiveCandidateFilesForTests();
  for (const owner of opened.splice(0).reverse()) {
    await owner.close();
  }
  rmSync(base, { force: true, recursive: true });
});

const searchOver = async (roots = [{ path: workspace, rootId: ROOT_ID }]) => {
  const mounts = await grantedMounts(roots);
  const pins = createWorkspaceRootPins({ mounts });
  opened.push(mounts, pins);
  return createHostFileSearch({ pins });
};

const query = (
  text: string,
  flags: Partial<{ caseSensitive: boolean; isRegex: boolean; wholeWord: boolean }> = {}
) => ({
  caseSensitive: false,
  isRegex: false,
  searchId: 'search-1',
  wholeWord: false,
  ...flags,
  query: text,
});

/** Runs one search, collecting every batch it streams before its answer. */
async function run(
  service: Awaited<ReturnType<typeof searchOver>>,
  params: ReturnType<typeof query>,
  signal = new AbortController().signal
) {
  const batches: FileSearchBatch['matches'][] = [];
  const result = await service.search(params, signal, (matches) => batches.push(matches));
  return { batches, matches: batches.flat(), result };
}

/** ADR-0035: the Explorer's Search tab reads the disk live, through the host. */
describe('host file search', () => {
  it('finds text the moment a file is saved, and stops finding what was replaced', async () => {
    const service = await searchOver();
    write('src/notes.ts', 'export const marker = "first-draft";\n');

    const first = await run(service, query('first-draft'));
    expect(first.matches).toEqual([
      {
        line: 1,
        lineText: 'export const marker = "first-draft";',
        path: 'src/notes.ts',
        rootId: ROOT_ID,
      },
    ]);

    write('src/notes.ts', 'export const marker = "second-draft";\n');
    expect((await run(service, query('first-draft'))).matches).toEqual([]);
    expect((await run(service, query('second-draft'))).matches.map((m) => m.path)).toEqual([
      'src/notes.ts',
    ]);
  });

  it('never shows agent-ignored, dependency or credential files', async () => {
    const service = await searchOver();
    write('.brainstrikeignore', 'private/\n');
    write('private/plan.md', 'needle in a private plan\n');
    write('node_modules/pkg/index.js', 'needle in a dependency\n');
    write('.env', 'API_KEY=needle-secret\n');
    write('certs/server.pem', 'needle-secret\n');
    write('src/app.ts', 'const needle = 1;\n');

    const { matches } = await run(service, query('needle'));

    expect(matches.map((match) => match.path)).toEqual(['src/app.ts']);
    expect(JSON.stringify(matches)).not.toContain('secret');
  });

  it('searches every live folder, naming the folder each match is in', async () => {
    const second = path.join(base, 'second');
    mkdirSync(second);
    const service = await searchOver([
      { path: workspace, rootId: ROOT_ID },
      { path: second, rootId: SECOND_ID },
    ]);
    write('a.ts', 'shared-term\n');
    write('b.ts', 'shared-term\n', second);
    write('outside.ts', 'shared-term\n', base);

    const { matches } = await run(service, query('shared-term'));

    expect(matches.map((match) => [match.rootId, match.path]).sort()).toEqual([
      [ROOT_ID, 'a.ts'],
      [SECOND_ID, 'b.ts'],
    ]);
  });

  it('honours case, whole word and regular expressions', async () => {
    const service = await searchOver();
    write('words.txt', 'Token\ntoken\ntokens\n');

    expect(
      (await run(service, query('token', { caseSensitive: true }))).matches.map((m) => m.line)
    ).toEqual([2, 3]);
    expect(
      (await run(service, query('token', { wholeWord: true }))).matches.map((m) => m.line)
    ).toEqual([1, 2]);
    expect(
      (await run(service, query('^tok.ns$', { isRegex: true }))).matches.map((m) => m.line)
    ).toEqual([3]);
  });

  it('says when the search stopped at its match cap', async () => {
    const service = await searchOver();
    write('big.txt', 'hit\n'.repeat(FILE_SEARCH_MATCH_LIMIT + 10));

    const { matches, result } = await run(service, query('hit'));

    expect(matches).toHaveLength(FILE_SEARCH_MATCH_LIMIT);
    expect(result).toMatchObject({ matches: FILE_SEARCH_MATCH_LIMIT, matchLimitReached: true });
  });

  it('says when the search stopped at its file cap', async () => {
    setMaxLiveCandidateFilesForTests(2);
    const service = await searchOver();
    for (const name of ['a', 'b', 'c', 'd']) {
      write(`${name}.txt`, 'capped\n');
    }

    const { matches, result } = await run(service, query('capped'));

    expect(matches).toHaveLength(2);
    expect(result).toMatchObject({ candidatesTruncated: true, matchLimitReached: false });
  });

  it('streams its first matches before it finishes', async () => {
    const service = await searchOver();
    for (let index = 0; index < 40; index += 1) {
      write(`src/file-${index}.ts`, `stream-term ${index}\n`);
    }

    const { batches, result } = await run(service, query('stream-term'));

    expect(batches[0]?.length).toBeGreaterThan(0);
    expect(batches.flat()).toHaveLength(40);
    expect(result.matches).toBe(40);
  });

  it('stops, and sends nothing more, once the client cancels', async () => {
    const service = await searchOver();
    for (let index = 0; index < 200; index += 1) {
      write(`src/file-${index}.ts`, `cancel-term ${index}\n`);
    }
    const controller = new AbortController();
    let afterCancel = 0;
    const pending = service.search(query('cancel-term'), controller.signal, () => {
      if (controller.signal.aborted) {
        afterCancel += 1;
      }
      controller.abort(new Error('a new query'));
    });

    await expect(pending).rejects.toThrow('a new query');
    expect(afterCancel).toBe(0);
  });

  it('refuses a pattern that is not a valid regular expression', async () => {
    const service = await searchOver();
    await expect(run(service, query('(unclosed', { isRegex: true }))).rejects.toMatchObject({
      failure: expect.objectContaining({ code: 'workspace.search-pattern-invalid' }),
    });
  });

  it('refuses to search when no folder is open', async () => {
    const service = await searchOver([]);
    await expect(run(service, query('anything'))).rejects.toMatchObject({
      failure: expect.objectContaining({ code: 'workspace.search-no-folder' }),
    });
  });
});
