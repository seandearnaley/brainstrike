import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import type { VisibleEmbeddingHostBridge } from '../src/types/desktop-electron-api';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { callIndexSearch, nativeStatus } from './utils/text-search-mode';

/** Real disk files allow Main's native watcher to exercise the same import corpus. */
export async function createNativeImportRoot(
  fileCount: number,
  sentencesPerFile: number
): Promise<string> {
  const rootPath = await realpath(await mkdtemp(path.join(tmpdir(), 'brainstrike-native-import-')));
  try {
    for (let index = 0; index < fileCount; index += 1) {
      const name = `stress-file-${String(index).padStart(4, '0')}.ts`;
      const sentences = Array.from(
        { length: sentencesPerFile },
        (_, sentenceIndex) =>
          `export const sentence_${sentenceIndex} = "stress-file-${index}-sentence-${sentenceIndex}.";`
      );
      await writeFile(path.join(rootPath, name), sentences.join('\n'));
    }
    return rootPath;
  } catch (error) {
    await rm(rootPath, { force: true, recursive: true });
    throw error;
  }
}

/** Adds a real folder with the explorer's Add Folder button, which picks `folder`. */
export async function addWorkspaceFolder(
  app: ElectronApplication,
  page: Page,
  folder: string,
  visibleFile: string
): Promise<void> {
  await app.evaluate((_electron, picked) => {
    process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = picked;
  }, folder);
  await ensureFileExplorerPanelVisible(page);
  await page.getByTestId('select-root-button').click({ timeout: 15_000 });
  await expect(
    page.getByRole('treegrid', { name: 'File tree' }).getByText(visibleFile)
  ).toBeVisible({ timeout: 30_000 });
}

export interface NativeIngestionWork {
  readonly hostActive: boolean;
  /** A folder has not finished its scan. */
  readonly incomplete: boolean;
  readonly vectors: number;
}

/** The embedding host's activity and the index's progress over every folder; null until it answers. */
export async function observeNativeIngestion(page: Page): Promise<NativeIngestionWork | null> {
  const status = await nativeStatus(page);
  if (status.kind !== 'ready') {
    if (status.phase === 'blocked') {
      throw new Error(status.reason);
    }
    return null;
  }
  const observation = await callIndexSearch(page, 'coverageBatch', [
    { rootIds: status.authorizedRootIds },
  ]);
  if (observation.kind === 'blocked') {
    throw new Error(observation.reason);
  }
  if (observation.kind === 'invalidated') {
    return null;
  }
  const coverage = observation.coverage[0];
  if (!coverage) {
    throw new Error('Native coverage omitted its requested folders');
  }
  const hostActive = await page.evaluate(async () => {
    const host = (window as Window & { readonly embeddingHost?: VisibleEmbeddingHostBridge })
      .embeddingHost;
    if (!host) {
      throw new Error('Embedding host capability unavailable');
    }
    return (await host.getStatus()).active;
  });
  return {
    hostActive,
    incomplete: observation.status.rootReadiness.some((root) => !root.scanComplete),
    vectors: coverage.totals.vectors,
  };
}
