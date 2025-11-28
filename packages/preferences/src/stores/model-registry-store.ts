import type { IDatabase } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils';
import { create } from 'zustand';

const logger = createLogger('ModelRegistryStore');

export interface DbProvider {
  id: string;
  name: string;
  icon: string | null;
  isEnabled: boolean;
  sortOrder: number;
}

export interface DbModel {
  id: string;
  providerId: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  capabilities: {
    type: 'llm' | 'embedding';
    streaming?: boolean;
    defaultDimension?: number;
  };
  parameters: Record<string, unknown> | null;
  sortOrder: number;
}

interface ModelRegistryState {
  providers: DbProvider[];
  models: DbModel[];
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchRegistry: (db: IDatabase) => Promise<void>;
  toggleProvider: (db: IDatabase, providerId: string, enabled: boolean) => Promise<void>;
  toggleModel: (db: IDatabase, modelId: string, enabled: boolean) => Promise<void>;
}

// Raw DB types
interface RawProvider {
  id: string;
  name: string;
  icon: string | null;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  is_enabled: number | boolean;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  sort_order: number;
}

interface RawModel {
  id: string;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  provider_id: string;
  name: string;
  description: string | null;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  is_enabled: number | boolean;
  capabilities: string | object;
  parameters: string | object | null;
  // biome-ignore lint/style/useNamingConvention: DB schema uses snake_case
  sort_order: number;
}

export const useModelRegistryStore = create<ModelRegistryState>((set, get) => ({
  providers: [],
  models: [],
  isLoading: false,
  error: null,

  fetchRegistry: async (db: IDatabase) => {
    set({ isLoading: true, error: null });
    try {
      const providersResult = await db.query<RawProvider>(
        'SELECT * FROM providers ORDER BY sort_order ASC'
      );
      const modelsResult = await db.query<RawModel>('SELECT * FROM models ORDER BY sort_order ASC');

      // Parse JSON fields and map to camelCase
      const models = modelsResult.rows.map((row: RawModel) => ({
        id: row.id,
        providerId: row.provider_id,
        name: row.name,
        description: row.description,
        isEnabled: Boolean(row.is_enabled),
        capabilities:
          typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities,
        parameters:
          typeof row.parameters === 'string' && row.parameters
            ? JSON.parse(row.parameters)
            : row.parameters,
        sortOrder: row.sort_order,
      })) as DbModel[];

      const providers = providersResult.rows.map((row: RawProvider) => ({
        id: row.id,
        name: row.name,
        icon: row.icon,
        isEnabled: Boolean(row.is_enabled),
        sortOrder: row.sort_order,
      }));

      set({ providers, models, isLoading: false });
    } catch (error) {
      logger.error('Failed to fetch model registry', error);
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  toggleProvider: async (db: IDatabase, providerId: string, enabled: boolean) => {
    try {
      // Optimistic update
      set((state) => ({
        providers: state.providers.map((p) =>
          p.id === providerId ? { ...p, isEnabled: enabled } : p
        ),
      }));

      await db.query(
        "UPDATE providers SET is_enabled = $1, updated_at = datetime('now') WHERE id = $2",
        [enabled, providerId]
      );
    } catch (error) {
      logger.error('Failed to toggle provider', error);
      // Revert on error
      void get().fetchRegistry(db);
    }
  },

  toggleModel: async (db: IDatabase, modelId: string, enabled: boolean) => {
    try {
      // Optimistic update
      set((state) => ({
        models: state.models.map((m) => (m.id === modelId ? { ...m, isEnabled: enabled } : m)),
      }));

      await db.query(
        "UPDATE models SET is_enabled = $1, updated_at = datetime('now') WHERE id = $2",
        [enabled, modelId]
      );
    } catch (error) {
      logger.error('Failed to toggle model', error);
      void get().fetchRegistry(db);
    }
  },
}));
