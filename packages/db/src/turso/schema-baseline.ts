import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbTransactionClient,
} from '../architecture/brainstrike-db-client-contract.js';
import { backfillGrepContentIndex } from '../search/grep-content-grams.js';
import { backfillQuickOpenNameGrams } from '../search/quick-open-name-grams.js';
import {
  assertNoPostgresMigrationLedgers,
  assertTursoSchemaLedgerHasNoUnknownVersions,
  computeTursoSchemaChecksum,
  ensureTursoSchemaLedger,
  readTursoSchemaLedgerEntry,
  recordTursoSchemaLedgerEntry,
} from './schema-ledger.js';

export const TURSO_SCHEMA_BASELINE_PREVIOUS_VERSION = 1;
export const TURSO_SCHEMA_BASELINE_V2_VERSION = 2;
export const TURSO_SCHEMA_BASELINE_V3_VERSION = 3;
export const TURSO_SCHEMA_BASELINE_V4_VERSION = 4;
export const TURSO_SCHEMA_BASELINE_V5_VERSION = 5;
export const TURSO_SCHEMA_BASELINE_VERSION = 6;
export const TURSO_SCHEMA_BASELINE_PREVIOUS_CHECKSUM =
  '8e9f598868dda50fb9f763c010bf74215cd51b305bfda68719dd6a12cf8587c7';

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const workspaceIndexSystemRoleIndexDdl =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_sets_workspace_index_system_role ON embedding_sets (system_role) WHERE system_role = 'workspace-index'";
const jobQueueActiveDedupeIndexDdl =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_dedupe_active ON job_queue (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued','running')";
const fileRecordNameIndexTableDdl = `
    CREATE TABLE IF NOT EXISTS file_record_name_index (
      file_record_id TEXT NOT NULL PRIMARY KEY REFERENCES file_records(id) ON DELETE CASCADE,
      normalized_name TEXT NOT NULL
    )
  `;
const fileRecordNameGramsTableDdl = `
    CREATE TABLE IF NOT EXISTS file_record_name_grams (
      file_record_id TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
      gram TEXT NOT NULL,
      PRIMARY KEY (file_record_id, gram)
    )
  `;
const fileRecordNameGramsIndexDdl =
  'CREATE INDEX IF NOT EXISTS idx_file_record_name_grams_gram_record ON file_record_name_grams (gram, file_record_id)';
const fileChunkContentIndexTableDdl = `
    CREATE TABLE IF NOT EXISTS file_chunk_content_index (
      file_chunk_id TEXT NOT NULL PRIMARY KEY REFERENCES file_chunks(id) ON DELETE CASCADE,
      normalized_content TEXT NOT NULL
    )
  `;
const fileChunkContentGramsTableDdl = `
    CREATE TABLE IF NOT EXISTS file_chunk_content_grams (
      file_chunk_id TEXT NOT NULL REFERENCES file_chunks(id) ON DELETE CASCADE,
      case_sensitive INTEGER NOT NULL CHECK (case_sensitive IN (0, 1)),
      gram TEXT NOT NULL,
      PRIMARY KEY (file_chunk_id, case_sensitive, gram)
    )
  `;
const fileChunkContentGramsIndexDdl =
  'CREATE INDEX IF NOT EXISTS idx_file_chunk_content_grams_lookup ON file_chunk_content_grams (case_sensitive, gram, file_chunk_id)';

export const TURSO_SCHEMA_BASELINE_DDL = [
  `
    CREATE TABLE IF NOT EXISTS roots (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('path', 'fsa', 'snapshot', 'legacy')),
      display_name TEXT NOT NULL,
      path TEXT,
      status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'needs-regrant', 'disconnected', 'snapshot-stale')),
      created_at TEXT NOT NULL DEFAULT (${nowSql}),
      last_verified_at TEXT
    )
  `,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_roots_path_identity ON roots (path) WHERE path IS NOT NULL AND kind = 'path'",
  `
    CREATE TABLE IF NOT EXISTS file_records (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      root_id TEXT REFERENCES roots(id) ON DELETE CASCADE,
      size INTEGER NOT NULL,
      mtime_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (${nowSql}),
      updated_at TEXT NOT NULL DEFAULT (${nowSql}),
      content TEXT,
      content_hash TEXT,
      token_count INTEGER,
      processed_at TEXT,
      embedding_set_id TEXT,
      chunks_processed_at TEXT,
      chunks_count INTEGER,
      chunking_strategy TEXT
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_file_records_path ON file_records (path)',
  'CREATE INDEX IF NOT EXISTS idx_file_records_content_hash ON file_records (content_hash)',
  'CREATE INDEX IF NOT EXISTS idx_file_records_embedding_set_id ON file_records (embedding_set_id)',
  'CREATE INDEX IF NOT EXISTS idx_file_records_root_id ON file_records (root_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_file_records_root_identity ON file_records (embedding_set_id, root_id, path) WHERE embedding_set_id IS NOT NULL AND root_id IS NOT NULL',
  fileRecordNameIndexTableDdl,
  fileRecordNameGramsTableDdl,
  fileRecordNameGramsIndexDdl,
  `
    CREATE TABLE IF NOT EXISTS file_chunks (
      id TEXT PRIMARY KEY,
      file_record_id TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT,
      token_count INTEGER,
      chunk_type TEXT CHECK (chunk_type IS NULL OR chunk_type IN ('text', 'code', 'sentence', 'recursive')),
      chunk_size INTEGER,
      start_line INTEGER,
      end_line INTEGER,
      start_offset INTEGER,
      end_offset INTEGER,
      embedding BLOB,
      embedding_set_id TEXT,
      embedding_updated_at TEXT,
      embedding_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (${nowSql}),
      updated_at TEXT NOT NULL DEFAULT (${nowSql})
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_file_chunks_file_record_id ON file_chunks (file_record_id)',
  'CREATE INDEX IF NOT EXISTS idx_file_chunks_embedding_set_id ON file_chunks (embedding_set_id)',
  'CREATE INDEX IF NOT EXISTS idx_file_chunks_content_hash ON file_chunks (content_hash)',
  fileChunkContentIndexTableDdl,
  fileChunkContentGramsTableDdl,
  fileChunkContentGramsIndexDdl,
  `
    CREATE TABLE IF NOT EXISTS selection_snapshots (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (${nowSql}),
      expires_at TEXT
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_selection_snapshots_created_at ON selection_snapshots (created_at)',
  `
    CREATE TABLE IF NOT EXISTS selection_snapshot_files (
      snapshot_id TEXT NOT NULL REFERENCES selection_snapshots(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_selection_snapshot_files_snapshot_id ON selection_snapshot_files (snapshot_id)',
  'CREATE INDEX IF NOT EXISTS idx_selection_snapshot_files_file_path ON selection_snapshot_files (file_path)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_selection_snapshot_files_unique ON selection_snapshot_files (snapshot_id, file_path)',
  `
    CREATE TABLE IF NOT EXISTS embedding_sets (
      id TEXT PRIMARY KEY,
      model_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      distance TEXT DEFAULT 'cosine' CHECK (distance IS NULL OR distance IN ('cosine', 'l2', 'ip')),
      created_at TEXT NOT NULL DEFAULT (${nowSql}),
      name TEXT,
      description TEXT,
      tags TEXT,
      category TEXT,
      system_role TEXT CHECK (system_role IS NULL OR system_role IN ('workspace-index')),
      allow_duplicates INTEGER DEFAULT 0 NOT NULL CHECK (allow_duplicates IN (0, 1))
    )
  `,
  workspaceIndexSystemRoleIndexDdl,
  `
    CREATE TABLE IF NOT EXISTS collection_indexing_stats (
      embedding_set_id TEXT PRIMARY KEY,
      file_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      embedded_chunk_count INTEGER NOT NULL DEFAULT 0,
      pending_chunk_count INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1)),
      last_refreshed_at TEXT NOT NULL DEFAULT (${nowSql})
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_collection_indexing_stats_dirty ON collection_indexing_stats (dirty, last_refreshed_at)',
  `
    CREATE TABLE IF NOT EXISTS job_queue (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      job_type TEXT NOT NULL,
      payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
      chunk_id TEXT,
      embedding_set_id TEXT,
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'expired')),
      run_at TEXT NOT NULL DEFAULT (${nowSql}),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      backoff_ms INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      leased_until TEXT,
      worker_id TEXT,
      dedupe_key TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (${nowSql}),
      updated_at TEXT NOT NULL DEFAULT (${nowSql})
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_job_queue_state_run_at ON job_queue (state, run_at)',
  'CREATE INDEX IF NOT EXISTS idx_job_queue_dedupe_key ON job_queue (dedupe_key)',
  jobQueueActiveDedupeIndexDdl,
  'CREATE INDEX IF NOT EXISTS idx_job_queue_leased_until ON job_queue (leased_until)',
  "CREATE INDEX IF NOT EXISTS idx_job_queue_active_embed_chunk_id ON job_queue (chunk_id) WHERE job_type = 'embed_chunk' AND chunk_id IS NOT NULL AND state IN ('queued','running')",
  "CREATE INDEX IF NOT EXISTS idx_job_queue_embed_set_state ON job_queue (queue, job_type, embedding_set_id, state, updated_at) WHERE job_type = 'embed_chunk' AND embedding_set_id IS NOT NULL",
  `
    CREATE TABLE IF NOT EXISTS token_cache (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${nowSql})
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_token_cache_file_path ON token_cache (file_path)',
  'CREATE INDEX IF NOT EXISTS idx_token_cache_content_hash ON token_cache (content_hash)',
  `
    CREATE TABLE IF NOT EXISTS file_token_cache (
      id INTEGER PRIMARY KEY,
      folder_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mtime_ms INTEGER,
      token_count INTEGER NOT NULL,
      counting_mode TEXT NOT NULL CHECK (counting_mode IN ('accurate', 'heuristic')),
      model_encoding TEXT,
      created_at TEXT NOT NULL DEFAULT (${nowSql}),
      updated_at TEXT NOT NULL DEFAULT (${nowSql})
    )
  `,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_file_token_cache_folder_path_unique ON file_token_cache (folder_id, file_path)',
  'CREATE INDEX IF NOT EXISTS idx_file_token_cache_lookup ON file_token_cache (folder_id, file_path)',
  'CREATE INDEX IF NOT EXISTS idx_file_token_cache_hash ON file_token_cache (content_hash)',
  'CREATE INDEX IF NOT EXISTS idx_file_token_cache_folder ON file_token_cache (folder_id)',
  'CREATE INDEX IF NOT EXISTS idx_file_token_cache_mode ON file_token_cache (folder_id, counting_mode)',
  `
    CREATE TABLE IF NOT EXISTS file_tags (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${nowSql})
    )
  `,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_file_tags_unique ON file_tags (file_id, tag)',
  'CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags (tag)',
  `
    CREATE TABLE IF NOT EXISTS file_relationships (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
      relationship_type TEXT NOT NULL,
      metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
      created_at TEXT NOT NULL DEFAULT (${nowSql})
    )
  `,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_file_relationships_unique ON file_relationships (source_id, target_id, relationship_type)',
  'CREATE INDEX IF NOT EXISTS idx_file_relationships_source ON file_relationships (source_id)',
  'CREATE INDEX IF NOT EXISTS idx_file_relationships_target ON file_relationships (target_id)',
  'CREATE INDEX IF NOT EXISTS idx_file_relationships_type ON file_relationships (relationship_type)',
  `
    CREATE TABLE IF NOT EXISTS embedding_cache (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      model_key TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${nowSql}),
      accessed_at TEXT NOT NULL DEFAULT (${nowSql}),
      access_count INTEGER NOT NULL DEFAULT 1
    )
  `,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_cache_content_model ON embedding_cache (content_hash, model_key)',
  'CREATE INDEX IF NOT EXISTS idx_embedding_cache_content_hash ON embedding_cache (content_hash)',
  'CREATE INDEX IF NOT EXISTS idx_embedding_cache_accessed_at ON embedding_cache (accessed_at)',
  `
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (${nowSql}),
      updated_at TEXT NOT NULL DEFAULT (${nowSql})
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_providers_sort_order ON providers (sort_order)',
  `
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      tagline TEXT,
      best_for TEXT CHECK (best_for IS NULL OR json_valid(best_for)),
      icon TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
      capabilities TEXT CHECK (capabilities IS NULL OR json_valid(capabilities)),
      parameters TEXT CHECK (parameters IS NULL OR json_valid(parameters)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (${nowSql}),
      updated_at TEXT NOT NULL DEFAULT (${nowSql})
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_models_provider_id ON models (provider_id)',
  'CREATE INDEX IF NOT EXISTS idx_models_sort_order ON models (sort_order)',
  `
    CREATE TABLE IF NOT EXISTS view_filter_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT NOT NULL DEFAULT 'file',
      includes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(includes)),
      excludes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(excludes)),
      use_regex INTEGER NOT NULL DEFAULT 0 CHECK (use_regex IN (0, 1)),
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (${nowSql}),
      updated_at TEXT NOT NULL DEFAULT (${nowSql})
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_view_filter_presets_sort_order ON view_filter_presets (sort_order)',
  'CREATE INDEX IF NOT EXISTS idx_view_filter_presets_is_default ON view_filter_presets (is_default)',
  `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_usage (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      root_id TEXT,
      created_at TEXT NOT NULL DEFAULT (${nowSql})
    )
  `,
  'CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_usage_thread_idx ON brainstrike_assistant_run_usage (thread_id)',
  'CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_usage_root_idx ON brainstrike_assistant_run_usage (resource_id, root_id)',
  'CREATE INDEX IF NOT EXISTS idx_assistant_run_usage_root_created ON brainstrike_assistant_run_usage (root_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_assistant_run_usage_thread_created ON brainstrike_assistant_run_usage (thread_id, created_at)',
] as const;

const providerSeeds = [
  ['openai', 'OpenAI', 1, 1],
  ['anthropic', 'Anthropic', 2, 1],
  ['google', 'Google AI Studio', 3, 1],
  ['local', 'Local (Browser)', 4, 1],
  ['openrouter', 'OpenRouter', 5, 0],
  ['cohere', 'Cohere', 6, 0],
  ['voyage', 'Voyage AI', 7, 0],
] as const;

const modelSeeds = [
  [
    'gpt-5.5',
    'openai',
    'GPT-5.5',
    'Newest flagship for complex work',
    '["Reasoning","Coding","Agentic"]',
    '{"type":"llm","streaming":true}',
    1,
    1,
  ],
  [
    'gpt-5.5-pro',
    'openai',
    'GPT-5.5 Pro',
    'Highest capability tier',
    '["Complex reasoning","Tool use"]',
    '{"type":"llm","streaming":true}',
    2,
    1,
  ],
  [
    'gpt-5.4',
    'openai',
    'GPT-5.4',
    'Balanced cost-aware flagship',
    '["Reasoning","Coding","Multimodal"]',
    '{"type":"llm","streaming":true}',
    3,
    1,
  ],
  [
    'gpt-5.4-pro',
    'openai',
    'GPT-5.4 Pro',
    'Higher capability tier',
    '["Complex reasoning","Tool use"]',
    '{"type":"llm","streaming":true}',
    4,
    1,
  ],
  [
    'gpt-5.4-mini',
    'openai',
    'GPT-5.4 Mini',
    'Lower latency, lower cost',
    '["Chat","High volume"]',
    '{"type":"llm","streaming":true}',
    5,
    1,
  ],
  [
    'gpt-5.4-nano',
    'openai',
    'GPT-5.4 Nano',
    'Smallest, fastest tier',
    '["Lightweight","Classification"]',
    '{"type":"llm","streaming":true}',
    6,
    1,
  ],
  [
    'gpt-5.3-codex',
    'openai',
    'GPT-5.3 Codex',
    'Agentic coding model',
    '["Coding","Agentic"]',
    '{"type":"llm","streaming":true}',
    7,
    1,
  ],
  [
    'gpt-5.2',
    'openai',
    'GPT-5.2',
    'Previous-generation flagship',
    '["Reasoning","Coding"]',
    '{"type":"llm","streaming":true}',
    8,
    1,
  ],
  [
    'gpt-5.2-pro',
    'openai',
    'GPT-5.2 Pro',
    'Previous higher tier',
    '["Complex reasoning"]',
    '{"type":"llm","streaming":true}',
    9,
    1,
  ],
  [
    'text-embedding-3-small',
    'openai',
    'Text Embedding 3 Small',
    'Efficient embeddings',
    '["Search","Clustering"]',
    '{"type":"embedding","defaultDimension":1536}',
    10,
    1,
  ],
  [
    'text-embedding-3-large',
    'openai',
    'Text Embedding 3 Large',
    'High-precision embeddings',
    '["Semantic search","Knowledge retrieval"]',
    '{"type":"embedding","defaultDimension":3072}',
    11,
    1,
  ],
  [
    'claude-opus-4-8',
    'anthropic',
    'Claude Opus 4.8',
    'Most capable Claude model',
    '["Deep research","Agentic coding"]',
    '{"type":"llm","streaming":true}',
    1,
    1,
  ],
  [
    'claude-sonnet-4-6',
    'anthropic',
    'Claude Sonnet 4.6',
    'Best balance of speed and intelligence',
    '["Analysis","Coding","Writing"]',
    '{"type":"llm","streaming":true}',
    2,
    1,
  ],
  [
    'claude-haiku-4-5',
    'anthropic',
    'Claude Haiku 4.5',
    'Fastest Claude model',
    '["Quick responses","Data extraction"]',
    '{"type":"llm","streaming":true}',
    3,
    1,
  ],
  [
    'gemini-3.5-flash',
    'google',
    'Gemini 3.5 Flash',
    'Stable low-latency flagship flash',
    '["Realtime apps","High volume"]',
    '{"type":"llm","streaming":true}',
    1,
    1,
  ],
  [
    'gemini-3.1-pro-preview',
    'google',
    'Gemini 3.1 Pro (Preview)',
    'Advanced reasoning preview',
    '["Complex tasks","Analysis"]',
    '{"type":"llm","streaming":true}',
    2,
    1,
  ],
  [
    'gemini-3.1-flash-lite',
    'google',
    'Gemini 3.1 Flash Lite',
    'Lightweight low-cost flash',
    '["Lightweight","High volume"]',
    '{"type":"llm","streaming":true}',
    3,
    1,
  ],
  [
    'gemini-2.5-pro',
    'google',
    'Gemini 2.5 Pro',
    'Stable advanced reasoning',
    '["Complex tasks","Analysis"]',
    '{"type":"llm","streaming":true}',
    4,
    1,
  ],
  [
    'gemini-2.5-flash',
    'google',
    'Gemini 2.5 Flash',
    'Stable fast model',
    '["Realtime apps","High volume"]',
    '{"type":"llm","streaming":true}',
    5,
    1,
  ],
  [
    'gemini-2.5-flash-lite',
    'google',
    'Gemini 2.5 Flash Lite',
    'Stable lightweight flash',
    '["Lightweight","High volume"]',
    '{"type":"llm","streaming":true}',
    6,
    1,
  ],
  [
    'gemini-embedding-001',
    'google',
    'Gemini Embedding 001',
    'Configurable embeddings',
    '["General purpose","Retrieval"]',
    '{"type":"embedding","defaultDimension":3072}',
    7,
    1,
  ],
  [
    'gemini-embedding-2',
    'google',
    'Gemini Embedding 2',
    'Auto-normalizing configurable embeddings',
    '["General purpose","Retrieval"]',
    '{"type":"embedding","defaultDimension":3072}',
    8,
    1,
  ],
  [
    'openai/gpt-5.5',
    'openrouter',
    'GPT-5.5 (OpenRouter)',
    'Newest OpenAI flagship',
    '["Reasoning","Coding"]',
    '{"type":"llm","streaming":true}',
    1,
    0,
  ],
  [
    'openai/gpt-5.4',
    'openrouter',
    'GPT-5.4 (OpenRouter)',
    'Balanced OpenAI flagship',
    '["Reasoning","Coding"]',
    '{"type":"llm","streaming":true}',
    2,
    0,
  ],
  [
    'openai/gpt-5.4-mini',
    'openrouter',
    'GPT-5.4 Mini (OpenRouter)',
    'Lower-cost OpenAI model',
    '["Chat","High volume"]',
    '{"type":"llm","streaming":true}',
    3,
    0,
  ],
  [
    'openai/gpt-5.3-codex',
    'openrouter',
    'GPT-5.3 Codex (OpenRouter)',
    'Agentic coding model',
    '["Coding","Agentic"]',
    '{"type":"llm","streaming":true}',
    4,
    0,
  ],
  [
    'openai/gpt-5.2',
    'openrouter',
    'GPT-5.2 (OpenRouter)',
    'Previous OpenAI flagship',
    '["Reasoning","Coding"]',
    '{"type":"llm","streaming":true}',
    5,
    0,
  ],
  [
    'anthropic/claude-opus-4.8',
    'openrouter',
    'Claude Opus 4.8 (OpenRouter)',
    'Most capable Claude',
    '["Deep research"]',
    '{"type":"llm","streaming":true}',
    6,
    0,
  ],
  [
    'anthropic/claude-sonnet-4.6',
    'openrouter',
    'Claude Sonnet 4.6 (OpenRouter)',
    'Balanced Claude model',
    '["Analysis","Writing"]',
    '{"type":"llm","streaming":true}',
    7,
    0,
  ],
  [
    'anthropic/claude-haiku-4.5',
    'openrouter',
    'Claude Haiku 4.5 (OpenRouter)',
    'Fastest Claude model',
    '["Quick responses"]',
    '{"type":"llm","streaming":true}',
    8,
    0,
  ],
  [
    'google/gemini-3.5-flash',
    'openrouter',
    'Gemini 3.5 Flash (OpenRouter)',
    'Stable low-latency Gemini',
    '["Realtime apps"]',
    '{"type":"llm","streaming":true}',
    9,
    0,
  ],
  [
    'google/gemini-3.1-pro-preview',
    'openrouter',
    'Gemini 3.1 Pro (OpenRouter)',
    'Advanced Gemini preview',
    '["Complex tasks"]',
    '{"type":"llm","streaming":true}',
    10,
    0,
  ],
  [
    'google/gemini-2.5-flash',
    'openrouter',
    'Gemini 2.5 Flash (OpenRouter)',
    'Stable fast Gemini',
    '["Realtime apps"]',
    '{"type":"llm","streaming":true}',
    11,
    0,
  ],
  [
    'jinaai/jina-embeddings-v2-base-code',
    'local',
    'Jina Code',
    'Code-aware embeddings',
    '["Code search","Multilingual"]',
    '{"type":"embedding","defaultDimension":768}',
    '{"size":"~300MB"}',
    1,
    0,
  ],
  [
    'Xenova/jina-embeddings-v2-base-en',
    'local',
    'Jina v2 Base EN',
    'Best English model',
    '["English","High performance"]',
    '{"type":"embedding","defaultDimension":768}',
    '{"size":"~300MB"}',
    2,
    0,
  ],
  [
    'Xenova/all-MiniLM-L6-v2',
    'local',
    'all-MiniLM-L6-v2',
    'Fast local embeddings',
    '["English","Speed"]',
    '{"type":"embedding","defaultDimension":384}',
    '{"size":"~23MB"}',
    3,
    1,
  ],
  [
    'Xenova/bge-small-en-v1.5',
    'local',
    'BGE Small',
    'Balanced local embeddings',
    '["English","General purpose"]',
    '{"type":"embedding","defaultDimension":384}',
    '{"size":"~34MB"}',
    4,
    1,
  ],
  [
    'Xenova/bge-base-en-v1.5',
    'local',
    'BGE Base',
    'High-quality local embeddings',
    '["English","Retrieval"]',
    '{"type":"embedding","defaultDimension":768}',
    '{"size":"~110MB"}',
    5,
    0,
  ],
  [
    'Xenova/bge-large-en-v1.5',
    'local',
    'BGE Large',
    'High-accuracy local embeddings',
    '["English","High accuracy"]',
    '{"type":"embedding","defaultDimension":1024}',
    '{"size":"~340MB"}',
    6,
    0,
  ],
  [
    'onnx-community/gemma-4-E2B-it-ONNX',
    'local',
    'Gemma 4 E2B',
    'Desktop and browser local reasoning model with WebGPU acceleration',
    '["General tasks","Coding","Tool calling","Local reasoning"]',
    '{"type":"llm","streaming":false,"toolCalling":true,"contextWindow":131072}',
    '{"architecture":"Gemma 4 E2B","device":"webgpu","quantization":"q4f16","size":"~3.9GB (text-only q4f16)"}',
    10,
    1,
  ],
  [
    'embed-english-v3.0',
    'cohere',
    'Embed English v3.0',
    'Optimized for English',
    '["Search","RAG"]',
    '{"type":"embedding","defaultDimension":1024}',
    1,
    0,
  ],
  [
    'embed-multilingual-v3.0',
    'cohere',
    'Embed Multilingual v3.0',
    '100+ languages supported',
    '["Global apps","Cross-lingual search"]',
    '{"type":"embedding","defaultDimension":1024}',
    2,
    0,
  ],
  [
    'voyage-3',
    'voyage',
    'Voyage 3',
    'State-of-the-art retrieval',
    '["Legal","Finance","Code"]',
    '{"type":"embedding","defaultDimension":1024}',
    1,
    0,
  ],
  [
    'voyage-3-lite',
    'voyage',
    'Voyage 3 Lite',
    'Efficient retrieval',
    '["Low latency apps"]',
    '{"type":"embedding","defaultDimension":512}',
    2,
    0,
  ],
] as const;

const viewFilterPresetSeeds = [
  [
    'typescript-javascript',
    'TypeScript/JavaScript',
    'Source files for TypeScript and JavaScript projects',
    'file-code',
    ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'],
    ['node_modules', 'dist', 'build', '.next', 'coverage', '*.test.*', '*.spec.*'],
    1,
  ],
  [
    'all-code',
    'All Code',
    'All programming language source files',
    'code',
    [
      '*.ts',
      '*.tsx',
      '*.js',
      '*.jsx',
      '*.py',
      '*.rs',
      '*.go',
      '*.java',
      '*.c',
      '*.cpp',
      '*.h',
      '*.hpp',
      '*.cs',
      '*.rb',
      '*.php',
      '*.swift',
      '*.kt',
    ],
    ['node_modules', 'dist', 'build', 'target', '__pycache__', '.git', 'vendor'],
    2,
  ],
  [
    'documentation',
    'Documentation',
    'Markdown and documentation files',
    'file-text',
    ['*.md', '*.mdx', '*.txt', '*.rst', 'README*', 'LICENSE*', 'CHANGELOG*'],
    ['node_modules', '.git'],
    3,
  ],
  [
    'config-files',
    'Config Files',
    'Configuration and environment files',
    'settings',
    [
      '*.json',
      '*.yaml',
      '*.yml',
      '*.toml',
      '*.ini',
      '*.env*',
      '*.config.*',
      'tsconfig*',
      'package.json',
      'Cargo.toml',
    ],
    ['node_modules', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
    4,
  ],
  [
    'styles',
    'Styles',
    'CSS and styling files',
    'palette',
    ['*.css', '*.scss', '*.sass', '*.less', '*.styl', '*.styled.*'],
    ['node_modules', 'dist'],
    5,
  ],
  [
    'tests',
    'Tests',
    'Test files only',
    'flask-conical',
    ['*.test.*', '*.spec.*', '**/__tests__/**', '**/tests/**', '**/test/**'],
    ['node_modules', 'coverage'],
    6,
  ],
  [
    'all-files',
    'All Files',
    'Show all files without filtering',
    'folder-open',
    ['*'],
    ['node_modules', '.git', 'dist', 'build'],
    7,
  ],
] as const;

export const TURSO_SCHEMA_BASELINE_SEED_DML = [
  ...providerSeeds.map((seed) => ({
    params: seed,
    sql: `
      INSERT INTO providers (id, name, sort_order, is_enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        sort_order = excluded.sort_order,
        is_enabled = providers.is_enabled,
        updated_at = ${nowSql}
    `,
  })),
  ...modelSeeds.map((seed) => {
    const parameters = seed.length === 9 ? seed[6] : null;
    const sortOrder = seed.length === 9 ? seed[7] : seed[6];
    const isEnabled = seed.length === 9 ? seed[8] : seed[7];
    return {
      params: [
        seed[0],
        seed[1],
        seed[2],
        seed[3],
        seed[4],
        seed[5],
        parameters,
        sortOrder,
        isEnabled,
      ],
      sql: `
      INSERT INTO models (
        id, provider_id, name, tagline, best_for, capabilities, parameters, sort_order, is_enabled
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider_id = excluded.provider_id,
        name = excluded.name,
        tagline = excluded.tagline,
        best_for = excluded.best_for,
        capabilities = excluded.capabilities,
        parameters = excluded.parameters,
        sort_order = excluded.sort_order,
        is_enabled = models.is_enabled,
        updated_at = ${nowSql}
    `,
    };
  }),
  ...viewFilterPresetSeeds.map((seed) => ({
    params: [
      seed[0],
      seed[1],
      seed[2],
      seed[3],
      JSON.stringify(seed[4]),
      JSON.stringify(seed[5]),
      seed[6],
    ],
    sql: `
      INSERT INTO view_filter_presets (
        id, name, description, icon, includes, excludes, use_regex, is_default, sort_order
      )
      VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        icon = excluded.icon,
        includes = excluded.includes,
        excludes = excluded.excludes,
        use_regex = excluded.use_regex,
        is_default = view_filter_presets.is_default,
        sort_order = view_filter_presets.sort_order,
        updated_at = ${nowSql}
    `,
  })),
] as const;

export const TURSO_SCHEMA_BASELINE_CHECKSUM = computeTursoSchemaChecksum([
  ...TURSO_SCHEMA_BASELINE_DDL,
  ...TURSO_SCHEMA_BASELINE_SEED_DML,
]);

export const TURSO_SCHEMA_BASELINE_V2_CHECKSUM =
  '9886965b9577881c6af49ffd179c43d25eada1622390d4c223d6bc4e2e92bd1a';
export const TURSO_SCHEMA_BASELINE_V3_CHECKSUM =
  'ac49c1b4765e2947d3d8fc880de384f61f46e0ef697b5be95ceb8996da9088d7';
export const TURSO_SCHEMA_BASELINE_V4_CHECKSUM =
  '38b2d36ad2a152baa5748bcd37b78d535bb0799fe1be689baa387de13985b190';
export const TURSO_SCHEMA_BASELINE_V5_CHECKSUM =
  'de6b684b37a9e876c9124e64c3d40abdc95ded9946a0b7654f2be3e94733b18c';

const TURSO_SCHEMA_BASELINE_UPGRADE_DDL_BY_PREVIOUS_VERSION = {
  [TURSO_SCHEMA_BASELINE_PREVIOUS_VERSION]: [
    workspaceIndexSystemRoleIndexDdl,
    jobQueueActiveDedupeIndexDdl,
    fileRecordNameIndexTableDdl,
    fileRecordNameGramsTableDdl,
    fileRecordNameGramsIndexDdl,
    fileChunkContentIndexTableDdl,
    fileChunkContentGramsTableDdl,
    fileChunkContentGramsIndexDdl,
  ],
  [TURSO_SCHEMA_BASELINE_V2_VERSION]: [
    jobQueueActiveDedupeIndexDdl,
    fileRecordNameIndexTableDdl,
    fileRecordNameGramsTableDdl,
    fileRecordNameGramsIndexDdl,
    fileChunkContentIndexTableDdl,
    fileChunkContentGramsTableDdl,
    fileChunkContentGramsIndexDdl,
  ],
  [TURSO_SCHEMA_BASELINE_V3_VERSION]: [
    fileRecordNameIndexTableDdl,
    fileRecordNameGramsTableDdl,
    fileRecordNameGramsIndexDdl,
    fileChunkContentIndexTableDdl,
    fileChunkContentGramsTableDdl,
    fileChunkContentGramsIndexDdl,
  ],
  [TURSO_SCHEMA_BASELINE_V4_VERSION]: [
    fileChunkContentIndexTableDdl,
    fileChunkContentGramsTableDdl,
    fileChunkContentGramsIndexDdl,
  ],
  [TURSO_SCHEMA_BASELINE_V5_VERSION]: [],
} as const;

const TURSO_SCHEMA_BASELINE_CHECKSUM_BY_PREVIOUS_VERSION = {
  [TURSO_SCHEMA_BASELINE_PREVIOUS_VERSION]: TURSO_SCHEMA_BASELINE_PREVIOUS_CHECKSUM,
  [TURSO_SCHEMA_BASELINE_V2_VERSION]: TURSO_SCHEMA_BASELINE_V2_CHECKSUM,
  [TURSO_SCHEMA_BASELINE_V3_VERSION]: TURSO_SCHEMA_BASELINE_V3_CHECKSUM,
  [TURSO_SCHEMA_BASELINE_V4_VERSION]: TURSO_SCHEMA_BASELINE_V4_CHECKSUM,
  [TURSO_SCHEMA_BASELINE_V5_VERSION]: TURSO_SCHEMA_BASELINE_V5_CHECKSUM,
} as const;

export async function applyTursoSchemaBaseline(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  await client.exec('PRAGMA foreign_keys = ON');
  await runTursoSchemaTransaction(client, async (tx) => {
    await assertNoPostgresMigrationLedgers(tx);
    await ensureTursoSchemaLedger(tx);
    await assertTursoSchemaLedgerHasNoUnknownVersions(tx, [
      TURSO_SCHEMA_BASELINE_PREVIOUS_VERSION,
      TURSO_SCHEMA_BASELINE_V2_VERSION,
      TURSO_SCHEMA_BASELINE_V3_VERSION,
      TURSO_SCHEMA_BASELINE_V4_VERSION,
      TURSO_SCHEMA_BASELINE_V5_VERSION,
      TURSO_SCHEMA_BASELINE_VERSION,
    ]);

    const existingEntry = await readTursoSchemaLedgerEntry(tx, TURSO_SCHEMA_BASELINE_VERSION);
    if (existingEntry) {
      if (existingEntry.checksum !== TURSO_SCHEMA_BASELINE_CHECKSUM) {
        throw new Error(
          `Turso schema baseline ${TURSO_SCHEMA_BASELINE_VERSION} checksum mismatch: expected ${TURSO_SCHEMA_BASELINE_CHECKSUM}, found ${existingEntry.checksum}.`
        );
      }
      return;
    }

    const upgradeVersions = [
      TURSO_SCHEMA_BASELINE_V5_VERSION,
      TURSO_SCHEMA_BASELINE_V4_VERSION,
      TURSO_SCHEMA_BASELINE_V3_VERSION,
      TURSO_SCHEMA_BASELINE_V2_VERSION,
      TURSO_SCHEMA_BASELINE_PREVIOUS_VERSION,
    ] as const;
    for (const upgradeVersion of upgradeVersions) {
      const previousEntry = await readTursoSchemaLedgerEntry(tx, upgradeVersion);
      if (!previousEntry) {
        continue;
      }
      const expectedChecksum = TURSO_SCHEMA_BASELINE_CHECKSUM_BY_PREVIOUS_VERSION[upgradeVersion];
      if (previousEntry.checksum !== expectedChecksum) {
        throw new Error(
          `Turso schema baseline ${upgradeVersion} checksum mismatch: expected ${expectedChecksum}, found ${previousEntry.checksum}.`
        );
      }
      for (const ddl of TURSO_SCHEMA_BASELINE_UPGRADE_DDL_BY_PREVIOUS_VERSION[upgradeVersion]) {
        await tx.exec(ddl);
      }
      await backfillQuickOpenNameGrams(tx);
      await backfillGrepContentIndex(tx);
      await applyTursoSchemaBaselineSeeds(tx);
      await recordTursoSchemaLedgerEntry(tx, {
        checksum: TURSO_SCHEMA_BASELINE_CHECKSUM,
        version: TURSO_SCHEMA_BASELINE_VERSION,
      });
      return;
    }

    for (const ddl of TURSO_SCHEMA_BASELINE_DDL) {
      await tx.exec(ddl);
    }
    await applyTursoSchemaBaselineSeeds(tx);
    await recordTursoSchemaLedgerEntry(tx, {
      checksum: TURSO_SCHEMA_BASELINE_CHECKSUM,
      version: TURSO_SCHEMA_BASELINE_VERSION,
    });
  });
}

async function applyTursoSchemaBaselineSeeds(tx: BrainstrikeDbTransactionClient): Promise<void> {
  for (const statement of TURSO_SCHEMA_BASELINE_SEED_DML) {
    await tx.exec(statement.sql, statement.params);
  }
}

function runTursoSchemaTransaction<TResult>(
  client: BrainstrikeDbExecutionClient,
  callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
): Promise<TResult> {
  if ('exclusiveTransaction' in client) {
    const exclusiveTransaction = client.exclusiveTransaction;
    if (typeof exclusiveTransaction !== 'function') {
      throw new Error('Turso schema client exposes a non-callable exclusiveTransaction member.');
    }
    return exclusiveTransaction(callback);
  }
  return client.transaction(callback);
}
