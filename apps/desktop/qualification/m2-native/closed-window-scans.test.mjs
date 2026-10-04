import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { settledScans } from './closed-window-scans.ts';

const sample = JSON.parse(
  await readFile(new URL('./closed-window-scan-sample.json', import.meta.url), 'utf8')
);

test('retains the recorded newline-stripped stdout contract and rejects empty framing', () => {
  assert.ok(sample.stdout.length > 1);
  assert.ok(sample.stdout.every((line) => !line.includes('\n')));
  assert.deepEqual(settledScans([sample.stdout.join('')]), []);
});

test('decodes the actual closed-window workspace and collection tickets from the real buffer', () => {
  const scans = settledScans(sample.stdout);
  assert.equal(scans.length, 19);
  assert.deepEqual(
    scans.slice(-2).map(({ receipt, settledAt }) => ({
      generation: receipt.ticket.generation,
      reason: receipt.reason,
      requestId: receipt.ticket.requestId,
      scanComplete: receipt.scanComplete,
      scope: receipt.ticket.scope,
      settledAt,
      storeId: receipt.ticket.storeId,
    })),
    [
      {
        generation: 5,
        reason: 'complete',
        requestId: 'e469b9bb-9a19-49c7-9f55-d1144b201bf4',
        scanComplete: true,
        scope: { kind: 'workspace', rootId: 'ca46d0ac-1d04-4a97-a19f-cd249ca0ce16' },
        settledAt: '2026-10-03T21:46:58.720Z',
        storeId: '8792914fdb7b65e5e421256ffff5da6083b60413c115ffa3ec34c91b68033401',
      },
      {
        generation: 13,
        reason: 'complete',
        requestId: '38ed6bef-4bb4-42d8-878a-9c7c6d82ba9a',
        scanComplete: true,
        scope: { embeddingSetId: '0f7d35df-b8ca-4e0c-ac6c-1be5ded89a20', kind: 'collection' },
        settledAt: '2026-10-03T21:46:58.726Z',
        storeId: '8792914fdb7b65e5e421256ffff5da6083b60413c115ffa3ec34c91b68033401',
      },
    ]
  );
});
