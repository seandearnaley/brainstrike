/**
 * Supported deterministic producer seam for cross-package watcher contract
 * tests. Production consumers must use the adapter-owned watcher entrypoints.
 */

export type { ParcelWatcherModule } from '../adapters/parcel-backend.js';
export type { StartParcelWatchOptions } from '../adapters/parcel-watchers.js';
export { startParcelWatch } from '../adapters/parcel-watchers.js';
