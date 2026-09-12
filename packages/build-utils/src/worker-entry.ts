import type { Plugin } from 'vite';

/**
 * Keep worker startup out of chunks imported by lazy dependencies. Managed
 * workers have an instance URL fragment; importing that entry without its
 * fragment would evaluate startup again in the same worker global.
 */
export function preserveWorkerEntryPlugin(): Plugin {
  return {
    name: 'brainstrike-preserve-worker-entry',
    // Vite sets preserveEntrySignatures:false after spreading worker options.
    // The documented bundler options hook runs afterward and keeps a facade.
    options(options) {
      return { ...options, preserveEntrySignatures: 'strict' };
    },
  };
}
