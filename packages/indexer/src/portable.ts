/**
 * The indexer's few platform needs, written so its store runs both in the
 * desktop's utility process and in the browser writer (BST-1940). Hashing is
 * `@brainstrike/utils/crypto`'s synchronous SHA-256 (Node's native crypto
 * where the runtime provides it). Random ids come from Web Crypto.
 * Float32 vectors are plain little-endian bytes, not Node Buffers.
 */
export { sha256Bytes, sha256Hex } from '@brainstrike/utils/crypto';

import { hostBasename } from '@brainstrike/utils/host-path';

function hex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
}

/** `byteCount` random bytes, as lowercase hex. */
export function randomHex(byteCount: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

/** A root-relative path is never absolute; the store's paths are always posix. */
export function isAbsolutePosix(path: string): boolean {
  return path.startsWith('/');
}

/** `path.posix.basename`: the last segment, ignoring trailing separators. */
export function basenamePosix(path: string): string {
  const trimmed = path.replace(/\/+$/u, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** A source file's own name, by the host's path rules: Node's on desktop (Windows separators included). */
export function basenameOfSource(path: string): string {
  return hostBasename(path);
}

/** The float32 little-endian bytes of `values`. */
export function float32Bytes(values: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) {
    view.setFloat32(index * 4, values[index] as number, true);
  }
  return bytes;
}

/** The float32 value at `index` of little-endian `bytes`. */
export function float32At(bytes: Uint8Array, index: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(index * 4, true);
}
