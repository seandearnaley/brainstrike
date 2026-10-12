import type { ParcelBackendName } from './parcel-backend.js';

// Parcel 2.6.0 emits these exact messages for MustScanSubDirs while retaining
// the FSEvents subscription. Other backend errors do not establish that fact.
// https://github.com/parcel-bundler/watcher/blob/v2.6.0/src/macos/FSEventsBackend.cc
const FSEVENTS_RESCAN_MESSAGES: ReadonlySet<string> = new Set([
  'Events were dropped by the FSEvents client. File system must be re-scanned.',
  'Events were dropped by the kernel. File system must be re-scanned.',
  'Too many events. File system must be re-scanned.',
]);

export function classifyParcelWatchFailure(
  backend: ParcelBackendName,
  error: Error
): 'backend-error' | 'rescan-required' {
  return backend === 'fs-events' && FSEVENTS_RESCAN_MESSAGES.has(error.message)
    ? 'rescan-required'
    : 'backend-error';
}
