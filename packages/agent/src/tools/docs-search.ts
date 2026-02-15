import { z } from 'zod';

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const MAX_QUERY_LENGTH = 200;
const MAX_QUERY_TOKENS = 8;

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

export interface SearchResult {
  id: string;
  title: string;
  summary: string;
  url: string;
  highlight: string;
  tags: readonly string[];
  score: number;
}

export interface SearchResponse {
  query: string;
  limit: number;
  totalResults: number;
  tookMs: number;
  results: readonly SearchResult[];
}

export interface DocSummaryResponse {
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

const DOCS_INDEX: readonly WebDocEntry[] = [
  {
    id: 'assistant-ui-integration',
    title: 'Assistant UI Runtime Handoff (2025-09-14)',
    summary:
      'Archived handoff covering assistant runtime behavior and integration checkpoints for the 2025-09-14 implementation phase.',
    url: '/archive/arch-logs/assistant-ui-runtime-handoff-2025-09-14',
    tags: ['assistant-ui', 'runtime', 'handoff'],
    sections: [
      'Tracks runtime integration decisions and implementation notes for the assistant UI.',
      'Captures risks and follow-up tasks recorded at handoff time.',
      'Useful when debugging regressions tied to historical runtime integration changes.',
    ],
    versionIntroduced: '2025.09',
  },
  {
    id: 'web-tool-dispatcher',
    title: 'Tool Execution IPC Bridge Plan (2026-02-02)',
    summary:
      'Plan for bridging tool execution over IPC with explicit contracts, safety boundaries, and implementation sequencing.',
    url: '/archive/plans/tool-execution-ipc-bridge-2026-02-02',
    tags: ['tools', 'ipc', 'planning'],
    sections: [
      'Defines the IPC bridge shape and expected request/response behavior.',
      'Documents sequencing for rollout and validation criteria.',
      'Focuses on safe tool execution boundaries between renderer and main process.',
    ],
    versionIntroduced: '2025.09',
  },
  {
    id: 'desktop-safe-storage',
    title: 'AI Tools Settings Implementation Plan (2026-02-01)',
    summary:
      'Implementation plan for AI tools settings, including provider configuration flow and supporting UI behavior.',
    url: '/archive/plans/ai-tools-settings-implementation-2026-02-01',
    tags: ['settings', 'ai-tools', 'planning'],
    sections: [
      'Covers settings model, persistence expectations, and UI control surface.',
      'Describes implementation milestones for provider/tool settings behavior.',
      'Useful for tracing why settings UX behaves as it does in current builds.',
    ],
    versionIntroduced: '2025.08',
  },
  {
    id: 'mcp-hot-reload',
    title: 'MCP Client Duplicate Initialization Fix (2025-10-05)',
    summary:
      'Archive handoff describing a fix for duplicate MCP client initialization and related runtime stability issues.',
    url: '/archive/cold/handoffs/20251005-112340-mcp-client-duplicate-initialization-fix',
    tags: ['mcp', 'stability', 'handoff'],
    sections: [
      'Explains symptoms and root-cause analysis for duplicate MCP initialization.',
      'Documents mitigation and verification steps used during the fix.',
      'Helps diagnose similar MCP lifecycle regressions.',
    ],
    versionIntroduced: '2025.09',
  },
  {
    id: 'guardrails-and-telemetry',
    title: 'Embedding Queue Telemetry Sink Handoff (2025-02-14)',
    summary:
      'Archived handoff for queue telemetry sink behavior, including event capture and operational expectations.',
    url: '/archive/cold/handoffs/20250214-embedding-queue-telemetry-sink',
    tags: ['queue', 'telemetry', 'handoff'],
    sections: [
      'Describes telemetry payload flow and sink integration details.',
      'Captures operational constraints and expected signal behavior.',
      'Useful when investigating queue metrics and telemetry regressions.',
    ],
    versionIntroduced: '2025.09',
  },
];

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
    };
  });
  const map = new Map<string, IndexedDoc>(docs.map((doc) => [doc.id, doc]));
  return { docs, map };
}

const { docs: INDEXED_DOCS, map: INDEXED_DOC_MAP } = indexDocs(DOCS_INDEX);

function scoreDoc(doc: IndexedDoc, queryTokens: readonly string[]): number {
  let score = 0;
  for (const token of queryTokens) {
    if (doc.titleTokens.has(token)) {
      score += 10;
    }
    if (doc.tokens.has(token)) {
      score += 4;
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
  return tokenize(query).slice(0, MAX_QUERY_TOKENS);
}

export const searchDocsInputSchema = z.object({
  query: z
    .string()
    .min(2, 'Query must be at least 2 characters')
    .max(MAX_QUERY_LENGTH, `Query must be at most ${MAX_QUERY_LENGTH} characters`)
    .transform((value) => value.trim())
    .refine((value) => !value.includes('\0'), 'Query cannot contain null bytes')
    .refine((value) => value.length >= 2, 'Query must be at least 2 characters'),
  limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
});

export const docSummaryInputSchema = z.object({
  docId: z.string().min(1).max(120),
});

export async function searchDocsExecute(
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

export async function docSummaryExecute(
  input: z.infer<typeof docSummaryInputSchema>
): Promise<DocSummaryResponse> {
  const docId = (input.docId ?? '').trim();
  const doc = docId.length > 0 ? INDEXED_DOC_MAP.get(docId) : undefined;

  if (!doc) {
    throw new Error(`Doc not found: ${docId}`);
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
