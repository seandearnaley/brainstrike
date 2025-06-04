import { parentPort, workerData } from 'node:worker_threads';

let tokenizerPromise = null;
async function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = import(workerData.modulePath).catch((err) => {
      tokenizerPromise = null;
      throw err;
    });
  }
  return tokenizerPromise;
}

parentPort?.on('message', async (msg) => {
  const { id, method, text, texts } = msg;
  try {
    const tokenizer = await getTokenizer();
    if (method === 'countTokensAccurate') {
      const result = tokenizer.encode(text).length;
      parentPort?.postMessage({ id, result });
    } else if (method === 'calculateGroupTokens') {
      let total = 0;
      for (const t of texts) {
        total += tokenizer.encode(t).length;
      }
      parentPort?.postMessage({ id, result: total });
    }
  } catch (error) {
    parentPort?.postMessage({ id, error: error.message });
  }
});
