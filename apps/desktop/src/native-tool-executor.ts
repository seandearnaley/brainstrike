/**
 * Native tool executor for the Tool Playground.
 * Executes self-contained web tools that don't require database access.
 */
import { z } from 'zod';

// ============================================================================
// Types
// ============================================================================

export interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

interface WebDocEntry {
  id: string;
  title: string;
  summary: string;
  url: string;
  tags: readonly string[];
  sections: readonly string[];
  versionIntroduced?: string;
}

type IndexedDoc = WebDocEntry & {
  tokens: Set<string>;
  titleTokens: Set<string>;
  sentenceTokens: Array<{ text: string; tokens: Set<string> }>;
};

interface SearchResult {
  id: string;
  title: string;
  summary: string;
  url: string;
  highlight: string;
  tags: readonly string[];
  score: number;
}

interface SearchResponse {
  query: string;
  limit: number;
  totalResults: number;
  tookMs: number;
  results: readonly SearchResult[];
}

interface DocSummaryResponse {
  doc: {
    id: string;
    title: string;
    summary: string;
    url: string;
    tags: readonly string[];
    versionIntroduced?: string;
    sections: ReadonlyArray<{ id: string; text: string }>;
  };
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_SEARCH_LIMIT = 5;

/** Set of tool IDs that can be executed natively (without database access) */
const EXECUTABLE_NATIVE_TOOLS = new Set(['web.searchDocs', 'web.docSummary']);

/** Documentation index for search */
const DOCS_INDEX: readonly WebDocEntry[] = [
  {
    id: 'assistant-ui-integration',
    title: 'Assistant UI Integration Guide',
    summary:
      'Embed the Assistant-UI panel into the Brainstrike IDE right panel and wire transports for both web and desktop.',
    url: '/docs/assistant/assistant-ui-integration',
    tags: ['assistant-ui', 'web', 'desktop'],
    sections: [
      'Enable Assistant-UI globally unless the APP_SHELL_ASSISTANT_UI flag is explicitly disabled.',
      'AssistantUiPanel expects streaming responses that follow the AI SDK v5 format with tool events.',
      'Desktop runtime exposes a preload bridge for local assistant transport discovery.',
    ],
    versionIntroduced: '2025.09',
  },
  {
    id: 'web-tool-dispatcher',
    title: 'Web Tool Dispatcher Patterns',
    summary:
      'Outline for building safe read-only tool dispatchers on the web tier, including schema validation and streaming progress.',
    url: '/docs/assistant/web-tool-dispatcher',
    tags: ['web', 'tools', 'progress'],
    sections: [
      'Validate inputs using shared zod schemas from @brainstrike/agent before invoking tool logic.',
      'Implement deterministic progress updates to keep Assistant-UI responsive during server work.',
      'Limit output payload size and strip secrets when proxying to external services.',
    ],
    versionIntroduced: '2025.09',
  },
  {
    id: 'desktop-safe-storage',
    title: 'Desktop Safe Storage & Secrets',
    summary:
      'Describes how provider API keys are encrypted via Electron safeStorage and surfaced to the renderer through IPC.',
    url: '/docs/desktop/safe-storage',
    tags: ['desktop', 'security', 'safeStorage'],
    sections: [
      'Keys are encrypted before writing to disk and decrypted lazily on demand by the assistant server.',
      'Preload exposes a narrow context bridge with explicit allow-listing for secrets APIs.',
      'Unit and E2E coverage ensure keys survive restart and remain unreadable in plaintext.',
    ],
    versionIntroduced: '2025.08',
  },
  {
    id: 'mcp-hot-reload',
    title: 'MCP Hot Reload Lifecycle',
    summary:
      'Documents the filesystem watcher that reloads Model Context Protocol servers when mcp.config.json changes.',
    url: '/docs/assistant/mcp-hot-reload',
    tags: ['desktop', 'mcp', 'tools'],
    sections: [
      'Watchers debounce file writes and rebuild MCP clients with decrypted credentials.',
      'Progress events bubble to Assistant-UI to reflect tool initialization steps.',
      'Errors in config parsing surface as inline tool errors without crashing the agent runtime.',
    ],
    versionIntroduced: '2025.09',
  },
  {
    id: 'guardrails-and-telemetry',
    title: 'Guardrails & Telemetry Checklist',
    summary:
      'Checklist for validating tool input/output schemas, enforcing rate limits, and capturing assistant telemetry.',
    url: '/docs/assistant/guardrails',
    tags: ['guardrails', 'telemetry', 'quality'],
    sections: [
      'Wrap tool dispatches with structured logging for latency and token usage.',
      'Emit progress updates for long-running operations to keep the UI from appearing stalled.',
      'Document fallback behaviors and error handling strategy before shipping to production.',
    ],
    versionIntroduced: '2025.09',
  },
];

// ============================================================================
// Input Schemas
// ============================================================================

const searchDocsInputSchema = z.object({
  query: z.string().min(2).max(200),
  limit: z.number().int().positive().max(10).optional(),
});

const docSummaryInputSchema = z.object({
  docId: z.string().min(1).max(120),
});

// ============================================================================
// Indexing Functions
// ============================================================================

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function splitIntoSentences(value: string): string[] {
  const matches = value.match(/[^.!?]+[.!?]?/g);
  if (!matches) {
    return [value];
  }
  return matches.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

function indexDocs(entries: readonly WebDocEntry[]): {
  docs: readonly IndexedDoc[];
  map: ReadonlyMap<string, IndexedDoc>;
} {
  const docs: IndexedDoc[] = entries.map((entry) => {
    const combined = [entry.title, entry.summary, entry.sections.join(' '), entry.tags.join(' ')]
      .join(' ')
      .trim();
    const tokens = new Set<string>(tokenize(combined));
    const titleTokens = new Set<string>(tokenize(entry.title));
    const sentenceTokens = splitIntoSentences([entry.summary, ...entry.sections].join(' ')).map(
      (sentence) => ({
        text: sentence,
        tokens: new Set<string>(tokenize(sentence)),
      })
    );
    return {
      ...entry,
      tokens,
      titleTokens,
      sentenceTokens,
    } satisfies IndexedDoc;
  });
  const map = new Map<string, IndexedDoc>();
  for (const doc of docs) {
    map.set(doc.id, doc);
  }
  return { docs, map };
}

const { docs: INDEXED_DOCS, map: INDEXED_DOC_MAP } = indexDocs(DOCS_INDEX);

// ============================================================================
// Scoring Functions
// ============================================================================

function scoreDoc(doc: IndexedDoc, tokens: readonly string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  let score = 0;
  const uniqueTokens = new Set(tokens);
  for (const token of uniqueTokens) {
    if (doc.titleTokens.has(token)) {
      score += 2;
    } else if (doc.tokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

function findHighlight(doc: IndexedDoc, tokens: readonly string[]): string {
  for (const sentence of doc.sentenceTokens) {
    for (const token of tokens) {
      if (sentence.tokens.has(token)) {
        return sentence.text;
      }
    }
  }
  return doc.summary;
}

function tokenizeQuery(query: string): string[] {
  return tokenize(query).slice(0, 8);
}

// ============================================================================
// Tool Execution Functions
// ============================================================================

async function searchDocsExecute(
  input: z.infer<typeof searchDocsInputSchema>
): Promise<SearchResponse> {
  const query = (input.query ?? '').trim();
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  const startedAt = Date.now();

  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) {
    return {
      query,
      limit,
      totalResults: 0,
      tookMs: Date.now() - startedAt,
      results: [],
    } satisfies SearchResponse;
  }

  const ranked: Array<{ doc: IndexedDoc; score: number; highlight: string }> = [];
  for (const doc of INDEXED_DOCS) {
    const score = scoreDoc(doc, queryTokens);
    if (score > 0) {
      ranked.push({
        doc,
        score,
        highlight: findHighlight(doc, queryTokens),
      });
    }
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.doc.title.localeCompare(b.doc.title);
  });

  const top = ranked.slice(0, limit);
  return {
    query,
    limit,
    totalResults: ranked.length,
    tookMs: Date.now() - startedAt,
    results: top.map(({ doc, score, highlight }) => ({
      id: doc.id,
      title: doc.title,
      summary: doc.summary,
      url: doc.url,
      highlight,
      tags: doc.tags,
      score,
    })),
  } satisfies SearchResponse;
}

async function docSummaryExecute(
  input: z.infer<typeof docSummaryInputSchema>
): Promise<DocSummaryResponse> {
  const docId = (input.docId ?? '').trim();
  const doc = docId.length > 0 ? INDEXED_DOC_MAP.get(docId) : undefined;

  if (!doc) {
    throw new Error(`Document not found: ${docId}`);
  }

  const sections = doc.sections.map((text, index) => ({
    id: `${doc.id}-section-${index + 1}`,
    text,
  }));

  const baseDoc = {
    id: doc.id,
    title: doc.title,
    summary: doc.summary,
    url: doc.url,
    tags: doc.tags,
    sections,
  };

  const docPayload = doc.versionIntroduced
    ? { ...baseDoc, versionIntroduced: doc.versionIntroduced }
    : baseDoc;

  return {
    doc: docPayload,
  } satisfies DocSummaryResponse;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Checks if a tool ID is an executable native tool.
 * Native tools are self-contained and don't require database access.
 */
export function isExecutableNativeTool(toolId: string): boolean {
  return EXECUTABLE_NATIVE_TOOLS.has(toolId);
}

/**
 * Executes a native tool with the given input.
 * Returns a result object with success status, result/error, and duration.
 */
export async function executeNativeTool(
  toolId: string,
  input: unknown
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();

  try {
    if (!isExecutableNativeTool(toolId)) {
      return {
        success: false,
        error: `Tool "${toolId}" is not supported for native execution`,
        durationMs: Date.now() - startedAt,
      };
    }

    if (toolId === 'web.searchDocs') {
      const parsed = searchDocsInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          success: false,
          error: `Invalid input: ${parsed.error.message}`,
          durationMs: Date.now() - startedAt,
        };
      }
      const result = await searchDocsExecute(parsed.data);
      return {
        success: true,
        result,
        durationMs: Date.now() - startedAt,
      };
    }

    if (toolId === 'web.docSummary') {
      const parsed = docSummaryInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          success: false,
          error: `Invalid input: ${parsed.error.message}`,
          durationMs: Date.now() - startedAt,
        };
      }
      const result = await docSummaryExecute(parsed.data);
      return {
        success: true,
        result,
        durationMs: Date.now() - startedAt,
      };
    }

    // This should never be reached due to the isExecutableNativeTool check
    return {
      success: false,
      error: `Tool "${toolId}" is not supported for native execution`,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage,
      durationMs: Date.now() - startedAt,
    };
  }
}
