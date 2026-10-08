// Plain-Node owner of one deterministic MCP lab session (BST-1930/BST-1931).
// Desktop declares no lab dependency, so this child loads the lab's built
// public `./lab` entry from the repository layout. The parent forks it with an
// explicit empty environment and talks only over the IPC channel:
//   parent -> { type: 'start', scenario }  child -> { type: 'ready', ... }
//   parent -> { type: 'close' }            child -> { type: 'closed', report }
// Any failure is reported as { type: 'failed', phase, message } and the child
// exits non-zero. The child never stays alive without its parent.
// A start with `retainAfterClose: true` is the deterministic harness fault for
// #3543 6052105986: the child reports `closed` but keeps its IPC channel (a live
// handle) open, so it stays alive until its parent kills it or disconnects.

const LAB_ENTRY = new URL('../../../../../packages/mcp-test-lab/dist/lab.js', import.meta.url);
const SCENARIOS = new Set(['apps-reference', 'legacy-reference', 'tasks-reference']);

let session;
let closing;
let retainAfterClose = false;

function send(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected) {
      reject(new Error('MCP lab fixture lost its IPC channel'));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

function describe(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function fail(phase, error) {
  process.exitCode = 1;
  try {
    await send({ message: describe(error), phase, type: 'failed' });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
}

function close() {
  closing ??= (async () => {
    if (!session) {
      throw new Error('MCP lab fixture has no started session');
    }
    return await session.close();
  })();
  return closing;
}

async function start(scenario) {
  if (session) {
    throw new Error('MCP lab fixture already owns a session');
  }
  if (!SCENARIOS.has(scenario)) {
    throw new Error(`MCP lab fixture does not serve scenario ${String(scenario)}`);
  }
  const { startMcpLabScenario } = await import(LAB_ENTRY.href);
  session = await startMcpLabScenario(scenario, { execution: 'loopback' });
  const { endpoint, scenario: manifest } = session;
  if (endpoint.kind !== 'loopback-http') {
    throw new Error(`MCP lab returned a ${endpoint.kind} endpoint`);
  }
  await send({
    authentication: manifest.authentication,
    endpoint: endpoint.url.href,
    fixture: manifest.fixture,
    fixtureSourceSha256: manifest.fixtureSource.sha256 ?? null,
    pid: process.pid,
    protocol: manifest.protocol.version,
    scenario: manifest.id,
    transport: manifest.transport,
    type: 'ready',
    usesAmbientCredentials: manifest.usesAmbientCredentials,
  });
}

process.on('message', (message) => {
  if (message?.type === 'start') {
    retainAfterClose = message.retainAfterClose === true;
    start(message.scenario).catch((error) => fail('start', error));
    return;
  }
  if (message?.type === 'close') {
    close()
      .then(async (report) => {
        await send({ report, type: 'closed' });
        if (!retainAfterClose) {
          process.disconnect();
        }
      })
      .catch((error) => fail('close', error));
    return;
  }
  fail('protocol', new Error('MCP lab fixture received an unknown command')).catch(() => {
    process.exitCode = 1;
  });
});

// An orphaned child closes its listener and exits instead of outliving the test.
process.on('disconnect', () => {
  if (session && !closing) {
    close().catch(() => {
      process.exitCode = 1;
    });
  }
});
