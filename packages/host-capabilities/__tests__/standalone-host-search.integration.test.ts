/**
 * Through the trusted model seam, the standalone host searches and inspects
 * its launch root with its own grep and language-server tools.
 */
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  drainCleanup,
  recordedToolResults,
  standaloneHost,
  trustedPlatformModule,
} from './fixtures/standalone-trusted-host.ts';

afterEach(drainCleanup);

test('the standalone host searches its launch root with grepSearch', {
  timeout: 120_000,
}, async () => {
  const module = await trustedPlatformModule('trusted-fixture', [
    { input: { pattern: 'needle-2386' }, toolId: 'brainstrike_grepSearch' },
  ]);
  const host = await standaloneHost({}, module, {
    'haystack.txt': 'hay\nthe needle-2386 is here\nhay\n',
  });
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const searched = await host.run('trusted-fixture::probe');
  expect(searched.result, searched.result.stderr).toMatchObject({ code: 0 });
  // The model sees the launch root's matching file and line, found on disk by this host.
  expect(recordedToolResults(searched.rows)).toEqual([
    expect.objectContaining({
      output: { type: 'text', value: expect.stringMatching(/^haystack\.txt:2 \(1 match\)$/mu) },
      toolCallId: 'recorded-call-1',
    }),
  ]);
});

test('the standalone host inspects its launch root with the language server', {
  timeout: 120_000,
}, async () => {
  // lspInspect is a deferred tool: the model loads it by name, then calls it.
  const module = await trustedPlatformModule('trusted-fixture', [
    { input: { toolName: 'brainstrike_lspInspect' }, toolId: 'load_tool' },
    {
      input: { line: 2, match: 'answer', path: 'main.ts' },
      toolId: 'brainstrike_lspInspect',
    },
  ]);
  const host = await standaloneHost({}, module, {
    'main.ts': 'export const answer = 42;\nexport const doubled = answer * 2;\n',
  });
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const inspected = await host.run('trusted-fixture::probe');
  expect(inspected.result, inspected.result.stderr).toMatchObject({ code: 0 });
  // The model sees the symbol's type and its declaration, answered by a
  // language server this host started over its launch root and retired on stop.
  const result = recordedToolResults(inspected.rows).find(
    ({ toolCallId }) => toolCallId === 'recorded-call-2'
  );
  const text = z
    .object({ type: z.literal('text'), value: z.string() })
    .parse(result?.output, { reportInput: true }).value;
  expect(text).toMatch(/^lsp \| available=true\b/u);
  expect(text).toMatch(/^hover: .*const answer: 42/mu);
  expect(text).toMatch(/^definition \S*main\.ts:1 \| export const answer = 42;$/mu);
});
