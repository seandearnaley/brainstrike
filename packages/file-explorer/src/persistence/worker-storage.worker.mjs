// PROOF ONLY: no key/value/error payloads, no changed responses or deadlines.
let proofEvents = 0;
const proofPhases = new Set([
  'serialize-start',
  'serialize-finished',
  'worker-received',
  'storage-response-received',
  'storage-request-posted',
]);
function proof(phase, data) {
  if (
    typeof self.location === 'undefined' ||
    new URL(self.location.href).searchParams.get('brainstrikeProofPersistence') !== '1'
  ) {
    return;
  }
  if (!proofPhases.has(phase) || proofEvents > 512) {
    return;
  }
  if (proofEvents++ === 512) {
    // biome-ignore lint/suspicious/noConsole: Temporary bounded proof output uses the captured worker/renderer console transport.
    console.warn(
      '[persistence-proof] ' +
        JSON.stringify({ limit: 512, phase: 'truncated', timeOrigin: performance.timeOrigin })
    );
    return;
  }
  // biome-ignore lint/suspicious/noConsole: Temporary bounded proof output uses the captured worker/renderer console transport.
  console.warn(
    '[persistence-proof] ' +
      JSON.stringify({
        at: Date.now(),
        layer: 'serialization-worker',
        monotonicMs: performance.now(),
        phase,
        requestId: typeof data.id === 'string' && /^\d+$/u.test(data.id) ? data.id : undefined,
        timeOrigin: performance.timeOrigin,
      })
  );
}
// ESM source entry used directly by Desktop's workspace source aliases.
// Handle save operation
function handleSaveOperation(data) {
  if (!data.key || data.value === undefined) {
    throw new Error('Save operation requires key and value');
  }

  proof('serialize-start', data);
  const serialized = typeof data.value === 'string' ? data.value : JSON.stringify(data.value);
  proof('serialize-finished', data);
  const opId = Date.now();

  self.postMessage({
    id: data.id,
    key: data.key,
    operation: 'setItem',
    opId,
    type: 'storage_request',
    value: serialized,
  });
  proof('storage-request-posted', data);
}

// Handle load operation
function handleLoadOperation(data) {
  if (!data.key) {
    throw new Error('Load operation requires key');
  }

  self.postMessage({
    id: data.id,
    key: data.key,
    operation: 'getItem',
    type: 'storage_request',
  });
}

// Handle remove operation
function handleRemoveOperation(data) {
  if (!data.key) {
    throw new Error('Remove operation requires key');
  }

  self.postMessage({
    id: data.id,
    key: data.key,
    operation: 'removeItem',
    type: 'storage_request',
  });
}

// Handle storage response
function handleStorageResponse(data) {
  proof('storage-response-received', data);
  let result = true;
  if (data.operation === 'getItem') {
    if (data.rawValue) {
      try {
        result = JSON.parse(data.rawValue);
      } catch {
        throw new Error('Persisted state contains invalid JSON');
      }
    } else {
      result = null;
    }
  }

  self.postMessage({
    id: data.id,
    result,
    type: 'success',
  });
}

self.addEventListener('message', async (event) => {
  const data = event.data;
  proof('worker-received', data);

  try {
    switch (data.type) {
      case 'save':
        handleSaveOperation(data);
        break;
      case 'load':
        handleLoadOperation(data);
        break;
      case 'remove':
        handleRemoveOperation(data);
        break;
      case 'storage_response':
        handleStorageResponse(data);
        break;
      default:
        throw new Error(`Unknown operation type: ${data.type}`);
    }
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'Unknown error',
      id: data.id,
      type: 'error',
    });
  }
});

export {};
