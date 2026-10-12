/**
 * Edit attribution CAPTURE — REAL end-to-end. Drives the actual host mutation
 * tool `execute()` (the agent host's live executor fold, `_host-native-tools`)
 * against a REAL on-disk workspace, asserting that every mutation hands Core's
 * edit tracker exactly one edit with the correct op, absolute path(s) and root,
 * opened for the right tool and tool call id (the Mastra 2nd-arg toolCallId
 * threads through). Core's tracker then observes the before/after state itself
 * and commits `workspace.edit.recorded` (`packages/agent-host`
 * `workspace-edits.integration.test.ts` covers the baselines, capture status
 * and revert). Also proves the tool result contract is unchanged and that a
 * host call without Core's edit capability refuses before touching disk.
 */

import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbHolder } = vi.hoisted(() => ({ dbHolder: { db: null as unknown, fail: false } }));

// LEGACY-ONLY (BST-1980 C1): the database mock serves only the legacy journal
// block at the bottom; deleted with it in C2.
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

import {
  createSharedNativeHostTools,
  ReadWorkspaceFileCursorRegistry,
  resetToolCallLoopGuards,
} from '@brainstrike/host-capabilities/native-tools';
// LEGACY-ONLY (BST-1980 C1): used only by the legacy journal block at the bottom;
// deleted with `assistant-tools.ts` in C2.
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import { disposeLspServers, getEditDiagnostics } from '../../assistant-server/lsp-diagnostics';
import { recordingEditsPort, type TrackedEdit } from './_c1-c-helpers';
import { buildHostNativeTools, memoryToolState } from './_host-native-tools';
import { requireToolExecute } from './_tool-test-helpers';

const ROOT_ID = 'root-1';
const RUN_ID = 'run-abc';
const THREAD_ID = 'thread-abc';
const RESOURCE_ID = 'workspace-a';

let rootPath: string;
/** The root as the tools canonicalize it (macOS temp dirs sit behind /private). */
let canonicalRoot: string;

function runtime(): RuntimeData {
  return {
    memory: { resourceId: RESOURCE_ID, runId: RUN_ID, threadId: THREAD_ID },
    workspaceRoots: [{ displayName: 'Project', path: rootPath, rootId: ROOT_ID }],
  } as unknown as RuntimeData;
}

const runContext = (toolCallId: string) => ({ agent: { toolCallId } });

/** The host fold with Desktop's diagnostics and a recording attribution port. */
function hostTools(): {
  readonly tools: ReturnType<typeof buildHostNativeTools>;
  readonly tracked: TrackedEdit[];
} {
  const port = recordingEditsPort();
  return {
    tools: buildHostNativeTools(runtime(), {
      ports: {
        fileMutations: { diagnostics: (args) => getEditDiagnostics(args), edits: port.edits },
      },
    }),
    tracked: port.tracked,
  };
}

async function writeDisk(rel: string, content: string): Promise<void> {
  const abs = path.join(rootPath, rel);
  await fsPromises.mkdir(path.dirname(abs), { recursive: true });
  await fsPromises.writeFile(abs, content, 'utf8');
}

describe('edit attribution through Core’s tracker', () => {
  beforeEach(async () => {
    resetToolCallLoopGuards();
    rootPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-capture-'));
    canonicalRoot = await fsPromises.realpath(rootPath);
  });

  afterEach(async () => {
    await disposeLspServers();
    vi.clearAllMocks();
    await fsPromises.rm(rootPath, { force: true, recursive: true });
  });

  describe('on write', () => {
    it('tracks a write of a new file and keeps the result contract', async () => {
      const { tools, tracked } = hostTools();
      // Plain-text fixture (.txt): keeps this a focused attribution-CONTRACT test
      // with a strict toEqual — a .ts path would additionally attach the post-edit
      // `lsp` diagnostics field (report R2), which is covered by its own tests.
      const result = await requireToolExecute(tools, 'brainstrike.writeWorkspaceFile')(
        { content: 'hello\n', path: '/new.txt' },
        runContext('call-write-1')
      );
      expect(result).toEqual({
        bytesWritten: 6,
        created: true,
        path: '/new.txt',
        // BST-1192: writeWorkspaceFile now returns its resolved rootId so
        // stale-read supersession can compare canonical file identity instead
        // of display-name-only rootName.
        rootId: ROOT_ID,
        rootName: 'Project',
      });

      expect(tracked).toEqual([
        {
          call: {
            executionThreadId: undefined,
            toolCallId: 'call-write-1',
            toolName: NATIVE_TOOL_ID.writeWorkspaceFile,
          },
          edit: {
            absolutePath: path.join(canonicalRoot, 'new.txt'),
            op: 'write',
            rootId: ROOT_ID,
            rootPath: canonicalRoot,
          },
        },
      ]);
    });

    it('opens the edit with a non-null tool call id from the PLAIN-tool context shape (top-level toolCallId)', async () => {
      // The desktop registry passes plain tool OBJECTS, and Mastra hands those a
      // TOP-LEVEL `toolCallId` (no `agent` wrapper). Reproduced live (BST-1164
      // review): reading only `agent.toolCallId` attributed the edit to no call,
      // which broke the renderer's `entriesByToolCallId` binding and hid BOTH
      // checkpoint-undo affordances.
      const { tools, tracked } = hostTools();
      await requireToolExecute(tools, 'brainstrike.writeWorkspaceFile')(
        { content: 'hello\n', path: '/plain.txt' },
        { toolCallId: 'call-plain-1' }
      );

      expect(tracked).toHaveLength(1);
      expect(tracked[0]?.edit.absolutePath).toBe(path.join(canonicalRoot, 'plain.txt'));
      expect(tracked[0]?.call.toolCallId).toBe('call-plain-1');
    });

    it('tracks an overwrite of an existing text file as a write of that path', async () => {
      await writeDisk('a.ts', 'OLD');
      const { tools, tracked } = hostTools();
      await requireToolExecute(tools, 'brainstrike.writeWorkspaceFile')(
        { content: 'NEW', path: '/a.ts' },
        runContext('call-write-2')
      );
      expect(tracked).toEqual([
        expect.objectContaining({
          call: expect.objectContaining({ toolCallId: 'call-write-2' }),
          edit: expect.objectContaining({
            absolutePath: path.join(canonicalRoot, 'a.ts'),
            op: 'write',
          }),
        }),
      ]);
      expect(await fsPromises.readFile(path.join(rootPath, 'a.ts'), 'utf8')).toBe('NEW');
    });
  });

  describe('on string_replace / delete / rename', () => {
    it('tracks a string replace', async () => {
      await writeDisk('b.ts', 'const value = 1;\n');
      const { tools, tracked } = hostTools();
      await requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile')(
        { newStr: 'const value = 2;', oldStr: 'const value = 1;', path: '/b.ts' },
        runContext('call-sr')
      );
      expect(tracked).toEqual([
        {
          call: {
            executionThreadId: undefined,
            toolCallId: 'call-sr',
            toolName: NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
          },
          edit: expect.objectContaining({
            absolutePath: path.join(canonicalRoot, 'b.ts'),
            op: 'string_replace',
          }),
        },
      ]);
    });

    it('tracks a delete', async () => {
      await writeDisk('c.ts', 'gone soon\n');
      const { tools, tracked } = hostTools();
      await requireToolExecute(tools, 'brainstrike.deleteWorkspaceFile')(
        { path: '/c.ts' },
        runContext('call-del')
      );
      expect(tracked).toEqual([
        {
          call: expect.objectContaining({ toolCallId: 'call-del' }),
          edit: expect.objectContaining({
            absolutePath: path.join(canonicalRoot, 'c.ts'),
            op: 'delete',
          }),
        },
      ]);
    });

    it('tracks a rename with its source AND destination, leaving the destination bytes Core hashes', async () => {
      await writeDisk('old.ts', 'x\n');
      const { tools, tracked } = hostTools();
      await requireToolExecute(tools, 'brainstrike.renameWorkspaceFile')(
        { fromPath: '/old.ts', toPath: '/new.ts' },
        runContext('call-rn')
      );
      expect(tracked).toEqual([
        {
          call: expect.objectContaining({ toolCallId: 'call-rn' }),
          edit: {
            absolutePath: path.join(canonicalRoot, 'new.ts'),
            fromAbsolutePath: path.join(canonicalRoot, 'old.ts'),
            op: 'rename',
            rootId: ROOT_ID,
            rootPath: canonicalRoot,
          },
        },
      ]);
      // Core's tracker hashes the destination after the mutation; it is the undo
      // conflict gate's verifiability anchor (W7 review P1 — existence-only
      // acceptance clobbered post-rename edits), so it must hold the moved bytes.
      const destination = await fsPromises.readFile(path.join(rootPath, 'new.ts'));
      expect(createHash('sha256').update(destination).digest('hex')).toBe(
        createHash('sha256').update('x\n').digest('hex')
      );
    });
  });

  describe('gated on Core’s edit capability', () => {
    it('refuses a host call without an edit tracker, before touching disk', async () => {
      // `HostToolContext.edits`: present for every Core-dispatched execution;
      // file tools must refuse without it.
      const tools = createSharedNativeHostTools({
        ids: [NATIVE_TOOL_ID.writeWorkspaceFile],
        readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
        resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
        runtime: {
          provider: 'openai',
          workspaceRoots: [{ displayName: 'Project', path: rootPath, rootId: ROOT_ID }],
        },
      });
      const [write] = Object.values(tools);
      if (!write) {
        throw new Error('expected the host write tool');
      }
      await expect(
        write.execute(
          { content: 'hi', path: '/y.ts' },
          {
            runId: RUN_ID,
            signal: new AbortController().signal,
            state: memoryToolState(),
            threadId: THREAD_ID,
            toolCallId: 'call-y',
          }
        )
      ).rejects.toThrow('Core supplied no edit or state capability to a shared native tool');
      await expect(fsPromises.access(path.join(rootPath, 'y.ts'))).rejects.toThrow();
    });
  });
});

// LEGACY-ONLY (BST-1980 C1): the legacy ports' PGlite edit journal
// (`edit-checkpoint-capture.ts`): a best-effort journal skipped when the database
// is unavailable or the runtime has no memory thread. Host edits are attributed by
// Core's per-call tracker, the committed run log (no best-effort store), and a
// call without it refuses (the gated case above). Deleted with the legacy
// composition in C2.
describe('legacy journal capture', () => {
  let db: PGlite;

  beforeEach(async () => {
    resetToolCallLoopGuards();
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
    await disposeLspServers();
    vi.clearAllMocks();
    await db.close();
    await fsPromises.rm(rootPath, { force: true, recursive: true });
  });

  async function listCheckpoints(): Promise<unknown[]> {
    const result = (await db.query(
      `SELECT op, path, from_path, after_hash, before_existed, capture_status, tool_call_id, run_id, thread_id
     FROM brainstrike_assistant_edit_checkpoints ORDER BY occurred_at ASC, id ASC`
    )) as { rows: unknown[] };
    return result.rows;
  }

  describe('capture is non-fatal and gated', () => {
    it('does not journal or throw when the database is unavailable', async () => {
      dbHolder.fail = true;
      const tools = buildDesktopAssistantTools(runtime());
      const result = await requireToolExecute(tools, 'brainstrike.writeWorkspaceFile')(
        { content: 'hi', path: '/x.txt' },
        runContext('call-x')
      );
      expect(result).toEqual({
        bytesWritten: 2,
        created: true,
        path: '/x.txt',
        // BST-1192: rootId is always present on a successful write, DB
        // unavailability or not — bookkeeping failure must never alter the
        // already-successful tool result (only the checkpoint journal, and
        // the projection-rewrite overlay, are skipped).
        rootId: ROOT_ID,
        rootName: 'Project',
      });
      expect(await fsPromises.readFile(path.join(rootPath, 'x.txt'), 'utf8')).toBe('hi');
    });

    it('does not journal when there is no active memory thread', async () => {
      const noMemory = {
        workspaceRoots: [{ displayName: 'Project', path: rootPath, rootId: ROOT_ID }],
      } as unknown as RuntimeData;
      const tools = buildDesktopAssistantTools(noMemory);
      await requireToolExecute(tools, 'brainstrike.writeWorkspaceFile')(
        { content: 'hi', path: '/y.ts' },
        runContext('call-y')
      );
      const rows = await listCheckpoints();
      expect(rows).toHaveLength(0);
    });
  });
});
