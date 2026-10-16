// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assembleProviderCassette,
  createProviderCassetteReplay,
  encodeProviderCassette,
  PROVIDER_CASSETTE_FORMAT,
  type ProviderCassette,
  type ProviderCassetteKnob,
  type ProviderCassetteRecorder,
  type ProviderCassetteReplay,
  parseProviderCassette,
  parseProviderCassettePath,
  providerCassetteFindings,
  providerRequestKey,
  startProviderCassetteRecorder,
} from '../provider-cassette';

const servers: Server[] = [];
const recorders: ProviderCassetteRecorder[] = [];
afterEach(async () => {
  await Promise.all(recorders.splice(0).map((recorder) => recorder.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!(address && typeof address === 'object')) {
    throw new Error('no port');
  }
  return `http://127.0.0.1:${address.port}`;
}

/** A stand-in provider: three SSE frames written as separate chunks, the second splitting "é". */
const FRAMES = [
  Buffer.from('data: {"delta":"caf', 'utf8'),
  Buffer.from('data: {"delta":"café"}\n\n', 'utf8').subarray(0, 22),
  Buffer.concat([
    Buffer.from('data: {"delta":"café"}\n\n', 'utf8').subarray(22),
    Buffer.from('data: [DONE]\n\n', 'utf8'),
  ]),
];

async function startStandInProvider(options: { hold?: boolean } = {}) {
  const seen: { headers: Record<string, unknown>; url: string | undefined }[] = [];
  const url = await listen(
    createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the request body.
      }
      seen.push({ headers: request.headers, url: request.url });
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-Id': 'req_1' });
      for (const frame of options.hold ? FRAMES.slice(0, 1) : FRAMES) {
        response.write(frame);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!options.hold) {
        response.end();
      }
    })
  );
  return { seen, url };
}

function upstreamsAt(url: string): Record<ProviderCassetteKnob, string> {
  return {
    ['ANTHROPIC_BASE_URL']: `${url}/anthropic`,
    ['OPENAI_BASE_URL']: `${url}/openai`,
    ['OPENROUTER_BASE_URL']: `${url}/openrouter`,
  };
}

const turn = (content: string, extra: Record<string, unknown> = {}) => ({
  messages: [
    { content: 'You are a fixture.', role: 'system' },
    { content, role: 'user' },
  ],
  model: 'z-ai/glm-fixture',
  stream: true,
  tools: [{ function: { name: 'read' }, type: 'function' }],
  ...extra,
});

async function startReplay(replay: ProviderCassetteReplay) {
  const refusals: unknown[] = [];
  const url = await listen(
    createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk as Buffer);
      }
      const path = parseProviderCassettePath(request.url);
      if (!path) {
        throw new Error('bad path');
      }
      const refusal = await replay.serve({
        knob: path.knob,
        method: request.method ?? 'GET',
        rawBody: Buffer.concat(chunks),
        response,
        route: path.route,
      });
      if (refusal) {
        refusals.push(refusal);
        response.writeHead(401);
        response.end();
      }
    })
  );
  return { refusals, url };
}

async function readChunks(response: Response): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body ?? []) {
    chunks.push(Buffer.from(chunk));
  }
  return chunks;
}

describe('provider cassette recorder', () => {
  it('forwards a knob to its provider and keeps the exact bytes, chunks and no credentials', async () => {
    const provider = await startStandInProvider();
    const recorder = await startProviderCassetteRecorder({
      substitutions: [{ from: '/tmp/disposable-workspace', to: '<workspace>' }],
      upstreams: upstreamsAt(provider.url),
    });
    recorders.push(recorder);

    const response = await fetch(
      `${recorder.baseUrlFor('OPENROUTER_BASE_URL')}/chat/completions?x=1`,
      {
        body: JSON.stringify(turn('Read /tmp/disposable-workspace/a.txt')),
        headers: {
          Authorization: 'Bearer fixture-credential',
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://brainstrike.example',
          'X-Api-Key': 'fixture-credential',
        },
        method: 'POST',
      }
    );
    const received = Buffer.concat(await readChunks(response));

    expect(received.equals(Buffer.concat(FRAMES))).toBe(true);
    expect(provider.seen[0]?.url).toBe('/openrouter/chat/completions?x=1');
    // The client's credentials reach the provider; the recorder never stores them.
    expect(provider.seen[0]?.headers).toMatchObject({
      ['accept-encoding']: 'identity',
      authorization: 'Bearer fixture-credential',
    });
    const [exchange] = recorder.recording.exchanges();
    expect(exchange?.request.headers).toEqual({ ['content-type']: 'application/json' });
    expect(JSON.stringify(exchange)).not.toContain('fixture-credential');
    expect(JSON.stringify(exchange)).not.toContain('/tmp/disposable-workspace');
    expect(exchange?.response.chunks.map((chunk) => chunk.bytes)).toEqual(
      FRAMES.map((frame) => frame.length)
    );
    // Arrival times are recorded, so a paced replay can keep concurrent conversations in order.
    expect(exchange?.response.chunks.at(-1)?.atMs).toBeGreaterThanOrEqual(10);
    expect(exchange?.response).toMatchObject({
      contentType: 'text/event-stream',
      ended: 'complete',
      status: 200,
    });
    expect(Buffer.from(exchange?.response.body ?? '', 'utf8').equals(Buffer.concat(FRAMES))).toBe(
      true
    );
    expect(exchange?.key).toEqual({
      knob: 'OPENROUTER_BASE_URL',
      lane: 'Read <workspace>/a.txt',
      method: 'POST',
      model: 'z-ai/glm-fixture',
      position: 1,
      route: '/chat/completions',
      stream: true,
      tools: true,
    });
  });

  it('keeps each distinct tool-definition list once, named by digest from every request', async () => {
    const provider = await startStandInProvider();
    const recorder = await startProviderCassetteRecorder({ upstreams: upstreamsAt(provider.url) });
    recorders.push(recorder);
    for (const content of ['first', 'second']) {
      await readChunks(
        await fetch(`${recorder.baseUrlFor('OPENROUTER_BASE_URL')}/chat/completions`, {
          body: JSON.stringify(turn(content)),
          method: 'POST',
        })
      );
    }
    const cassette = assembleProviderCassette({
      exchanges: recorder.recording.exchanges(),
      recordedAt: '2026-10-16T00:00:00.000Z',
      scenario: 'fixture',
    });
    const refs = cassette.exchanges.map(
      (exchange) => (exchange.request.body as { tools: unknown }).tools
    );
    expect(refs[0]).toEqual(refs[1]);
    const [digest] = Object.keys(cassette.toolSets);
    expect(refs[0]).toEqual({ toolSet: digest });
    expect(cassette.toolSets[digest ?? '']).toEqual([
      { function: { name: 'read' }, type: 'function' },
    ]);
  });

  it('records a client that hangs up mid-response as client-aborted', async () => {
    const provider = await startStandInProvider({ hold: true });
    const recorder = await startProviderCassetteRecorder({ upstreams: upstreamsAt(provider.url) });
    recorders.push(recorder);
    const controller = new AbortController();
    const response = await fetch(`${recorder.baseUrlFor('ANTHROPIC_BASE_URL')}/messages`, {
      body: JSON.stringify(turn('Stop me')),
      method: 'POST',
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    await expect.poll(() => recorder.recording.inFlight()).toBe(0);

    expect(recorder.recording.exchanges()[0]?.response).toMatchObject({
      body: 'data: {"delta":"caf',
      ended: 'client-aborted',
    });
  });
});

describe('provider cassette replay', () => {
  function cassetteOf(recorder: ProviderCassetteRecorder): ProviderCassette {
    return parseProviderCassette(
      encodeProviderCassette(
        assembleProviderCassette({
          exchanges: recorder.recording.exchanges(),
          recordedAt: '2026-10-16T00:00:00.000Z',
          scenario: 'fixture',
        })
      ),
      'fixture.json'
    );
  }

  it('serves the recorded bytes in their recorded chunks, once each', async () => {
    const provider = await startStandInProvider();
    const recorder = await startProviderCassetteRecorder({ upstreams: upstreamsAt(provider.url) });
    recorders.push(recorder);
    const body = JSON.stringify(turn('Read a.txt'));
    await readChunks(
      await fetch(`${recorder.baseUrlFor('OPENROUTER_BASE_URL')}/chat/completions`, {
        body,
        method: 'POST',
      })
    );
    const replay = createProviderCassetteReplay(cassetteOf(recorder));
    const server = await startReplay(replay);

    const first = await fetch(`${server.url}/OPENROUTER_BASE_URL/chat/completions`, {
      body,
      method: 'POST',
    });
    const chunks = await readChunks(first);
    expect(first.headers.get('content-type')).toBe('text/event-stream');
    expect(Buffer.concat(chunks).equals(Buffer.concat(FRAMES))).toBe(true);
    expect(chunks.map((chunk) => chunk.length)).toEqual(FRAMES.map((frame) => frame.length));
    expect(replay.unserved()).toEqual([]);

    const again = await fetch(`${server.url}/OPENROUTER_BASE_URL/chat/completions`, {
      body,
      method: 'POST',
    });
    expect(again.status).toBe(401);
    expect(server.refusals).toHaveLength(1);
  });

  it('matches a step by lane and position, never by system prompt or tool definitions', async () => {
    const provider = await startStandInProvider();
    const recorder = await startProviderCassetteRecorder({ upstreams: upstreamsAt(provider.url) });
    recorders.push(recorder);
    await readChunks(
      await fetch(`${recorder.baseUrlFor('OPENROUTER_BASE_URL')}/chat/completions`, {
        body: JSON.stringify(turn('Read a.txt')),
        method: 'POST',
      })
    );
    const replay = createProviderCassetteReplay(cassetteOf(recorder));
    const server = await startReplay(replay);

    const otherLane = await fetch(`${server.url}/OPENROUTER_BASE_URL/chat/completions`, {
      body: JSON.stringify(turn('Read b.txt')),
      method: 'POST',
    });
    expect(otherLane.status).toBe(401);
    const reworded = turn('Read a.txt', {
      tools: [{ function: { name: 'renamed' }, type: 'function' }],
    });
    reworded.messages[0] = { content: 'A changed system prompt.', role: 'system' };
    const served = await fetch(`${server.url}/OPENROUTER_BASE_URL/chat/completions`, {
      body: JSON.stringify(reworded),
      method: 'POST',
    });
    expect(served.status).toBe(200);
  });

  it('waits out the recorded chunk times when paced, and serves at once when not', async () => {
    const provider = await startStandInProvider();
    const recorder = await startProviderCassetteRecorder({ upstreams: upstreamsAt(provider.url) });
    recorders.push(recorder);
    const body = JSON.stringify(turn('Read a.txt'));
    await readChunks(
      await fetch(`${recorder.baseUrlFor('OPENROUTER_BASE_URL')}/chat/completions`, {
        body,
        method: 'POST',
      })
    );
    const cassette = cassetteOf(recorder);
    const recordedMs = cassette.exchanges[0]?.response.chunks.at(-1)?.atMs ?? 0;
    const elapsed = async (pace: number): Promise<number> => {
      const server = await startReplay(createProviderCassetteReplay(cassette, { pace }));
      const started = Date.now();
      await readChunks(
        await fetch(`${server.url}/OPENROUTER_BASE_URL/chat/completions`, { body, method: 'POST' })
      );
      return Date.now() - started;
    };
    expect(await elapsed(1)).toBeGreaterThanOrEqual(recordedMs);
    expect(await elapsed(0)).toBeLessThan(recordedMs);
  });

  it('holds a client-aborted exchange open after its last chunk until the client hangs up', async () => {
    const provider = await startStandInProvider({ hold: true });
    const recorder = await startProviderCassetteRecorder({ upstreams: upstreamsAt(provider.url) });
    recorders.push(recorder);
    const recording = new AbortController();
    const body = JSON.stringify(turn('Stop me'));
    const live = await fetch(`${recorder.baseUrlFor('ANTHROPIC_BASE_URL')}/messages`, {
      body,
      method: 'POST',
      signal: recording.signal,
    });
    await live.body?.getReader().read();
    recording.abort();
    await expect.poll(() => recorder.recording.inFlight()).toBe(0);
    const replay = createProviderCassetteReplay(cassetteOf(recorder));
    const server = await startReplay(replay);

    const stop = new AbortController();
    const replayed = await fetch(`${server.url}/ANTHROPIC_BASE_URL/messages`, {
      body,
      method: 'POST',
      signal: stop.signal,
    });
    const reader = replayed.body?.getReader();
    const first = await reader?.read();
    expect(Buffer.from(first?.value ?? []).toString('utf8')).toBe('data: {"delta":"caf');
    const pending = reader?.read();
    const raced = await Promise.race([
      pending?.then(() => 'more'),
      new Promise((resolve) => setTimeout(() => resolve('held'), 50)),
    ]);
    expect(raced).toBe('held');
    expect(replay.holding()).toBe(1);
    stop.abort();
    await expect(pending).rejects.toThrow();
    await expect.poll(() => replay.holding()).toBe(0);
  });
});

describe('provider request keys', () => {
  it('matches a non-streamed toolless request (a title) by model alone', () => {
    const key = (prompt: string) =>
      providerRequestKey({
        body: {
          messages: [{ content: prompt, role: 'user' }],
          model: 'claude-fixture',
          system: 'instructions',
        },
        knob: 'ANTHROPIC_BASE_URL',
        method: 'POST',
        route: '/messages',
      });
    expect(key('Hello')).toEqual(key('<message>\nHello\n</message>'));
    expect(key('Hello')).toMatchObject({ lane: '', position: 0, stream: false, tools: false });
  });

  it('reads the lane from Responses input parts', () => {
    expect(
      providerRequestKey({
        body: {
          input: [
            { content: 'policy', role: 'developer' },
            { content: [{ text: 'Explore fixture one.', type: 'input_text' }], role: 'user' },
            { arguments: '{}', call_id: 'call_1', name: 'read', type: 'function_call' },
            { call_id: 'call_1', output: 'ok', type: 'function_call_output' },
          ],
          model: 'gpt-fixture',
          stream: true,
        },
        knob: 'OPENAI_BASE_URL',
        method: 'POST',
        route: '/responses',
      })
    ).toMatchObject({ lane: 'Explore fixture one.', position: 3 });
  });
});

describe('provider cassette findings', () => {
  it('names the rule and the part holding an identifying literal, without echoing it', () => {
    const cassette = parseProviderCassette(
      JSON.stringify({
        exchanges: [
          {
            key: {},
            request: { body: { note: '/Users/fixture-user/project' }, headers: {} },
            response: { body: 'nothing local', chunks: [{ atMs: 0, bytes: 13 }] },
          },
        ],
        format: PROVIDER_CASSETTE_FORMAT,
        recordedAt: '2026-10-16T00:00:00.000Z',
        scenario: 'fixture',
        toolSets: { abc: [{ description: 'reads /Users/fixture-user/x' }] },
      }),
      'fixture.json'
    );
    const findings = providerCassetteFindings(cassette, [
      { rule: 'home-directory', value: '/Users/fixture-user' },
    ]);
    expect(findings).toEqual([
      { exchange: 0, part: 'request', rule: 'home-directory' },
      { exchange: null, part: 'tool-sets', rule: 'home-directory' },
    ]);
    expect(JSON.stringify(findings)).not.toContain('fixture-user');
  });

  it('refuses a cassette whose chunks do not cover its body', () => {
    expect(() =>
      parseProviderCassette(
        JSON.stringify({
          exchanges: [
            { key: {}, request: {}, response: { body: 'abc', chunks: [{ atMs: 0, bytes: 2 }] } },
          ],
          format: PROVIDER_CASSETTE_FORMAT,
          toolSets: {},
        }),
        'short.json'
      )
    ).toThrow('short.json exchange 0 is malformed');
  });
});
