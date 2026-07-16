/**
 * Edit checkpoint CAPTURE — REAL end-to-end. Drives the actual desktop mutation
 * tool `execute()` (from `buildDesktopAssistantTools`) against a REAL PGlite +
 * a REAL on-disk workspace, asserting one journal row per mutation with the
 * correct op / path / before_existed / capture_status and a populated
 * tool_call_id / run_id / thread_id (the Mastra 2nd-arg toolCallId threads
 * through). Also proves the tool result contract is unchanged and that a
 * DB-unavailable capture is a non-fatal no-op.
 */

import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbHolder } = vi.hoisted(() => ({ dbHolder: { db: null as unknown, fail: false } }));

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => {
    if (dbHolder.fail) {
      throw new Error('database unavailable');
    }
    return dbHolder.db;
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';

const ROOT_ID = 'root-1';
const RUN_ID = 'run-abc';
const THREAD_ID = 'thread-abc';
const RESOURCE_ID = 'workspace-a';

let db: PGlite;
let rootPath: string;

function runtime(): RuntimeData {
  return {
    memory: { resourceId: RESOURCE_ID, runId: RUN_ID, threadId: THREAD_ID },
    workspaceRoots: [{ displayName: 'Project', path: rootPath, rootId: ROOT_ID }],
  } as unknown as RuntimeData;
}

const runContext = (toolCallId: string) => ({ agent: { toolCallId } });

interface CheckpointRow {
  before_existed: boolean;
  capture_status: string;
  from_path: string | null;
  op: string;
  path: string;
  run_id: string;
  thread_id: string;
  tool_call_id: string | null;
}

async function listCheckpoints(): Promise<CheckpointRow[]> {
  const result = await db.query<CheckpointRow>(
    `SELECT op, path, from_path, before_existed, capture_status, tool_call_id, run_id, thread_id
     FROM brainstrike_assistant_edit_checkpoints ORDER BY occurred_at ASC, id ASC`
  );
  return result.rows;
}

async function writeDisk(rel: string, content: string): Promise<void> {
  const abs = path.join(rootPath, rel);
  await fsPromises.mkdir(path.dirname(abs), { recursive: true });
  await fsPromises.writeFile(abs, content, 'utf8');
}

beforeEach(async () => {
  rootPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-capture-'));
  db = await wasmLoader.createPGlite('memory://capture-on-edit');
  await migrate(db);
  dbHolder.db = db;
  dbHolder.fail = false;
  await db.query(
    `INSERT INTO roots (id, kind, display_name, path, status, created_at)
     VALUES ($1, 'path', 'Project', $2, 'live', $3)`,
    [ROOT_ID, rootPath, new Date().toISOString()]
  );
});

afterEach(async () => {
  vi.clearAllMocks();
  await db.close();
  await fsPromises.rm(rootPath, { force: true, recursive: true });
});

describe('edit checkpoint capture on write', () => {
  it('records a "created" checkpoint for a new file and keeps the result contract', async () => {
    const tools = buildDesktopAssistantTools(runtime());
    // Plain-text fixture (.txt): keeps this a focused checkpoint-CONTRACT test
    // with a strict toEqual — a .ts path would additionally attach the post-edit
    // `lsp` diagnostics field (report R2), which is covered by its own tests.
    const result = await tools['brainstrike.writeWorkspaceFile']?.execute?.(
      { content: 'hello\n', path: '/new.txt' },
      runContext('call-write-1')
    );
    expect(result).toEqual({
      bytesWritten: 6,
      created: true,
      path: '/new.txt',
      rootName: 'Project',
    });

    const rows = await listCheckpoints();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      before_existed: false,
      capture_status: 'created',
      op: 'write',
      path: '/new.txt',
      run_id: RUN_ID,
      thread_id: THREAD_ID,
      tool_call_id: 'call-write-1',
    });
  });

  it('records an "ok" checkpoint when overwriting an existing text file', async () => {
    await writeDisk('a.ts', 'OLD');
    const tools = buildDesktopAssistantTools(runtime());
    await tools['brainstrike.writeWorkspaceFile']?.execute?.(
      { content: 'NEW', path: '/a.ts' },
      runContext('call-write-2')
    );
    const rows = await listCheckpoints();
    expect(rows[0]).toMatchObject({ before_existed: true, capture_status: 'ok', op: 'write' });
  });
});

describe('edit checkpoint capture on string_replace / delete / rename', () => {
  it('records an "ok" checkpoint for a string replace', async () => {
    await writeDisk('b.ts', 'const value = 1;\n');
    const tools = buildDesktopAssistantTools(runtime());
    await tools['brainstrike.stringReplaceWorkspaceFile']?.execute?.(
      { newStr: 'const value = 2;', oldStr: 'const value = 1;', path: '/b.ts' },
      runContext('call-sr')
    );
    const rows = await listCheckpoints();
    expect(rows[0]).toMatchObject({
      capture_status: 'ok',
      op: 'string_replace',
      tool_call_id: 'call-sr',
    });
  });

  it('records a checkpoint for a delete', async () => {
    await writeDisk('c.ts', 'gone soon\n');
    const tools = buildDesktopAssistantTools(runtime());
    await tools['brainstrike.deleteWorkspaceFile']?.execute?.(
      { path: '/c.ts' },
      runContext('call-del')
    );
    const rows = await listCheckpoints();
    expect(rows[0]).toMatchObject({ capture_status: 'ok', op: 'delete', path: '/c.ts' });
  });

  it('records a rename checkpoint carrying from_path', async () => {
    await writeDisk('old.ts', 'x\n');
    const tools = buildDesktopAssistantTools(runtime());
    await tools['brainstrike.renameWorkspaceFile']?.execute?.(
      { fromPath: '/old.ts', toPath: '/new.ts' },
      runContext('call-rn')
    );
    const rows = await listCheckpoints();
    expect(rows[0]).toMatchObject({
      capture_status: 'rename',
      from_path: '/old.ts',
      op: 'rename',
      path: '/new.ts',
    });
  });
});

describe('capture is non-fatal and gated', () => {
  it('does not journal or throw when the database is unavailable', async () => {
    dbHolder.fail = true;
    const tools = buildDesktopAssistantTools(runtime());
    const result = await tools['brainstrike.writeWorkspaceFile']?.execute?.(
      { content: 'hi', path: '/x.txt' },
      runContext('call-x')
    );
    expect(result).toEqual({
      bytesWritten: 2,
      created: true,
      path: '/x.txt',
      rootName: 'Project',
    });
    expect(await fsPromises.readFile(path.join(rootPath, 'x.txt'), 'utf8')).toBe('hi');
  });

  it('does not journal when there is no active memory thread', async () => {
    const noMemory = {
      workspaceRoots: [{ displayName: 'Project', path: rootPath, rootId: ROOT_ID }],
    } as unknown as RuntimeData;
    const tools = buildDesktopAssistantTools(noMemory);
    await tools['brainstrike.writeWorkspaceFile']?.execute?.(
      { content: 'hi', path: '/y.ts' },
      runContext('call-y')
    );
    const rows = await listCheckpoints();
    expect(rows).toHaveLength(0);
  });
});
