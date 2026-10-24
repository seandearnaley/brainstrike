/**
 * Supported deterministic producer seam for cross-package watcher contract
 * tests. Production consumers must use the adapter-owned watcher entrypoints.
 */

export type { ParcelWatcherModule } from '../adapters/parcel-backend.ts';
export type { StartParcelWatchOptions } from '../adapters/parcel-watchers.ts';
export { startParcelWatch } from '../adapters/parcel-watchers.ts';
