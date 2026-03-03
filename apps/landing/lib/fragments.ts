export interface CodeFragment {
  delay: number; // 0 to 1.2s
  id: string;
  relevant: boolean;
  speed: number; // duration of fall
  text: string;
  x: number; // 0 to 90 percentage
  y: number; // vertical position as vh percentage
  z: number; // -400 to 400 for translateZ
}

const RAW_FRAGMENTS = [
  { text: 'src/pipeline/index.ts', relevant: false },
  { text: 'embedQueue.process()', relevant: true },
  { text: '## Vector Search Tuning', relevant: false },
  { text: "import { PGlite } from '@electric-sql/pglite'", relevant: false },
  { text: 'export async function chunkFile(content)', relevant: false },
  { text: "await queue.add('embed', { text })", relevant: true },
  { text: 'SELECT id FROM vectors ORDER BY embedding <-> $1 LIMIT 5', relevant: false },
  { text: 'const CHUNK_SIZE = 512', relevant: false },
  { text: 'CREATE EXTENSION IF NOT EXISTS vector;', relevant: false },
  { text: 'class EmbeddingWorker extends Worker', relevant: true },
  { text: 'src/db/schema.ts', relevant: false },
  { text: 'function cosineSimilarity(a, b)', relevant: false },
  { text: "redis.rpush('queue:embed', job)", relevant: true },
  { text: 'interface Job { id: string; payload: any }', relevant: false },
  { text: "catch (err) { logger.error('Pipeline failed', err) }", relevant: false },
  { text: 'const tokenizer = new Tiktoken()', relevant: false },
  { text: 'src/workers/embed.ts', relevant: true },
  { text: 'while (true) { const job = await queue.take() }', relevant: true },
  { text: 'export default function App()', relevant: false },
  { text: 'const [isPending, startTransition] = useTransition()', relevant: false },
  { text: "import { motion } from 'motion/react'", relevant: false },
  { text: 'processQueue(batchSize: 10)', relevant: true },
  { text: 'type FileNode = { path: string, content: string }', relevant: false },
  { text: 'await db.insert(documents).values(doc)', relevant: false },
  { text: 'if (file.size > MAX_SIZE) throw new Error()', relevant: false },
  { text: 'module.exports = { theme: { extend: {} } }', relevant: false },
  { text: 'const cache = new LRUCache({ max: 500 })', relevant: false },
  { text: "import { z } from 'zod'", relevant: false },
  { text: 'const QuerySchema = z.object({ q: z.string() })', relevant: false },
  { text: "queue.on('completed', job => { ... })", relevant: true },
  { text: 'components/SearchInput.tsx', relevant: false },
  { text: 'const embedding = await openai.embeddings.create()', relevant: false },
  { text: "export const dynamic = 'force-dynamic'", relevant: false },
  { text: 'function renderNode(node: ASTNode)', relevant: false },
  { text: 'const match = text.match(/[A-Z][a-z]+/g)', relevant: false },
  { text: 'docs/architecture.md', relevant: false },
  { text: '# BrainStrike Architecture', relevant: false },
  { text: "import { createStore } from 'zustand'", relevant: false },
  { text: 'export const useSearchStore = createStore()', relevant: false },
  { text: 'function debounce(fn, ms)', relevant: false },
  { text: 'await Promise.all(chunks.map(embed))', relevant: false },
  { text: "import { generateId } from '@/lib/utils'", relevant: false },
  { text: 'let retryCount = 0', relevant: false },
  { text: "case 'INDEXING': return <Spinner />", relevant: false },
  { text: 'const pg = new PGlite()', relevant: false },
  { text: "if (!db) throw new Error('DB not initialized')", relevant: false },
  { text: 'src/utils/text.ts', relevant: false },
  { text: "return chunks.join('\\n')", relevant: false },
  { text: 'export const API_URL = process.env.NEXT_PUBLIC_API', relevant: false },
  { text: "console.log('Worker started')", relevant: false },
];

export function generateFragments(): CodeFragment[] {
  return RAW_FRAGMENTS.map((frag, i) => {
    // Deterministic pseudo-random generation for stable hydration
    const x = (i * 137) % 90; // 0-89%, leaves room for text
    const y = ((i * 71 + 13) % 90) + 5; // 5-94% of viewport height
    const z = -400 + ((i * 53) % 800);
    const delay = ((i * 17) % 120) / 100;
    const speed = 2 + ((i * 23) % 30) / 10;

    return {
      id: `frag-${i}`,
      text: frag.text,
      x,
      y,
      z,
      delay,
      speed,
      relevant: frag.relevant,
    };
  });
}
