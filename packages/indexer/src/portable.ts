/**
 * The indexer's few platform needs, written so its store runs both in the
 * desktop's utility process and in the browser writer (BST-1940). Hashing
 * uses Node's native SHA-256 where the runtime provides it and the same
 * SHA-256 from `@noble/hashes` elsewhere. Random ids come from Web Crypto.
 * Float32 vectors are plain little-endian bytes, not Node Buffers.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

const nodeCrypto = globalThis.process?.getBuiltinModule?.('node:crypto');
const nodePath = globalThis.process?.getBuiltinModule?.('node:path');
const utf8 = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
}

/** SHA-256 of `text`'s UTF-8 bytes. */
export function sha256Bytes(text: string): Uint8Array {
  return nodeCrypto
    ? new Uint8Array(nodeCrypto.createHash('sha256').update(text).digest())
    : nobleSha256(utf8.encode(text));
}

/** SHA-256 of `text`'s UTF-8 bytes, as lowercase hex. */
export function sha256Hex(text: string): string {
  return nodeCrypto
    ? nodeCrypto.createHash('sha256').update(text).digest('hex')
    : hex(nobleSha256(utf8.encode(text)));
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
  return nodePath ? nodePath.basename(path) : basenamePosix(path);
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
