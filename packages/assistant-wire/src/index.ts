/**
 * @brainstrike/assistant-wire — the assistant HTTP wire contract (BST-978).
 *
 * Types-first in `indexing-contract`'s actual style: as-const key lists,
 * hand-rolled shapes, no runtime schema dependency, browser-safe (no
 * module-scope value graphs beyond frozen literals — see the chunk-init
 * ordering incident recorded in docs/agents/platform-contracts.md).
 * Zero workspace dependencies by design: this package must stay importable
 * from every surface (renderer bundles, Vercel-traced routes, desktop main).
 */

export * from './rejection.js';
export * from './request-envelope.js';
