import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createArtifactFlow } from './artifact-flow.ts';
import { startCapturingProvider } from './provider-capture.ts';

const marker = 'M2_ARTIFACT_MATCH_AFTER_8000';
const reader = 'brainstrike_readToolOutputArtifact';
const producer = 'm2-output_read_corpus';
const source = await readFile(new URL('./corpus/disposer-stack.ts', import.meta.url), 'utf8');
const corpus = `${source}\n${'// first-page-padding\n'.repeat(600)}// ${marker}\n`.padEnd(
  30_000,
  ' '
);
const serializedProducer = JSON.stringify({
  content: [
    Object.fromEntries([
      ['type', 'text'],
      ['text', corpus],
    ]),
  ],
});
const actual = JSON.parse(
  await readFile(new URL('./artifact-continuation-sample.json', import.meta.url), 'utf8')
);
const original = Buffer.from(serializedProducer);
assert.equal(original.length, 30_735);
const user = { content: 'Run the M2 artifact-search acceptance tools.', role: 'user' };

function fixtures(missingMarker = false) {
  const matches = [
    { line: 1, lineText: original.subarray(5500).toString('utf8'), offsetByte: 5500 },
  ];
  if (missingMarker) {
    matches[0].lineText = matches[0].lineText.replace(marker, 'X'.repeat(marker.length));
  }
  const searched = {
    artifactRef: {
      byteLength: 30_735,
      expiresAt: '2026-10-10T11:55:19.484Z',
      format: 'json',
      id: '00000000-0000-4000-8000-000000000000',
    },
    endByte: 30_735,
    matches,
    offsetByte: 5500,
    searchLimited: false,
    type: 'artifact_search',
  };
  const bytes = Buffer.from(JSON.stringify(searched));
  assert.equal(bytes.length, 25_991);
  assert.equal(bytes.subarray(actual.offsetByte, actual.endByte).toString('utf8'), actual.content);
  const boundaries = [0, 5270, 11_270, 17_270, 23_270, bytes.length];
  const pages = boundaries.slice(0, -1).map((offsetByte, index) => {
    const endByte = boundaries[index + 1];
    const decoded =
      index === 1 ? actual.content : bytes.subarray(offsetByte, endByte).toString('utf8');
    return {
      content: index === 2 ? JSON.stringify(decoded) : decoded,
      ...(index === 2 ? { contentEncoding: 'json-string' } : {}),
      endByte,
      format: 'json',
      offsetByte,
      ...(index === boundaries.length - 2
        ? { complete: true }
        : { next: { input: { cursor: `opaque-nested-${endByte}` }, tool: reader } }),
    };
  });
  return [
    { nextOffset: null, tools: [{ name: producer }], total: 1 },
    { success: true, toolName: producer },
    {
      content: original.subarray(0, 5500).toString('utf8'),
      endByte: 5500,
      format: 'json',
      next: { input: { cursor: 'opaque-original-5500' }, tool: reader },
      offsetByte: 0,
    },
    ...pages,
  ];
}

async function harness() {
  const flow = createArtifactFlow({ marker, serializedProducer, serverName: 'm2-output' });
  const provider = await startCapturingProvider(flow.select);
  const tools = ['list_available_tools', 'load_tool', producer, reader].map((name) => ({
    function: { name },
    type: 'function',
  }));
  const post = async (messages) => {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      body: JSON.stringify({ messages, stream: false, tools }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    return { body: await response.json(), status: response.status };
  };
  const responseFor = (call, value) => ({
    content: JSON.stringify(value),
    name: call.function.name,
    role: 'tool',
    tool_call_id: call.id,
  });
  return { flow, post, provider, responseFor };
}

async function runFlow(mutate, missingMarker = false) {
  const h = await harness();
  const calls = [];
  let messages = [user];
  try {
    for (const [index, value] of fixtures(missingMarker).entries()) {
      const response = await h.post(messages);
      assert.equal(response.status, 200);
      const call = response.body.choices[0].message.tool_calls[0];
      calls.push(call);
      if (index >= 4) {
        assert.deepEqual(JSON.parse(call.function.arguments), {
          cursor: `opaque-nested-${value.offsetByte}`,
        });
      }
      const tool = h.responseFor(call, value);
      messages =
        index >= 4
          ? [user, { role: 'assistant', tool_calls: [call] }, tool]
          : [...messages, { role: 'assistant', tool_calls: [call] }, tool];
      if (mutate?.index === index) {
        return { ...(await h.post(mutate.messages(messages, tool))), state: h.flow.snapshot() };
      }
    }
    const final = await h.post(messages);
    assert.equal(final.status, 200);
    assert.equal(final.body.choices[0].message.content, 'M2 qualification tools completed');
    assert.equal(calls.filter((call) => call.function.name === producer).length, 1);
    assert.deepEqual(JSON.parse(calls[3].function.arguments), {
      caseSensitive: true,
      cursor: 'opaque-original-5500',
      isRegex: false,
      pattern: marker,
    });
    assert.deepEqual(
      h.provider.transcript().map((turn) => turn.toolResultCount),
      [0, 1, 2, 3, 4, 1, 1, 1, 1]
    );
    assert.equal(h.flow.snapshot().stage, 'complete');
    assert.equal(h.flow.snapshot().responses.length, 8);
    assert.equal(
      h.flow.snapshot().recovered.matches[0].lineText,
      original.subarray(5500).toString('utf8')
    );
    assert.equal(h.flow.snapshot().recovered.searchLimited, false);
    return { status: 200 };
  } finally {
    await h.provider.close();
  }
}

test('real HTTP completes every artifact stage and EOF with catalog and prior pages pruned', async () => {
  assert.equal((await runFlow()).status, 200);
});

test('real HTTP rejects duplicate, stale, inconsistent, mismatched and cross-turn responses', async () => {
  for (const variant of [
    { index: 0, messages: (messages, tool) => [...messages, tool] },
    { index: 1, messages: (messages) => [user, messages[2]] },
    {
      index: 1,
      messages: (messages) =>
        messages.map((message, index) => (index === 2 ? { ...message, content: '{}' } : message)),
    },
    { index: 0, messages: (_messages, tool) => [user, { ...tool, name: 'wrong-tool' }] },
    { index: 0, messages: (_messages, tool) => [{ content: 'another turn', role: 'user' }, tool] },
    {
      index: 4,
      messages: (_messages, tool) => [
        user,
        { ...tool, content: JSON.stringify({ ...JSON.parse(tool.content), offsetByte: 0 }) },
      ],
    },
    {
      index: 4,
      messages: (_messages, tool) => [
        user,
        {
          ...tool,
          content: JSON.stringify({
            ...JSON.parse(tool.content),
            next: { input: { cursor: 'opaque-nested-5270' }, tool: reader },
          }),
        },
      ],
    },
  ]) {
    assert.equal((await runFlow(variant)).status, 400);
  }
});

test('real HTTP refuses final completion when the reconstructed full search omits the marker', async () => {
  const result = await runFlow({ index: 7, messages: (messages) => messages }, true);
  assert.equal(result.status, 400);
  assert.notEqual(result.state.stage, 'complete');
});
