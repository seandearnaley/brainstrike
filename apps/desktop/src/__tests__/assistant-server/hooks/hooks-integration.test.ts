/**
 * Integration coverage for the desktop hooks server-composition layer:
 * buildHookManager (roots + trust + config), the UserPromptSubmit gate + block
 * short-circuit stream, PostToolUse context, and the terminal Stop hook — all
 * over the REAL HookManager/executor with temp hook scripts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, RuntimeData, StreamChunk } from '@brainstrike/agent';
import { buildHookTrustRequest } from '@brainstrike/preferences/stores/hook-trust-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopHookRunner } from '../../../assistant-server/hooks/hook-runner-impl';
import type { HookRunEventInput } from '../../../assistant-server/hooks/manager';
import {
  buildHookManager,
  deriveLastUserText,
  makeHookBlockedStream,
  withStopHook,
} from '../../../assistant-server/hooks/server-integration';

let tmpRoot: string;
const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};

function writeProjectHooks(rootAbsPath: string, content: string): string {
  const dir = join(rootAbsPath, '.brainstrike');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'hooks.json');
  writeFileSync(file, content, 'utf8');
  return file;
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function runtimeWithRoot(rootId: string, absPath: string): RuntimeData {
  return {
    provider: 'openai',
    workspaceRoots: [{ displayName: 'root', path: absPath, rootId }],
  } as RuntimeData;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bs-hooks-int-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpRoot, { force: true, recursive: true });
});

describe('deriveLastUserText', () => {
  it('returns the last user message text', () => {
    const messages: AgentMessage[] = [
      { id: 'a', parts: [{ text: 'first', type: 'text' }], role: 'user' },
      { id: 'b', parts: [{ text: 'answer', type: 'text' }], role: 'assistant' },
      { id: 'c', parts: [{ text: 'latest', type: 'text' }], role: 'user' },
    ];
    expect(deriveLastUserText(messages)).toBe('latest');
  });
});

describe('makeHookBlockedStream', () => {
  it('yields a visible message, a run.failed event, and an error finish', async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of makeHookBlockedStream('nope')) {
      chunks.push(chunk);
    }
    expect(JSON.stringify(chunks)).toContain('nope');
    const kinds = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'run-event' }> => c.type === 'run-event')
      .map((c) => c.event.kind);
    expect(kinds).toContain('run.failed');
    expect(chunks.some((c) => c.type === 'message-finish' && c.finishReason === 'error')).toBe(
      true
    );
  });
});

describe('buildHookManager (roots + trust + config)', () => {
  it('loads a project root hooks file only when the approved hash matches disk', async () => {
    const config = JSON.stringify({
      PreToolUse: [{ command: `echo '{"reason":"blocked"}'; exit 2`, type: 'command' }],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const runtimeData = runtimeWithRoot('root-1', tmpRoot);

    // Untrusted (no approval) → hooks are skipped.
    const untrusted = buildHookManager({
      hookTrustRequest: { approvals: [] },
      logger,
      runtimeData,
      sessionId: 's1',
    });
    expect(untrusted.hasHooks()).toBe(false);

    // Approved with the matching hash → hooks load + block.
    const approved = buildHookManager({
      hookTrustRequest: {
        approvals: [{ approvedAt: 1, rootId: 'root-1', sha256: sha256OfFile(file) }],
      },
      logger,
      runtimeData,
      sessionId: 's1',
    });
    expect(approved.hasHooks()).toBe(true);
    const runner = createDesktopHookRunner(approved);
    const gate = await runner.preToolUse('executeCommand', { cmd: 'ls' });
    expect(gate.decision).toBe('block');
    expect(gate.reason).toBe('blocked');
  });

  it('trusts + loads a root whose hooks file has non-utf8 bytes (M1 hash parity)', () => {
    // Review (approve-time) hash and load-time trust hash must both be of the RAW
    // bytes. A lone 0xFF (invalid UTF-8) inside a string value would diverge a
    // utf8-decoded-string hash from the raw-byte hash → the approval would
    // silently never take. Prove the approved root's hooks load.
    const prefix = Buffer.from(
      '{"PreToolUse":[{"command":"echo \'{\\"reason\\":\\"blocked\\"}\'; exit 2","description":"x',
      'utf8'
    );
    const suffix = Buffer.from('y","type":"command"}]}', 'utf8');
    const bytes = Buffer.concat([prefix, Buffer.from([0xff]), suffix]);
    const dir = join(tmpRoot, '.brainstrike');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'hooks.json');
    writeFileSync(file, bytes);

    // The approval hash the renderer attests == the raw-byte hash.
    const approvedSha = sha256OfFile(file);
    const manager = buildHookManager({
      hookTrustRequest: { approvals: [{ approvedAt: 1, rootId: 'root-1', sha256: approvedSha }] },
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    expect(manager.hasHooks()).toBe(true);
  });

  it('surfaces a disabled config file via reportConfigErrors (fail-loud)', () => {
    writeProjectHooks(tmpRoot, '{ invalid json');
    const events: HookRunEventInput[] = [];
    const manager = buildHookManager({
      emitRunEvent: (e) => events.push(e),
      hookTrustRequest: {
        approvals: [
          {
            approvedAt: 1,
            rootId: 'root-1',
            sha256: sha256OfFile(join(tmpRoot, '.brainstrike', 'hooks.json')),
          },
        ],
      },
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });
    manager.reportConfigErrors();
    expect(events.some((e) => e.kind === 'hook.notice' && e.status === 'failed')).toBe(true);
  });
});

// KILL CHAIN severing proof (renderer attestation-scoping ⇒ server execution).
// This crosses the boundary: the renderer's `buildHookTrustRequest` (DB-id keyed,
// scoped to mounted roots) feeds the server's `buildHookManager`. It proves that
// disconnecting a root (mounted set no longer contains its DB id) SEVERS hook
// execution server-side — the fail-open the review flagged, now closed.
describe('attestation scoping severs execution on disconnect (kill chain)', () => {
  it('runs an approved root while mounted, then stops running it once unmounted', () => {
    const config = JSON.stringify({
      PreToolUse: [{ command: `echo '{"reason":"blocked"}'; exit 2`, type: 'command' }],
    });
    const file = writeProjectHooks(tmpRoot, config);
    // The DB root id the SERVER resolves the root under (stable across re-add).
    const runtimeData = runtimeWithRoot('db-1', tmpRoot);
    // The renderer's persisted grant, keyed by that SAME DB id.
    const store = {
      approvalsByRootId: { 'db-1': { approvedAt: 1, sha256: sha256OfFile(file) } },
    };

    // Mounted: attestation carries db-1 → server trusts + loads the hooks.
    const mountedRequest = buildHookTrustRequest(store, {
      mountedRootIds: new Set(['db-1']),
    });
    const trusted = buildHookManager({
      hookTrustRequest: mountedRequest,
      logger,
      runtimeData,
      sessionId: 's1',
    });
    expect(trusted.hasHooks()).toBe(true);

    // Disconnected: mounted set no longer contains db-1 → attestation is empty →
    // the server finds no approval for the (still DB-live) root → hooks DON'T run.
    const disconnectedRequest = buildHookTrustRequest(store, {
      mountedRootIds: new Set(),
    });
    expect(disconnectedRequest.approvals).toEqual([]);
    const severed = buildHookManager({
      hookTrustRequest: disconnectedRequest,
      logger,
      runtimeData,
      sessionId: 's1',
    });
    expect(severed.hasHooks()).toBe(false);
  });
});

describe('withStopHook', () => {
  it('fires the Stop hook with the resolved reason when the stream completes', async () => {
    const marker = join(tmpRoot, 'stop.json');
    const config = JSON.stringify({
      Stop: [{ command: `cat > "${marker}"`, type: 'command' }],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      hookTrustRequest: {
        approvals: [{ approvedAt: 1, rootId: 'root-1', sha256: sha256OfFile(file) }],
      },
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    async function* source(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', value: 'hi' };
    }

    const controller = new AbortController();
    const seen: StreamChunk[] = [];
    for await (const chunk of withStopHook(source(), manager, controller.signal)) {
      seen.push(chunk);
    }

    expect(seen.some((c) => c.type === 'text-delta')).toBe(true);
    const stopPayload = JSON.parse(readFileSync(marker, 'utf8')) as { stop_reason: string };
    expect(stopPayload.stop_reason).toBe('complete');
  });
});
