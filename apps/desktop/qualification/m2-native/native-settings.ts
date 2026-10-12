import { expect } from '@playwright/test';
import type { NativeLocalSelection } from '../../../../packages/indexing-contract/src/indexer-producer';
import { HomePage } from '../../e2e/page-objects/home-page';
import { SettingsPage } from '../../e2e/page-objects/settings-page';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import type { PublicBridges } from './public-bridges';

export const NATIVE_SETTINGS_KEY = 'background-indexing-preferences.v1';
export interface SavedNativeChoices {
  readonly enabled: boolean;
  readonly indexingPolicyPreset: 'balanced' | 'full-root';
  readonly managedCollectionId: string;
  readonly nativeIndexMode: 'TEXT' | 'VECTOR';
  readonly nativeLocalSelection: NativeLocalSelection | null;
  readonly paused: boolean;
}

export async function readSavedChoices(context: ElectronAppContext): Promise<SavedNativeChoices> {
  return await context.window.evaluate(async (key) => {
    const stored = await (window as unknown as PublicBridges).electronAPI?.storage.getItem(key);
    if (!stored) {
      throw new Error('Native choices are not saved.');
    }
    const state: SavedNativeChoices = JSON.parse(stored).state;
    return {
      enabled: state.enabled,
      indexingPolicyPreset: state.indexingPolicyPreset,
      managedCollectionId: state.managedCollectionId,
      nativeIndexMode: state.nativeIndexMode,
      nativeLocalSelection: state.nativeLocalSelection,
      paused: state.paused,
    };
  }, NATIVE_SETTINGS_KEY);
}

/** Real migrated catalog input; no native rows, chunks, vectors or readiness are seeded. */
export async function ensureCatalogCollection(
  context: ElectronAppContext,
  modelId: string
): Promise<string> {
  return await context.window.evaluate(async (modelId) => {
    const query = (window as unknown as PublicBridges).electronAPI?.db.query;
    if (!query) {
      throw new Error('Canonical catalog database bridge is unavailable.');
    }
    const name = `M2 qualification ${modelId}`;
    const existing = await query<{ id: string }>(
      'SELECT id FROM embedding_sets WHERE name=$1 AND model_id=$2 ORDER BY created_at',
      [name, modelId]
    );
    if (existing.rows.length > 1) {
      throw new Error('Duplicate qualification collection.');
    }
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO embedding_sets (id,model_key,model_id,dimensions,distance,name)
      VALUES ($1,$2,$3,384,'cosine',$4)`,
      [id, `local::${modelId}`, modelId, name]
    );
    return id;
  }, modelId);
}

export async function configureNativeChoices(
  context: ElectronAppContext,
  options: {
    readonly mode: 'TEXT' | 'VECTOR';
    readonly modelId: string;
    readonly planLabel?: string;
    readonly selection?: NativeLocalSelection;
    readonly paused?: boolean;
  }
): Promise<string> {
  const collectionId = await ensureCatalogCollection(context, options.modelId);
  // Refresh the real settings repository after inserting its persisted fixture input.
  await context.window.reload();
  const home = new HomePage(context.window);
  await home.openSettings();
  const section = await new SettingsPage(context.window).openCategory(
    /Search & Indexing/i,
    'search-indexing'
  );
  await section.getByRole('combobox', { name: 'Managed collection' }).click();
  await context.window
    .getByRole('option', { exact: true, name: `M2 qualification ${options.modelId}` })
    .click();
  await section.getByRole('combobox', { name: 'Indexing policy' }).click();
  await context.window.getByRole('option', { exact: true, name: 'Full root' }).click();
  await section.getByRole('combobox', { name: 'Search mode' }).click();
  await context.window
    .getByRole('option', {
      exact: true,
      name: options.mode === 'TEXT' ? 'Text search' : 'Text and semantic search',
    })
    .click();
  if (options.mode === 'VECTOR') {
    if (!(options.planLabel && options.selection)) {
      throw new Error('VECTOR requires an explicit full execution plan.');
    }
    await section.getByRole('combobox', { name: 'Local model execution' }).click();
    await context.window.getByRole('option', { exact: true, name: options.planLabel }).click();
  }
  const enabled = section.getByRole('switch', { name: 'Workspace Index' });
  if ((await enabled.getAttribute('aria-checked')) !== 'true') {
    await enabled.click();
  }
  const pause = section.getByRole('button', {
    exact: true,
    name: options.paused ? 'Pause workspace index' : 'Resume workspace index',
  });
  if ((await pause.count()) === 1) {
    await pause.click();
  }
  await expect
    .poll(() => readSavedChoices(context))
    .toMatchObject({
      enabled: true,
      indexingPolicyPreset: 'full-root',
      managedCollectionId: collectionId,
      nativeIndexMode: options.mode,
      paused: options.paused ?? false,
      ...(options.selection ? { nativeLocalSelection: options.selection } : {}),
    });
  await home.leaveSettings();
  return collectionId;
}

export async function configureNativeText(context: ElectronAppContext): Promise<string> {
  return await configureNativeChoices(context, {
    mode: 'TEXT',
    modelId: 'Xenova/all-MiniLM-L6-v2',
  });
}
