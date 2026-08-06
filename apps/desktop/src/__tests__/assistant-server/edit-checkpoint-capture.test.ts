/**
 * Before-identity capture for the ATTRIBUTION ledger (BST-1164 T4) — proves
 * the demotion: capture records existence + sha256 + size and NEVER content.
 * The content-era classifications (2 MB cap → `skipped_too_large`, NUL probe
 * → `skipped_binary`) died with content capture: binary and oversized files
 * hash like any other file, because restores come from workspace snapshots,
 * not stored bytes. REAL fs in a tmp dir; no DB / electron.
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

let dir: string;

beforeEach(async () => {
  dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-ckpt-capture-'));
});

afterEach(async () => {
  await fsPromises.rm(dir, { force: true, recursive: true });
});

describe('captureBeforeState', () => {
  it('captures a present file as identity only — hash and size, NO content field', async () => {
    const abs = path.join(dir, 'text.txt');
    await fsPromises.writeFile(abs, 'HELLO', 'utf8');

    const state = await captureBeforeState(abs);

    expect(state).toEqual({ hash: sha256Hex('HELLO'), kind: 'present', size: 5 });
    const capture = beforeStateToCapture(state);
    expect(capture).toEqual({
      beforeExisted: true,
      beforeHash: sha256Hex('HELLO'),
      beforeSize: 5,
      captureStatus: 'ok',
    });
    // The demotion pin: content is NOT captured, in any shape.
    expect(capture).not.toHaveProperty('beforeContent');
    expect(state).not.toHaveProperty('content');
  });

  it('hashes a NUL-bearing (binary) file like any other — no skipped_binary state exists', async () => {
    const abs = path.join(dir, 'bin.dat');
    const bytes = Buffer.from([0x48, 0x00, 0x49, 0x4a]);
    await fsPromises.writeFile(abs, bytes);

    const state = await captureBeforeState(abs);

    expect(state).toEqual({ hash: sha256Hex(bytes), kind: 'present', size: bytes.length });
    expect(beforeStateToCapture(state).captureStatus).toBe('ok');
  });

  it('hashes a file beyond the old 2 MB content cap — no skipped_too_large state exists', async () => {
    const abs = path.join(dir, 'big.txt');
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    await fsPromises.writeFile(abs, bytes);

    const state = await captureBeforeState(abs);

    expect(state).toEqual({ hash: sha256Hex(bytes), kind: 'present', size: bytes.length });
    expect(beforeStateToCapture(state).captureStatus).toBe('ok');
  });

  it('classifies a missing path as absent (created)', async () => {
    const state = await captureBeforeState(path.join(dir, 'nope.txt'));

    expect(state).toEqual({ kind: 'absent' });
    expect(beforeStateToCapture(state)).toEqual({
      beforeExisted: false,
      beforeHash: null,
      beforeSize: null,
      captureStatus: 'created',
    });
  });
});
