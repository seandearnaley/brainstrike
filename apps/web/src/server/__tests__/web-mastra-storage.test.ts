// @vitest-environment node
//
// Real embedded Turso (no mocks) — proves the singleton that backs WEB tool
// approval suspend/resume actually constructs and is shared across requests.
// Turso's local embedded package is Node-only here, hence the per-file override
// of the package default (happy-dom).
//
// The suspend → approve/decline → resume MECHANISM itself is proven in the agent
// package's mastra-tool-approval-suspend.spec.ts, which drives the real Mastra
// loop against Turso-backed workflow storage. This file proves the web-specific
// glue: the lazily-built, request-shared singleton.
import { access, chmod, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  disposeWebMastraStorage,
  getWebMastraStorage,
  resetWebMastraStorageForTests,
} from '../web-mastra-storage';

type WebMastraStorage = Awaited<ReturnType<typeof getWebMastraStorage>>;
type WebWorkflowSnapshot = Parameters<
  WebMastraStorage['workflows']['persistWorkflowSnapshot']
>[0]['snapshot'];
type WebStepResult = Parameters<
  WebMastraStorage['workflows']['updateWorkflowResults']
>[0]['result'];

const TEMP_PROFILE_PREFIX = 'brainstrike-web-mastra-turso-';

function createSnapshot(overrides: Partial<WebWorkflowSnapshot> = {}): WebWorkflowSnapshot {
  return {
    activePaths: [],
    activeStepsPath: {},
    context: {
      input: {
        endedAt: Date.parse('2026-07-03T12:00:01Z'),
        output: { requestId: 'web-request-1' },
        payload: { requestId: 'web-request-1' },
        startedAt: Date.parse('2026-07-03T12:00:00Z'),
        status: 'success' as const,
      },
    },
    resumeLabels: {},
    runId: 'web-run-1',
    serializedStepGraph: [],
    status: 'running',
    suspendedPaths: {},
    timestamp: Date.parse('2026-07-03T12:00:00Z'),
    value: {},
    waitingPaths: {},
    ...overrides,
  };
}

async function listTempProfileDirs(): Promise<ReadonlySet<string>> {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return new Set(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_PROFILE_PREFIX))
      .map((entry) => join(tmpdir(), entry.name))
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('getWebMastraStorage (real embedded Turso)', () => {
  beforeEach(async () => {
    await resetWebMastraStorageForTests();
  });

  afterEach(async () => {
    await disposeWebMastraStorage();
  });

  it('builds a real workflow-capable Mastra store (the suspend/resume backing)', async () => {
    const result = await getWebMastraStorage();
    // `storage` (MastraCompositeStore) is what streamMastraToolApprovalAction
    // requires; its workflows domain persists/reloads the suspended-run snapshot.
    expect(result.storage).toBeDefined();
    expect(result.memory).toBeDefined();
    expect(result.store.constructor.name).toBe('TursoMemoryStore');
    expect(result.vector.constructor.name).toBe('TursoVectorStore');
    expect(result.workflows.constructor.name).toBe('TursoWorkflowsStore');
  });

  it('caches ONE singleton across calls so suspend + resume share the snapshot store', async () => {
    const first = await getWebMastraStorage();
    const second = await getWebMastraStorage();
    // Same instance: the workflow snapshot written on the suspend request must be
    // reloadable on the SEPARATE resume request in the long-lived Vite server.
    // Two storage instances would lose the snapshot and break resume.
    expect(second).toBe(first);
  });

  it('rebuilds a fresh store after reset (the cache is resettable, closes the old engine)', async () => {
    const first = await getWebMastraStorage();
    // reset closes the underlying Turso engine/profile (no leaked engine) and clears the cache.
    await resetWebMastraStorageForTests();
    const second = await getWebMastraStorage();
    expect(second).not.toBe(first);
  });

  it('persists and reloads workflow snapshots through the web owner-client transaction adapter', async () => {
    const { workflows } = await getWebMastraStorage();
    const stepResult: WebStepResult = {
      endedAt: Date.parse('2026-07-03T12:00:03Z'),
      output: { approved: true },
      payload: { requestId: 'web-request-1' },
      resumedAt: Date.parse('2026-07-03T12:00:02Z'),
      startedAt: Date.parse('2026-07-03T12:00:00Z'),
      status: 'success',
    };

    expect(workflows.supportsConcurrentUpdates()).toBe(true);
    await workflows.persistWorkflowSnapshot({
      resourceId: 'web-workspace',
      runId: 'web-run-1',
      snapshot: createSnapshot(),
      workflowName: 'web-approval-workflow',
    });
    await workflows.updateWorkflowResults({
      requestContext: { source: 'web' },
      result: stepResult,
      runId: 'web-run-1',
      stepId: 'approval-step',
      workflowName: 'web-approval-workflow',
    });
    await workflows.updateWorkflowState({
      opts: { status: 'suspended', suspendedPaths: { 'approval-step': [0] } },
      runId: 'web-run-1',
      workflowName: 'web-approval-workflow',
    });

    await expect(
      workflows.loadWorkflowSnapshot({
        runId: 'web-run-1',
        workflowName: 'web-approval-workflow',
      })
    ).resolves.toMatchObject({
      context: {
        input: {
          payload: { requestId: 'web-request-1' },
          status: 'success',
        },
        'approval-step': stepResult,
      },
      requestContext: { source: 'web' },
      status: 'suspended',
    });
  });

  it('removes the temp Turso profile when the web server storage is disposed', async () => {
    const before = await listTempProfileDirs();
    await getWebMastraStorage();
    const created = [...(await listTempProfileDirs())].filter((path) => !before.has(path));

    expect(created).toHaveLength(1);
    const createdPath = created[0];
    if (!createdPath) {
      throw new Error('Expected getWebMastraStorage to create one temp Turso profile');
    }

    await disposeWebMastraStorage();

    await expect(exists(createdPath)).resolves.toBe(false);
  });

  it('surfaces temp-profile cleanup failures during test reset', async () => {
    const before = await listTempProfileDirs();
    await getWebMastraStorage();
    const created = [...(await listTempProfileDirs())].filter((path) => !before.has(path));
    const createdPath = created[0];
    if (!createdPath) {
      throw new Error('Expected getWebMastraStorage to create one temp Turso profile');
    }

    await chmod(createdPath, 0);

    try {
      await expect(resetWebMastraStorageForTests()).rejects.toThrow(
        'Failed to dispose web Mastra Turso profile'
      );
    } finally {
      await chmod(createdPath, 0o700).catch(() => undefined);
      await rm(createdPath, { force: true, recursive: true });
    }
  });

  it('wires web Mastra storage disposal into Vite dev and preview server shutdown', async () => {
    const viteConfig = await readFile(new URL('../../../vite.config.mts', import.meta.url), 'utf8');

    expect(viteConfig).toContain('disposeWebMastraStorage');
    expect(viteConfig).toContain("server.httpServer?.once('close'");
    expect(viteConfig.match(/installWebMastraStorageDisposal/g) ?? []).toHaveLength(3);
  });
});
