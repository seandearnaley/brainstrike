/**
 * Before-state capture classification — proves the "visible degradation, never
 * silent truncation" guarantee: a binary file is refused with hash+size, an
 * oversized file is never read (size only), and both map to a non-revertible
 * capture status with content null. REAL fs in a tmp dir; no DB / electron.
 */

import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beforeStateToCapture,
  captureBeforeState,
} from '../../assistant-server/edit-checkpoint-capture';
import { sha256Hex } from '../../assistant-server/edit-checkpoint-journal';

const MAX_BYTES = 2 * 1024 * 1024;

let dir: string;

beforeEach(async () => {
  dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-ckpt-capture-'));
});

afterEach(async () => {
  await fsPromises.rm(dir, { force: true, recursive: true });
});

describe('captureBeforeState', () => {
  it('classifies a text file with content, hash, and size', async () => {
    const abs = path.join(dir, 'text.txt');
    await fsPromises.writeFile(abs, 'HELLO', 'utf8');

    const state = await captureBeforeState(abs, MAX_BYTES);

    expect(state).toEqual({
      content: 'HELLO',
      hash: sha256Hex('HELLO'),
      kind: 'text',
      size: 5,
    });
    expect(beforeStateToCapture(state)).toEqual({
      beforeContent: 'HELLO',
      beforeExisted: true,
      beforeHash: sha256Hex('HELLO'),
      beforeSize: 5,
      captureStatus: 'ok',
    });
  });

  it('classifies a file with a NUL byte as binary (hash+size kept, content refused)', async () => {
    const abs = path.join(dir, 'bin.dat');
    const bytes = Buffer.from([0x48, 0x00, 0x49, 0x4a]);
    await fsPromises.writeFile(abs, bytes);

    const state = await captureBeforeState(abs, MAX_BYTES);

    expect(state).toEqual({
      hash: sha256Hex(bytes),
      kind: 'binary',
      size: bytes.length,
    });
    expect(beforeStateToCapture(state)).toEqual({
      beforeContent: null,
      beforeExisted: true,
      beforeHash: sha256Hex(bytes),
      beforeSize: bytes.length,
      captureStatus: 'skipped_binary',
    });
  });

  it('classifies an oversized file as too_large without reading it (size only)', async () => {
    const abs = path.join(dir, 'big.txt');
    await fsPromises.writeFile(abs, Buffer.alloc(MAX_BYTES + 1, 0x61));

    const state = await captureBeforeState(abs, MAX_BYTES);

    expect(state).toEqual({ kind: 'too_large', size: MAX_BYTES + 1 });
    expect(beforeStateToCapture(state)).toEqual({
      beforeContent: null,
      beforeExisted: true,
      beforeHash: null,
      beforeSize: MAX_BYTES + 1,
      captureStatus: 'skipped_too_large',
    });
  });

  it('classifies a missing path as absent (created)', async () => {
    const state = await captureBeforeState(path.join(dir, 'nope.txt'), MAX_BYTES);

    expect(state).toEqual({ kind: 'absent' });
    expect(beforeStateToCapture(state)).toEqual({
      beforeContent: null,
      beforeExisted: false,
      beforeHash: null,
      beforeSize: null,
      captureStatus: 'created',
    });
  });
});
