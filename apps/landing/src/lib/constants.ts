import type { LucideIcon } from 'lucide-react';
import { Brain, Database, FolderSearch, Globe, Lock, Search } from 'lucide-react';

export interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
}

export const FEATURES: readonly Feature[] = [
  {
    icon: Search,
    title: 'In-Browser Vector Search',
    description:
      'Generate embeddings and run semantic search entirely in your browser. Find code by meaning, not keywords. No server required.',
  },
  {
    icon: FolderSearch,
    title: 'IDE-Style File Explorer',
    description:
      'Browse, preview, and analyze files with a familiar tabbed interface. Smart chunking breaks code into AI-optimized segments.',
  },
  {
    icon: Database,
    title: 'Zero-Backend Database',
    description:
      'Full PostgreSQL with pgvector running in WebAssembly. HNSW indexes for millisecond similarity search on thousands of chunks.',
  },
  {
    icon: Brain,
    title: 'AI Agent Integration',
    description:
      'Built-in AI assistant powered by Mastra with streaming responses. Retrieves relevant context from your codebase automatically.',
  },
  {
    icon: Globe,
    title: 'Cross-Platform',
    description:
      'Web and Electron desktop from a single codebase. Native file access on desktop, File System Access API on web. Same experience everywhere.',
  },
  {
    icon: Lock,
    title: 'Local-First Privacy',
    description:
      'Your code never leaves your device. Start with free on-device models, optionally connect cloud providers. Zero data leaks.',
  },
] as const;

export interface Step {
  number: string;
  title: string;
  description: string;
}

export const STEPS: readonly Step[] = [
  {
    number: '01',
    title: 'Import',
    description:
      'Drop files or select a folder. BrainStrike discovers and indexes your content with smart file-type detection.',
  },
  {
    number: '02',
    title: 'Embed',
    description:
      'Generate vector embeddings in-browser using local models or cloud providers. Watch real-time progress with throughput metrics.',
  },
  {
    number: '03',
    title: 'Search',
    description:
      'Find anything with natural language. Semantic search understands meaning across your entire codebase in milliseconds.',
  },
] as const;

export interface TechItem {
  name: string;
  category: string;
}

export const TECH_STACK: readonly TechItem[] = [
  { name: 'React 19', category: 'Frontend' },
  { name: 'TypeScript 5.9', category: 'Language' },
  { name: 'Tailwind CSS v4', category: 'Styling' },
  { name: 'PGlite', category: 'Database' },
  { name: 'pgvector', category: 'Search' },
  { name: 'Mastra AI', category: 'Agent' },
  { name: 'Transformers.js', category: 'ML' },
  { name: 'Vite 7', category: 'Build' },
  { name: 'Electron', category: 'Desktop' },
  { name: 'Turborepo', category: 'Monorepo' },
  { name: 'Vitest', category: 'Testing' },
  { name: 'Playwright', category: 'E2E' },
] as const;

export const STATS = [
  { value: 32, suffix: '+', label: 'Packages' },
  { value: 1, suffix: '', label: 'Codebase' },
  { value: 0, suffix: '', label: 'Servers Required' },
] as const;
