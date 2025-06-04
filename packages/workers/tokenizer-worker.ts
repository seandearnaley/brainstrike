import { parentPort, workerData } from 'node:worker_threads';

interface WorkerRequest {
  id: number;
  method: 'countTokensAccurate' | 'calculateGroupTokens';
  text?: string;
  texts?: string[];
}

interface WorkerResponse {
  id: number;
  result?: number;
  error?: string;
}

let tokenizerPromise: Promise<any> | null = null;

async function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = import(workerData.modulePath).catch((err) => {
      tokenizerPromise = null;
      throw err;
    });
  }
  return tokenizerPromise;
}

parentPort?.on('message', async (msg: WorkerRequest) => {
  const { id, method, text, texts } = msg;
  try {
    const tokenizer = await getTokenizer();
    if (method === 'countTokensAccurate') {
      const result = tokenizer.encode(text ?? '').length;
      parentPort?.postMessage({ id, result } satisfies WorkerResponse);
    } else if (method === 'calculateGroupTokens') {
      let total = 0;
      for (const t of texts ?? []) {
        total += tokenizer.encode(t).length;
      }
      parentPort?.postMessage({ id, result: total } satisfies WorkerResponse);
    }
  } catch (error) {
    parentPort?.postMessage({ id, error: (error as Error).message } satisfies WorkerResponse);
  }
});
