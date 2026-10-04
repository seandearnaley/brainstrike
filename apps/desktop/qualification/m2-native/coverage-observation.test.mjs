import assert from 'node:assert/strict';
import test from 'node:test';
import { observeCoverage } from './coverage-observation.ts';

const invalidated = () => ({
  code: 'native-coverage-observation-invalidated',
  kind: 'invalidated',
});

test('records a rejected observation and requires a wholly fresh successful read', async () => {
  const recorded = [];
  let reads = 0;
  const read = async () => {
    reads += 1;
    if (reads === 1) {
      return invalidated();
    }
    return { kind: 'current', value: { complete: true, counters: 3, receipt: 'fresh' } };
  };
  const record = async (phase, value) => {
    recorded.push({ phase, value });
  };
  assert.deepEqual(await observeCoverage(read, record), invalidated());
  assert.equal(reads, 1);
  assert.equal(recorded.length, 1);
  assert.deepEqual(await observeCoverage(read, record), {
    kind: 'current',
    value: { complete: true, counters: 3, receipt: 'fresh' },
  });
  assert.equal(reads, 2);
});

test('unrelated errors terminate the observation without retry or success', async () => {
  for (const error of [
    new Error('Corrupt vector bytes'),
    Object.assign(new Error('Native source or saved profile changed during search.'), {
      category: 'native-index',
      code: 'native-index-failed',
    }),
    new Error('Native saved configuration is being revalidated.'),
  ]) {
    let reads = 0;
    await assert.rejects(
      observeCoverage(
        async () => {
          reads += 1;
          throw error;
        },
        async () => {
          assert.fail('Unrelated failure must not be recorded as a transient observation');
        }
      ),
      (actual) => actual === error
    );
    assert.equal(reads, 1);
  }
});

test('failure to preserve invalidation evidence terminates the observation', async () => {
  const failure = new Error('Evidence write failed');
  await assert.rejects(
    observeCoverage(
      async () => invalidated(),
      async () => {
        throw failure;
      }
    ),
    (error) => error === failure
  );
});
