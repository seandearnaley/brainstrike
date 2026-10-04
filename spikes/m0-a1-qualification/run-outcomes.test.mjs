import assert from 'node:assert/strict';
import test from 'node:test';
import { Coalescer } from '../../packages/state-store/src/coalescer.ts';
import { validateRunOutcomes } from './run-outcomes.mjs';

// biome-ignore lint/complexity/noUselessUndefined: Preserve the reviewed positional fixture defaults.
function fixture(label = 'root', status = 'completed', error = undefined) {
  const labels = ['root', ...Array.from({ length: 8 }, (_, index) => `C${index}`), 'root-wake'];
  const results = new Map(
    labels.map((name) => [
      name,
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        runId: name,
        threadId: name.startsWith('C') ? name : 'thread-contend',
        status: name === label ? status : 'completed',
        text: 'done',
        ...(name === label && error !== undefined ? { error } : {}),
      },
    ])
  );
  return /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
    labels: labels.slice(1, -1),
    results,
    host: /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
      runByLabel: (name) => results.get(name),
      result: (id) => Promise.resolve(results.get(id)),
      sendUserMessage: () => Promise.resolve(results.get('root')),
      waitIdle: () => Promise.resolve(),
    },
  };
}

test('completed root, eight children and wake are accepted through public results', async () => {
  const { host, labels } = fixture();
  const root = await host.sendUserMessage();
  const outcomes = await validateRunOutcomes(host, labels, root);
  assert.deepEqual(
    outcomes.map((result) => result.label),
    ['root', ...labels, 'root-wake']
  );
  assert.ok(outcomes.every((result) => result.status === 'completed'));
});

test('fulfilled failed/interrupted results after all 181 boundaries cannot become a measurement record', async () => {
  let boundaries = 0;
  const co = new Coalescer(
    {
      append: async (_items, committed) => {
        committed?.();
        return [];
      },
      syncBoundary: async () => {},
    },
    20,
    () => {},
    {
      onBoundarySyncIssued: () => {
        boundaries += 1;
      },
    }
  );
  for (let index = 0; index < 181; index++) {
    co.push('thread-contend', 'run', { type: 'finish-step' });
  }
  await co.flush();
  await co.drainSyncs();
  assert.equal(boundaries, 181);
  for (const label of ['root', 'C7', 'root-wake']) {
    for (const status of ['failed', 'interrupted']) {
      const { host, labels } = fixture(label, status);
      const root = await host.sendUserMessage();
      await host.waitIdle();
      assert.equal(boundaries, 181);
      assert.equal((await host.result(label)).status, status);
      await assert.rejects(
        validateRunOutcomes(host, labels, root),
        /Unsuccessful terminal result/,
        `${label}/${status} fulfilled as failure data`
      );
    }
  }
});

test('a completed result carrying a reported error is rejected for root, child or wake', async () => {
  for (const label of ['root', 'C7', 'root-wake']) {
    const { host, labels } = fixture(label, 'completed', 'late stream error');
    await assert.rejects(
      validateRunOutcomes(host, labels, await host.sendUserMessage()),
      /Unsuccessful terminal result/
    );
  }
});

test('an absent child or wake terminal result fails visibly', async () => {
  for (const label of ['C7', 'root-wake']) {
    const { host, labels, results } = fixture();
    results.delete(label);
    await assert.rejects(
      validateRunOutcomes(host, labels, await host.sendUserMessage()),
      /Missing expected run/
    );
  }
});
