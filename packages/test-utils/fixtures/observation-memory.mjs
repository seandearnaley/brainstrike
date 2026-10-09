import { createRequire } from 'node:module';

// Node-only qualification fixture uses this package's existing pinned vendor owner.
const require = createRequire(import.meta.url);
export const { Memory } = require('@mastra/memory');
export const { InMemoryStore } = require('@mastra/core/storage');
export const {
  parseObservationGroups,
  TokenCounter,
  wrapInObservationGroup,
} = require('@mastra/memory/processors');
