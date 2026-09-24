import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

type ProviderId = 'anthropic' | 'bedrock' | 'openai' | 'openrouter';

interface ExpectedRow {
  readonly bestFor: readonly string[];
  readonly id: string;
  readonly name: string;
  /** 1-based append position among this migration's rows for the provider. */
  readonly offset: number;
  readonly providerId: ProviderId;
  readonly tagline: string;
  readonly vision: boolean;
}

/**
 * BST-1804. `tagline` and `best_for` are hand-authored in migration 142 — the
 * generator leaves them NULL and `model-catalog-migration-contract.mjs` never
 * reads those columns, so a typo in that copy fails HERE or nowhere.
 */
const EXPECTED: readonly ExpectedRow[] = [
  {
    bestFor: ['Complex coding', 'Agentic workflows'],
    id: 'gpt-6-sol',
    name: 'GPT-6 Sol',
    offset: 1,
    providerId: 'openai',
    tagline: 'Built to power complex coding and agentic workflows',
    vision: true,
  },
  {
    bestFor: ['Focused tasks', 'High-volume tasks'],
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    offset: 2,
    providerId: 'openai',
    tagline: 'Our most efficient model for focused, high-volume tasks',
    vision: true,
  },
  {
    bestFor: ['Long-running agentic coding', 'Knowledge work'],
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    offset: 1,
    providerId: 'anthropic',
    tagline: 'For long-running agentic coding and knowledge work',
    vision: true,
  },
  {
    bestFor: [],
    id: 'openai/gpt-6-sol',
    name: 'GPT-6 Sol (OpenRouter)',
    offset: 1,
    providerId: 'openrouter',
    tagline: "Cost-efficient high-end model in OpenAI's GPT-6 series",
    vision: true,
  },
  {
    bestFor: ['High-volume workloads', 'Latency-sensitive workloads', 'Chat', 'Classification'],
    id: 'openai/gpt-6-luna',
    name: 'GPT-6 Luna (OpenRouter)',
    offset: 2,
    providerId: 'openrouter',
    tagline: "Fast, cost-efficient model in OpenAI's GPT-6 series",
    vision: true,
  },
  {
    bestFor: [
      'Experimentation',
      'Learning',
      'Early-stage agentic workflows',
      'Multi-agent workflows',
      'Coding workflows',
    ],
    id: 'meta/muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 Contributor (OpenRouter)',
    offset: 3,
    providerId: 'openrouter',
    tagline: "Cost-efficient contributor tier of Meta's multimodal reasoning model",
    vision: true,
  },
  {
    bestFor: ['Autonomous agents on consumer hardware'],
    id: 'meta/muse-glimmer-30b',
    name: 'Muse Glimmer 30B (OpenRouter)',
    offset: 4,
    providerId: 'openrouter',
    tagline: 'Dense open-weight multimodal model distilled from Muse Spark',
    vision: true,
  },
  {
    bestFor: ['Demanding reasoning', 'Coding', 'Long-horizon agentic work'],
    id: 'anthropic/claude-opus-5.5',
    name: 'Claude Opus 5.5 (OpenRouter)',
    offset: 5,
    providerId: 'openrouter',
    tagline: "Anthropic's flagship model, succeeding Claude Opus 5",
    vision: true,
  },
  {
    bestFor: ['Enterprise agentic workflows'],
    id: 'cohere/command-a-plus',
    name: 'Command A+ (OpenRouter)',
    offset: 6,
    providerId: 'openrouter',
    tagline: "Cohere's flagship model for enterprise agentic workflows",
    vision: true,
  },
  {
    bestFor: ['End-to-end software delivery', 'Multi-step task execution'],
    id: 'bytedance-seed/seed-2-1-turbo',
    name: 'Seed 2.1 Turbo (OpenRouter)',
    offset: 7,
    providerId: 'openrouter',
    tagline: 'Multimodal model for coding and long-horizon agent workflows',
    vision: true,
  },
  {
    bestFor: ['Audio-video analysis', 'Summarization'],
    id: 'qwen/qwen3.8-omni-flash',
    name: 'Qwen3.8 Omni Flash (OpenRouter)',
    offset: 8,
    providerId: 'openrouter',
    tagline: 'Omni-modal reasoning model with native audio-video understanding',
    vision: true,
  },
  {
    bestFor: ['Reasoning', 'Orchestration'],
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    name: 'Nemotron 3 Ultra (OpenRouter)',
    offset: 9,
    providerId: 'openrouter',
    tagline: 'Open frontier-reasoning and orchestration mixture-of-experts model',
    vision: false,
  },
  {
    bestFor: [],
    id: 'thinkingmachines/inkling-small',
    name: 'Inkling Small (OpenRouter)',
    offset: 10,
    providerId: 'openrouter',
    tagline: 'Open-weight multimodal mixture-of-experts with 12B of 276B parameters active',
    vision: true,
  },
  {
    bestFor: ['Coding', 'Agentic tasks', 'Knowledge work', 'Long-running software engineering'],
    id: 'x-ai/grok-4.7',
    name: 'Grok 4.7 (OpenRouter)',
    offset: 11,
    providerId: 'openrouter',
    tagline: 'Flagship model for coding, agentic tasks, and knowledge work, succeeding Grok 4.6',
    vision: true,
  },
  {
    bestFor: [],
    id: 'z-ai/glm-5.3-flashx',
    name: 'GLM 5.3 FlashX (OpenRouter)',
    offset: 12,
    providerId: 'openrouter',
    tagline: 'High-speed variant of GLM-5.3-Flash at up to 200 tokens/s',
    vision: true,
  },
  {
    bestFor: [],
    id: 'xiaomi/mimo-v2.6-pro',
    name: 'MiMo-V2.6-Pro (OpenRouter)',
    offset: 13,
    providerId: 'openrouter',
    tagline: "Xiaomi's flagship foundation model, built at over 1T parameters",
    vision: true,
  },
  {
    bestFor: [],
    id: 'xiaomi/mimo-v2.6-flash',
    name: 'MiMo-V2.6-Flash (OpenRouter)',
    offset: 14,
    providerId: 'openrouter',
    tagline: 'Open-source mixture-of-experts model with 15B of 309B parameters active',
    vision: true,
  },
  {
    bestFor: ['Coding', 'Knowledge work', 'Long-running tasks'],
    id: 'anthropic.claude-opus-5-5',
    name: 'Claude Opus 5.5 (Bedrock)',
    offset: 1,
    providerId: 'bedrock',
    tagline: "Anthropic's most capable Opus model",
    vision: true,
  },
];

const PROVIDERS: readonly ProviderId[] = ['anthropic', 'bedrock', 'openai', 'openrouter'];

interface ModelRow {
  readonly best_for: readonly string[] | null;
  readonly capabilities: { streaming?: boolean; type?: string; vision?: boolean };
  readonly id: string;
  readonly is_enabled: boolean;
  readonly name: string;
  readonly provider_id: string;
  readonly sort_order: number;
  readonly tagline: string | null;
}

async function readRows(db: PGlite): Promise<Map<string, ModelRow>> {
  const result = await db.query<ModelRow>(
    `SELECT id, provider_id, name, tagline, best_for, capabilities, is_enabled, sort_order
     FROM models WHERE id = ANY($1)`,
    [EXPECTED.map(({ id }) => id)]
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

async function maxSortOrders(db: PGlite): Promise<Map<string, number>> {
  const result = await db.query<{ max_sort_order: number | null; provider_id: string }>(
    `SELECT provider_id, MAX(sort_order) AS max_sort_order FROM models
     WHERE provider_id = ANY($1) GROUP BY provider_id`,
    [PROVIDERS]
  );
  return new Map(result.rows.map((row) => [row.provider_id, row.max_sort_order ?? 0]));
}

describe('migration 142: 2026-09 catalog refresh (BST-1804)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-migration-142');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('adds all eighteen rows disabled, appended per provider, with authored copy', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter(({ version }) => version <= 141));
    const maxBefore = await maxSortOrders(db);

    // Stop AT 142: a later migration is free to renumber or retire rows, and
    // the `appended` guarantee under test belongs to 142.
    await runner.up(migrations.filter(({ version }) => version <= 142));
    const rows = await readRows(db);
    expect(rows.size).toBe(EXPECTED.length);

    for (const expected of EXPECTED) {
      expect(rows.get(expected.id), expected.id).toEqual({
        best_for: expected.bestFor,
        capabilities: { streaming: true, type: 'llm', vision: expected.vision },
        id: expected.id,
        is_enabled: false,
        name: expected.name,
        provider_id: expected.providerId,
        sort_order: (maxBefore.get(expected.providerId) ?? 0) + expected.offset,
        tagline: expected.tagline,
      });
    }

    // Re-applying the SAME up SQL over a row the user has since enabled and a
    // stale name must refresh the catalog columns and LEAVE THE TOGGLE ALONE
    // (database.md rule 3). Generated with BST-1704's per-provider exclusion,
    // so re-applied sort orders are IDENTICAL.
    const up = migrations.find(({ version }) => version === 142)?.up;
    if (typeof up !== 'string') {
      throw new Error('migration 142 must be registered with SQL-string up');
    }
    await db.query(
      "UPDATE models SET is_enabled = true, name = 'stale name', tagline = 'stale tagline', best_for = '[\"stale\"]' WHERE id = ANY($1)",
      [EXPECTED.map(({ id }) => id)]
    );
    await db.exec(up);
    const reapplied = await readRows(db);
    for (const expected of EXPECTED) {
      expect(reapplied.get(expected.id), expected.id).toMatchObject({
        best_for: expected.bestFor,
        is_enabled: true,
        name: expected.name,
        sort_order: (maxBefore.get(expected.providerId) ?? 0) + expected.offset,
        tagline: expected.tagline,
      });
    }

    await runner.down(migrations, 141);
    expect((await readRows(db)).size).toBe(0);
  });
});
