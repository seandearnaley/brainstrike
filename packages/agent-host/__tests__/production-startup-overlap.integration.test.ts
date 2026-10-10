import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { ResourceOwner } from '@brainstrike/host-lease';
import { RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type HostStateIndex, openHostStateIndex } from '../src/host-state-index.js';
import {
  createProductionHostPlatform,
  type ProductionHostPlatformOptions,
} from '../src/production-platform.js';
import type { HostStartupContext } from '../src/runtime.js';
import { scriptedToolSequence } from '../src/test-fixtures/scripted-model.js';

vi.mock('../src/host-state-index.js', async (load) => {
  const original = await load<typeof import('../src/host-state-index.js')>();
  return { ...original, openHostStateIndex: vi.fn(original.openHostStateIndex) };
});

const original = await vi.importActual<typeof import('../src/host-state-index.js')>(
  '../src/host-state-index.js'
);
let root: string;
let store: StateStore;
let owner: ResourceOwner;
let startup: HostStartupContext;
let index: HostStateIndex | undefined;
let events: string[];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bs-production-overlap-')));
  store = await StateStore.open(root);
  owner = new ResourceOwner();
  startup = {
    register: async (close) => {
      await owner.acquire(
        async () => close,
        (release) => release()
      );
    },
    signal: new AbortController().signal,
    store,
  };
  index = undefined;
  events = [];
  vi.mocked(openHostStateIndex).mockImplementation(async (...args) => {
    events.push('index-start');
    index = await original.openHostStateIndex(...args);
    return {
      ...index,
      close: async () => {
        events.push('index-close');
        await index?.close();
      },
    };
  });
});

afterEach(async () => {
  // Failure cases deliberately retain the production close rejection. The test
  // joins the actual worker separately before releasing its disposable writer.
  await owner.close().catch(() => undefined);
  await index?.close();
  await store.close();
  await rm(root, { force: true, recursive: true });
});

function configuration(
  close: () => Promise<void> = async () => {
    events.push('transport-close');
  }
): Omit<ProductionHostPlatformOptions, 'startup' | 'memoryResourceIds'> {
  return {
    close,
    readConfiguration: async () => {
      throw new Error('No run was admitted by this startup fixture');
    },
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveProviderAuth: async () => undefined,
  };
}

test('starts the owned index before configuration and joins both acquisitions before returning', async () => {
  const configured = Promise.withResolvers<void>();
  const indexReady = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  vi.mocked(openHostStateIndex).mockImplementation(async (...args) => {
    events.push('index-start');
    index = await original.openHostStateIndex(...args);
    opened.resolve();
    await indexReady.promise;
    return index;
  });
  let returned = false;
  const creating = createProductionHostPlatform({
    configure: async () => {
      events.push('configure');
      entered.resolve();
      await configured.promise;
      return configuration();
    },
    memoryResourceIds: [],
    startup,
  });
  void creating.then(() => {
    returned = true;
  });
  try {
    await opened.promise;
    expect(events).toEqual(['index-start', 'configure']);
    await entered.promise;
    expect(returned).toBe(false);
    configured.resolve();
    await Promise.resolve();
    expect(returned).toBe(false);
    await expect(RootLock.acquire(root)).rejects.toBeInstanceOf(RootLockedError);
    indexReady.resolve();
    const result = await creating;
    expect(result.configuration).toHaveProperty('readConfiguration');
    expect(result.platform).toHaveProperty('stateIndexer');
    await result.platform.close();
  } finally {
    configured.resolve();
    indexReady.resolve();
    await creating.catch(() => undefined);
  }
});

test('concurrent platform and Scope close retain Main RPC until transport and index join', async () => {
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const result = await createProductionHostPlatform({
    configure: async (context) => {
      await context.register(async () => {
        events.push('connection-dispose');
      });
      await context.register(async () => {
        events.push('partial-mcp-close');
      });
      return configuration(async () => {
        events.push('transport-close');
        closing.resolve();
        await release.promise;
      });
    },
    memoryResourceIds: [],
    startup,
  });
  const closed = Promise.all([result.platform.close(), owner.close()]);
  try {
    await closing.promise;
    expect(events).toEqual(['index-start', 'transport-close']);
    release.resolve();
    await closed;
    expect(events).toEqual([
      'index-start',
      'transport-close',
      'index-close',
      'partial-mcp-close',
      'connection-dispose',
    ]);
  } finally {
    release.resolve();
    await closed;
  }
});

test('a partial configuration failure unwinds its resources before the index without a configuration wait', async () => {
  const failure = new Error('Recorded configuration rejection after Main RPC registration');
  await expect(
    createProductionHostPlatform({
      configure: async (context) => {
        await context.register(async () => {
          events.push('connection-dispose');
        });
        throw failure;
      },
      memoryResourceIds: [],
      startup,
    })
  ).rejects.toBe(failure);
  await owner.close();
  expect(events).toEqual(['index-start', 'connection-dispose', 'index-close']);
});

test('an inline release while registration closes never waits for its own incomplete configuration', async () => {
  const failure = new Error('Recorded closed Scope registration');
  let registered = 0;
  let productionClose: (() => Promise<void>) | undefined;
  await expect(
    createProductionHostPlatform({
      configure: async (context) => {
        await context.register(async () => {
          events.push('inline-release');
        });
        throw new Error('Closed registration must refuse acquisition');
      },
      memoryResourceIds: [],
      startup: {
        ...startup,
        register: async (release) => {
          registered += 1;
          if (registered === 1) {
            productionClose = release;
            return;
          }
          // Effect.acquireRelease invokes a release inline when registration loses
          // a race with Scope.close; the release cannot await this call's return.
          await release();
          throw failure;
        },
      },
    })
  ).rejects.toBe(failure);
  await productionClose?.();
  expect(events).toEqual(['index-start', 'inline-release', 'index-close']);
});

test('completed configuration cleanup failure still attempts every original release and retains its error', async () => {
  const failure = new Error('Recorded platform RPC close rejection');
  const result = await createProductionHostPlatform({
    configure: async (context) => {
      await context.register(async () => {
        events.push('connection-dispose');
      });
      return configuration(async () => {
        events.push('transport-close');
        throw failure;
      });
    },
    memoryResourceIds: [],
    startup,
  });
  await expect(result.platform.close()).rejects.toMatchObject({ errors: [failure] });
  await expect(owner.close()).rejects.toMatchObject({ errors: [failure] });
  expect(events).toEqual(['index-start', 'transport-close', 'index-close', 'connection-dispose']);
});

test.for(['configuration', 'index'] as const)(
  'cancellation joins a held %s acquisition before rejecting readiness',
  async (held) => {
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    const configured = Promise.withResolvers<void>();
    const opened = Promise.withResolvers<void>();
    const failure = new Error('Recorded quit during platform acquisition');
    vi.mocked(openHostStateIndex).mockImplementation(async (...args) => {
      events.push('index-start');
      index = await original.openHostStateIndex(...args);
      opened.resolve();
      if (held === 'index') {
        await release.promise;
      }
      return index;
    });
    let settled = false;
    const creating = createProductionHostPlatform({
      configure: async () => {
        configured.resolve();
        if (held === 'configuration') {
          await release.promise;
        }
        return configuration();
      },
      memoryResourceIds: [],
      startup: { ...startup, signal: controller.signal },
    });
    void creating.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      await Promise.all([configured.promise, opened.promise]);
      controller.abort(failure);
      await Promise.resolve();
      expect(settled).toBe(false);
      await expect(RootLock.acquire(root)).rejects.toBeInstanceOf(RootLockedError);
      release.resolve();
      await expect(creating).rejects.toBe(failure);
      await owner.close();
    } finally {
      release.resolve();
      await creating.catch(() => undefined);
    }
  }
);

test('failed physical index cleanup retains the canonical writer and Root after configuration rejection', async () => {
  const { AgentHostStartupError, startAgentHost } = await import('../src/runtime.js');
  const configureFailure = new Error('Recorded configuration acquisition failure');
  const closeFailure = new Error('Recorded index physical join failure');
  await store.close();
  vi.mocked(openHostStateIndex).mockImplementation(async (...args) => {
    index = await original.openHostStateIndex(...args);
    return {
      ...index,
      close: async () => {
        throw closeFailure;
      },
    };
  });
  const cause: unknown = await startAgentHost({ lifetime: 'persistent', root }, async (context) => {
    store = context.store;
    const result = await createProductionHostPlatform({
      configure: async (partial) => {
        await partial.register(async () => {
          events.push('connection-dispose');
        });
        throw configureFailure;
      },
      memoryResourceIds: [],
      startup: context,
    });
    return result.platform;
  }).catch((failure: unknown) => failure);
  expect(cause).toBeInstanceOf(AgentHostStartupError);
  if (!(cause instanceof AgentHostStartupError)) {
    throw new Error('Failed startup released its writer');
  }
  expect(cause.store).toBe(store);
  expect(store.lock.isReleased).toBe(false);
  expect(events).toEqual(['connection-dispose']);
  await expect(RootLock.acquire(root)).rejects.toBeInstanceOf(RootLockedError);
  // Only the real worker join permits fixture teardown to release this writer.
  await index?.close();
  await store.close();
  const reopened = await RootLock.acquire(root);
  reopened.release();
});

test('an admitted selection joins before concurrent Scope cleanup can dispose its transport', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  // Same concrete scripted production admission as production-run-release: no
  // provider call, with the actual Memory/tool composition retained.
  const runtime = { model: 'gpt-6-sol', provider: 'openai' };
  const result = await createProductionHostPlatform({
    configure: async (context) => {
      await context.register(async () => {
        events.push('connection-dispose');
      });
      return {
        ...configuration(),
        readConfiguration: async () => ({
          close: async () => {
            events.push('selection-close');
            entered.resolve();
            await release.promise;
          },
          configuration: runtime,
          durableConfiguration: runtime,
          maxSteps: 3,
          memory: {
            native: {
              options: {
                lastMessages: 7,
                observationalMemory: false,
                semanticRecall: false,
                workingMemory: { enabled: true, scope: 'resource' as const },
              },
            },
            observerModelId: 'openai::gpt-4.1-mini',
            recordPrompt: async () => undefined,
            resourceId: 'production-release-fixture',
          },
          providerRequestContext: {
            inputTokenLimit: 50_000,
            provider: 'openai',
            runtimeData: runtime,
          },
          resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
          tools: {},
          toolTimeoutMs: 10_000,
        }),
        resolveModel: async () => scriptedToolSequence([]),
      };
    },
    memoryResourceIds: [],
    startup,
  });
  const admit = result.platform.admitRun;
  if (!admit) {
    throw new Error('The production platform omitted admission');
  }
  await admit({
    modelId: 'openai::gpt-6-sol',
    runId: 'held-run',
    signal: startup.signal,
    threadId: 'held-thread',
  });
  const closed = Promise.all([result.platform.close(), owner.close()]);
  try {
    await entered.promise;
    expect(events).toEqual(['index-start', 'selection-close']);
    release.resolve();
    await closed;
    expect(events).toEqual([
      'index-start',
      'selection-close',
      'transport-close',
      'index-close',
      'connection-dispose',
    ]);
  } finally {
    release.resolve();
    await closed;
  }
});

test('late Main binding refusal joins completed configuration before disposing RPC and releasing Root', async () => {
  const { startAgentHost } = await import('../src/runtime.js');
  const failure = new Error('Recorded Main capability binding refusal');
  await store.close();
  await expect(
    startAgentHost({ lifetime: 'persistent', root }, async (context) => {
      const result = await createProductionHostPlatform({
        configure: async (partial) => {
          await partial.register(async () => {
            events.push('connection-dispose');
          });
          return {
            ...configuration(),
            confirmMainReady: async () => {
              events.push('main-ready');
              throw failure;
            },
          };
        },
        memoryResourceIds: [],
        startup: context,
      });
      await result.configuration.confirmMainReady();
      return result.platform;
    })
  ).rejects.toBe(failure);
  expect(events).toEqual([
    'index-start',
    'main-ready',
    'transport-close',
    'index-close',
    'connection-dispose',
  ]);
  const reopened = await RootLock.acquire(root);
  reopened.release();
});
