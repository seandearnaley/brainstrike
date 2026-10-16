/**
 * M0-A2 Host.toBody's rule for a large text, with no Node module: desktop's
 * writer and the browser's (BST-1940) spool a text the same way.
 */
import { sha256Hex } from '@brainstrike/utils/crypto';
import { utf8ByteLength } from '@brainstrike/utils/utf8';
import type { BlobContent } from './run-log-types.js';

/** Text of this size or more is stored as a content-addressed blob; the event keeps a preview and the hash. */
export const BLOB_MIN_BYTES = 12 * 1024;
export const PREVIEW_CHARS = 2048;

export type StoredText =
  | { readonly output: string }
  | { readonly preview: string; readonly blob: string; readonly bytes: number };

/**
 * The fields to put in the event and, at 12 KB or more, the blob to append
 * with it (`AppendItem.blobs`), so the blob is durable before the event that
 * references it commits.
 */
export function largeText(output: string): {
  readonly fields: StoredText;
  readonly blob: BlobContent | null;
} {
  const bytes = utf8ByteLength(output);
  if (bytes < BLOB_MIN_BYTES) {
    return { blob: null, fields: { output } };
  }
  const hash = sha256Hex(output);
  return {
    blob: { content: output, hash },
    fields: { blob: hash, bytes, preview: output.slice(0, PREVIEW_CHARS) },
  };
}
