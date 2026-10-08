import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isMainThread, threadId } from 'node:worker_threads';

const receipt = process.env.BRAINSTRIKE_M3_STANDALONE_RECEIPT;
if (!receipt) {
  throw new Error('Standalone offline fixture requires its disposable receipt path');
}
function record(phase, fields = {}) {
  appendFileSync(receipt, `${JSON.stringify({ phase, pid: process.pid, threadId, ...fields })}\n`);
}
globalThis[Symbol.for('brainstrike.standalone.offlineFixture')] = true;
record('process-start', {
  electron: process.versions.electron ?? null,
  entry: process.argv[1],
  executable: process.execPath,
  isMainThread,
  parent: process.ppid,
});
process.once('exit', (code) => record('process-exit', { code }));
const keyringFixtureUrl = `data:text/javascript,${encodeURIComponent(`
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { isMainThread, threadId } from 'node:worker_threads';
function record(phase, fields) {
  appendFileSync(process.env.BRAINSTRIKE_M3_STANDALONE_RECEIPT,
    JSON.stringify({ phase, pid: process.pid, threadId, ...fields }) + '\\n');
}
export class AsyncEntry {
  constructor(service, account, options) {
    assert.equal(isMainThread, false);
    assert.equal(service, 'brainstrike-standalone-fixture-service');
    assert.equal(account, 'openai');
    assert.deepEqual(options, { linux: { store: 'secret-service' } });
    record('synthetic-keyring-entry', { service, account, options });
  }
  async getPassword() {
    record('synthetic-keyring-read', {});
    return JSON.stringify({ key: 'offline-standalone-fixture', type: 'api_key' });
  }
  setPassword() { throw new Error('Synthetic keyring fixture forbids writes'); }
  deleteCredential() { throw new Error('Synthetic keyring fixture forbids deletes'); }
}
export function findCredentialsAsync() { throw new Error('Synthetic keyring fixture forbids enumeration'); }
`)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === '@napi-rs/keyring' &&
      process.env.BRAINSTRIKE_M3_STANDALONE_CREDENTIAL === 'keyring'
    ) {
      record('synthetic-keyring-module');
      return { shortCircuit: true, url: keyringFixtureUrl };
    }
    // Any unexpected OS credential or Electron import is an actual fixture failure.
    if (specifier === 'electron' || specifier === '@napi-rs/keyring') {
      record('forbidden-capability', { specifier });
      throw new Error('Offline standalone fixture forbids OS credentials and Electron');
    }
    return next(specifier, context);
  },
});

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('authorization'), 'Bearer offline-standalone-fixture');
  const body = await request.json();
  assert.equal(body.stream, true);
  assert.equal(body.store, true);
  record('provider-request', { body, url: request.url });
  const text = 'Offline standalone production reply';
  const model = body.model;
  // The Responses streaming shape is the existing public SDK7 Memory fixture's
  // responsesApiStream shape; no SDK model or production platform is substituted.
  const itemId = 'msg_standalone_1';
  const part = { annotations: [], text, type: 'output_text' };
  const item = {
    content: [part],
    id: itemId,
    role: 'assistant',
    status: 'completed',
    type: 'message',
  };
  const response = {
    created_at: 1_753_600_000,
    id: 'resp_standalone_1',
    model,
    object: 'response',
    output: [item],
    status: 'completed',
    usage: { input_tokens: 42, output_tokens: 9, total_tokens: 51 },
  };
  const position = { content_index: 0, item_id: itemId, output_index: 0 };
  let frames = [
    { response: { ...response, output: [], status: 'in_progress' }, type: 'response.created' },
    {
      item: { ...item, content: [], status: 'in_progress' },
      output_index: 0,
      type: 'response.output_item.added',
    },
    { ...position, part: { ...part, text: '' }, type: 'response.content_part.added' },
    { ...position, delta: text, type: 'response.output_text.delta' },
    { ...position, text, type: 'response.output_text.done' },
    { ...position, part, type: 'response.content_part.done' },
    { item, output_index: 0, type: 'response.output_item.done' },
    { response, type: 'response.completed' },
  ];
  const mode = process.env.BRAINSTRIKE_M3_STANDALONE_HTTP;
  if (mode === 'question' || mode === 'plan') {
    const committed = JSON.parse(
      readFileSync(
        new URL(
          `../../../../apps/desktop/src/__tests__/fixtures/committed-host-${mode}.json`,
          import.meta.url
        ),
        'utf8'
      )
    );
    const request = committed.find(({ event }) => event.type === 'interaction.requested')?.event;
    assert.equal(request?.kind, mode);
    const name = request.toolId;
    assert.ok(body.tools.some((tool) => tool.type === 'function' && tool.name === name));
    const results = body.input.filter((item) => item.type === 'function_call_output');
    if (results.length === 0) {
      const args = JSON.stringify(request.input);
      const call = {
        arguments: args,
        call_id: 'call_standalone_human_1',
        id: 'fc_standalone_human_1',
        name,
        status: 'completed',
        type: 'function_call',
      };
      const completed = { ...response, output: [call] };
      frames = [
        { response: { ...completed, output: [], status: 'in_progress' }, type: 'response.created' },
        {
          item: { ...call, arguments: '', status: 'in_progress' },
          output_index: 0,
          type: 'response.output_item.added',
        },
        {
          delta: args,
          item_id: call.id,
          output_index: 0,
          type: 'response.function_call_arguments.delta',
        },
        {
          arguments: args,
          item_id: call.id,
          output_index: 0,
          type: 'response.function_call_arguments.done',
        },
        { item: call, output_index: 0, type: 'response.output_item.done' },
        { response: completed, type: 'response.completed' },
      ];
    } else {
      assert.equal(results.length, 1);
      assert.equal(results[0].call_id, 'call_standalone_human_1');
    }
  }
  const encoder = new TextEncoder();
  const held = process.env.BRAINSTRIKE_M3_STANDALONE_HTTP === 'hold';
  let abort;
  const stream = new ReadableStream({
    cancel() {
      if (abort) {
        request.signal.removeEventListener('abort', abort);
      }
      record('provider-body-cancelled');
    },
    start(controller) {
      for (const frame of held ? frames.slice(0, 4) : frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      if (held) {
        abort = () => {
          record('provider-aborted');
          controller.error(request.signal.reason);
        };
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) {
          abort();
        }
      } else {
        controller.close();
        record('provider-body-closed');
      }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' }, status: 200 });
};
