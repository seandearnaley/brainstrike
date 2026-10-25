import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import { addWorkspaceFolder } from './embedding-worker-renderer.native-search';
import { expect } from './fixtures/electron-fixture';
import { chooseSemanticSearch, waitForEmbeddedFolder } from './utils/native-index-build';
import { textReadiness } from './utils/text-search-mode';

/** Capture the real process receipt: exit zero alone did not catch the M3 native cleanup failure. */
export function captureNativeShutdown(app: ElectronApplication): () => void {
  const process = app.process();
  let output = '';
  const append = (chunk: Buffer): void => {
    output += chunk.toString('utf8');
  };
  process.stdout?.on('data', append);
  return () => {
    process.stdout?.off('data', append);
    const records = output.split('\n').flatMap((line) => {
      if (!line.startsWith('{')) {
        return [];
      }
      const record: unknown = JSON.parse(line);
      return typeof record === 'object' && record !== null ? [record] : [];
    });
    const reports = records.flatMap((record) =>
      'steps' in record && Array.isArray(record.steps) ? [record.steps] : []
    );
    // Retirement rejects every join it aborts; Main's process handler logs one left unobserved.
    const unhandled = records.filter(
      (record) => 'msg' in record && record.msg === 'Unhandled promise rejection'
    );
    expect(process.exitCode).toBe(0);
    expect(process.signalCode).toBeNull();
    expect(unhandled).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual(
      expect.arrayContaining([
        // The agent host's exit joins its search index (ADR-0029 stage 4).
        expect.objectContaining({ failed: false, step: 'agent-host' }),
        expect.objectContaining({ failed: false, step: 'embedding-host' }),
      ])
    );
    expect(reports[0]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ failed: true })])
    );
  };
}

/** The one file of the small folder the retirement cases search, and a query only it answers. */
export const SEARCHABLE_FILE = 'backfill-fixture.ts';
export const SEARCHABLE_QUERY = 'desktop import backfill regression';

/** A small real folder holding {@link SEARCHABLE_FILE}. */
export async function createSearchableRoot(): Promise<string> {
  const rootPath = await realpath(await mkdtemp(path.join(tmpdir(), 'brainstrike-searchable-')));
  await writeFile(
    path.join(rootPath, SEARCHABLE_FILE),
    `export function fixtureValue(): string { return "${SEARCHABLE_QUERY}"; }\n`
  );
  return rootPath;
}

/** Semantic search on WASM, then the searchable folder added and fully embedded. */
export async function prepareSearchableFolder(
  electronApp: ElectronApplication,
  page: Page,
  searchableRoot: string
): Promise<void> {
  await chooseSemanticSearch(page, 'wasm');
  await expect
    .poll(() => textReadiness(page), { timeout: 120_000 })
    .toEqual({ folders: 0, indexMode: 'vector-configured', kind: 'ready' });
  await addWorkspaceFolder(electronApp, page, searchableRoot, SEARCHABLE_FILE);
  await waitForEmbeddedFolder(page, 1);
}
