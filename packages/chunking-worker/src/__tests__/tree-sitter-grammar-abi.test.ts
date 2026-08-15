/**
 * Vendored-grammar format guard (BST-1277).
 *
 * `grammars/python.wasm` is a checked-in binary with no import graph, so
 * nothing else in this suite can notice if it is replaced by a build with the
 * wrong shape. Two properties of that file decide whether `Language.load()`
 * works at all, and both are invisible in a `git diff` of a `.wasm` blob:
 *
 *  - **The Emscripten dynamic-link custom section must be named `dylink.0`.**
 *    Grammars built with tree-sitter-cli 0.20.x emit the LEGACY `dylink` name.
 *    web-tree-sitter 0.25.x still accepts it; 0.26.x deleted that fallback and
 *    `getDylinkMetadata` throws a bare `Error` with an empty message on the
 *    legacy name. That is what the previous grammar (sourced from the now
 *    abandoned `tree-sitter-wasms@0.1.13`) did.
 *  - **The language ABI version must be >= 15.** ABI 14 is the tree-sitter
 *    0.20-era encoding; the runtime this package pins reads 15.
 *
 * Failure mode when either regresses is silent by design: the loader in
 * `tree-sitter-grammar-loader.ts` catches, evicts, and the chunker falls back
 * to recursive splitting. Nothing crashes, chunk quality just quietly drops.
 * Hence a direct assertion on the bytes.
 *
 * The sha256 also records provenance. The current bytes are
 * `tree-sitter-python@0.25.0`'s package-root `tree-sitter-python.wasm`
 * (github.com/tree-sitter/tree-sitter-python — the canonical grammar repo).
 * `@vscode/tree-sitter-wasm@0.3.1` ships a byte-identical copy of the same
 * artifact. Re-vendoring is expected to change this constant; doing so should
 * be a deliberate edit next to fresh equivalence evidence, not a silent
 * binary swap.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Language, Parser } from 'web-tree-sitter';

const GRAMMAR_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'grammars',
  'python.wasm'
);

/**
 * sha256 of `tree-sitter-python@0.25.0`'s `tree-sitter-python.wasm`.
 *
 * Regenerate — and verify the vendored blob's provenance — with:
 *
 *   npm pack tree-sitter-python@0.25.0
 *   tar -xOf tree-sitter-python-0.25.0.tgz package/tree-sitter-python.wasm | shasum -a 256
 *   # → 16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47
 *
 * Confirmed against the published tarball on 2026-08-15: upstream's bytes and
 * the checked-in blob hash identically, so this constant asserts origin rather
 * than merely asserting that the file has not changed since it was committed.
 */
const EXPECTED_SHA256 = '16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47';

/** web-tree-sitter 0.26.x accepts only this section name. `dylink` is fatal. */
const REQUIRED_DYLINK_SECTION = 'dylink.0';

const MINIMUM_ABI_VERSION = 15;

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const CUSTOM_SECTION_ID = 0;

interface Cursor {
  readonly offset: number;
  readonly value: number;
}

function readUleb128(bytes: Uint8Array, start: number): Cursor {
  let value = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    const byte = bytes[offset];
    if (byte === undefined) {
      throw new Error(`Truncated LEB128 at offset ${offset}`);
    }
    offset += 1;
    // Multiply rather than `<<`: bitwise operators coerce to int32, which would
    // flip sign at shift >= 28 and wrap entirely at shift >= 32 (JS shifts are
    // mod 32). Nothing in a 457 KB module with 1-3 byte section sizes can reach
    // that, but this helper reads as general-purpose LEB128 and a negative
    // `value` would rewind `offset` and spin the section loop.
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { offset, value };
    }
    shift += 7;
  }
}

/** Names of every custom section in a WASM module, in file order. */
function customSectionNames(bytes: Uint8Array): string[] {
  for (const [index, expected] of WASM_MAGIC.entries()) {
    if (bytes[index] !== expected) {
      throw new Error('Vendored grammar is not a WASM module');
    }
  }
  const names: string[] = [];
  const decoder = new TextDecoder();
  // 4-byte magic + 4-byte version.
  let offset = 8;
  while (offset < bytes.length) {
    const sectionId = bytes[offset];
    if (sectionId === undefined) {
      break;
    }
    offset += 1;
    const size = readUleb128(bytes, offset);
    const bodyStart = size.offset;
    if (sectionId === CUSTOM_SECTION_ID) {
      const nameLength = readUleb128(bytes, bodyStart);
      names.push(
        decoder.decode(bytes.subarray(nameLength.offset, nameLength.offset + nameLength.value))
      );
    }
    offset = bodyStart + size.value;
  }
  return names;
}

describe('vendored python.wasm grammar format', () => {
  it('is the recorded tree-sitter-python@0.25.0 artifact', async () => {
    const bytes = await readFile(GRAMMAR_PATH);

    expect(createHash('sha256').update(bytes).digest('hex')).toBe(EXPECTED_SHA256);
  });

  it('uses the dylink.0 custom-section name web-tree-sitter 0.26.x requires', async () => {
    const bytes = new Uint8Array(await readFile(GRAMMAR_PATH));

    const names = customSectionNames(bytes);

    expect(names).toContain(REQUIRED_DYLINK_SECTION);
    expect(names).not.toContain('dylink');
  });

  it('reports a language ABI version the pinned runtime reads', async () => {
    await Parser.init();
    const language = await Language.load(new Uint8Array(await readFile(GRAMMAR_PATH)));

    expect(language.abiVersion).toBeGreaterThanOrEqual(MINIMUM_ABI_VERSION);
  });
});
