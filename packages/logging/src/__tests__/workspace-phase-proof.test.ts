import { afterEach, expect, it, vi } from 'vitest';
import type { LogRecord } from '../logger.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('requires the exact proof opt-in and emits nothing while disabled', async () => {
  vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', 'true');
  const { beginWorkspacePhaseProof } = await import('../workspace-phase-proof.js');
  const warn = vi.fn();
  const proof = beginWorkspacePhaseProof({ warn }, 'registry.mutation');
  proof.mark('settle', { status: 'success' });
  expect(proof.id).toBe(0);
  expect(warn).not.toHaveBeenCalled();
});

it('projects UUIDs, bounded counts and enums without paths, secrets or exceptions', async () => {
  vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', '1');
  const { beginWorkspacePhaseProof } = await import('../workspace-phase-proof.js');
  const warn = vi.fn();
  const fields = {
    count: 2 ** 40,
    error: new Error('fake-secret'),
    path: '/secret/folder',
    queuedAfter: -1,
    rootId: '/secret/folder',
    token: 'fake-secret',
  };
  const proof = beginWorkspacePhaseProof({ warn }, 'registry.directory-read', fields);
  const rootId = '11111111-1111-4111-8111-111111111111';
  proof.mark('settle', { rootId, status: 'success' });
  const first = warn.mock.calls[0]?.[1];
  const last = warn.mock.calls[1]?.[1];
  expect(first).toMatchObject({ count: 2_147_483_647, phase: 'admit', rootId: '[invalid-id]' });
  expect(first).not.toHaveProperty('queuedAfter');
  expect(last).toMatchObject({ operationId: proof.id, phase: 'settle', rootId, status: 'success' });
  expect(last.realmId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(last.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|folder|token|error/u);
});

it('accepts only the preload boolean opt-in in renderer realms', async () => {
  vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', undefined);
  vi.stubGlobal('brainstrikeWorkspacePhaseProof', true);
  const { beginWorkspacePhaseProof } = await import('../workspace-phase-proof.js');
  const warn = vi.fn();
  beginWorkspacePhaseProof({ warn }, 'renderer.root-load').mark('ack', { count: 1, generation: 2 });
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn.mock.lastCall?.[1]).toMatchObject({ count: 1, generation: 2, phase: 'ack' });
});

it('caps a realm at 512 events and one explicit truncation receipt', async () => {
  vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', '1');
  const { beginWorkspacePhaseProof } = await import('../workspace-phase-proof.js');
  const warn = vi.fn();
  for (let index = 0; index < 1000; index += 1) {
    beginWorkspacePhaseProof({ warn }, 'ipc.watch').mark('settle', { status: 'success' });
  }
  expect(warn).toHaveBeenCalledTimes(513);
  expect(warn.mock.calls.filter(([message]) => message.endsWith('truncated'))).toHaveLength(1);
  expect(warn.mock.lastCall?.[1]).toMatchObject({ limit: 512 });
});

it('keeps opted-in proof visible at the smoke warn threshold and opt-out silent', async () => {
  vi.stubEnv('LOG_LEVEL', 'warn');
  vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', '1');
  const { addLogListener, configureLogger, createLogger, LogLevel, resetLogger } = await import(
    '../logger.js'
  );
  const { beginWorkspacePhaseProof } = await import('../workspace-phase-proof.js');
  resetLogger();
  configureLogger({ file: false });
  const records: LogRecord[] = [];
  const unsubscribe = addLogListener((record) => records.push(record));
  try {
    const logger = createLogger('WorkspacePhaseProofThreshold');
    logger.info('below the smoke threshold');
    expect(records).toHaveLength(0);
    beginWorkspacePhaseProof(logger, 'registry.mutation').mark('ack', { status: 'success' });
    expect(records.map(({ level }) => level)).toEqual([LogLevel.WARN, LogLevel.WARN]);
    expect(records.map(({ message }) => message)).toEqual([
      '[DEBUG-BST2269] workspace phase proof',
      '[DEBUG-BST2269] workspace phase proof',
    ]);
    vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', undefined);
    const disabled = beginWorkspacePhaseProof(logger, 'registry.mutation');
    disabled.mark('ack', { status: 'success' });
    expect(disabled.id).toBe(0);
    expect(records).toHaveLength(2);
  } finally {
    unsubscribe();
    resetLogger();
  }
});
