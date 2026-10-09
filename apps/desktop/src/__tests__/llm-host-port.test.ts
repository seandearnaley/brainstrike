// @vitest-environment node
import { EventEmitter } from 'node:events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { expect, test } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import {
  createRemoteLlmHostClient,
  type DesktopLlmHostInference,
  serveLlmHostPort,
} from '../agent-host-platform/llm-host-port';

/** Same public MessageEvent shape as the Electron utility port, backed by real Node ports. */
class UtilityPort extends EventEmitter implements PlatformMessagePort {
  constructor(private readonly port: MessagePort) {
    super();
    port.on('message', (data: unknown) => this.emit('message', { data }));
    port.on('close', () => this.emit('close'));
  }
  start(): void {
    this.port.start();
  }
  postMessage(message: unknown): void {
    this.port.postMessage(message);
  }
  close(): void {
    this.port.close();
  }
}

async function withPort(
  inference: DesktopLlmHostInference,
  work: (client: ReturnType<typeof createRemoteLlmHostClient>) => Promise<void>
): Promise<void> {
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const main = mainPlatformConnection(mainPort);
  const node = mainPlatformConnection(nodePort);
  const served = serveLlmHostPort(main, inference);
  const client = createRemoteLlmHostClient(node);
  main.listen();
  node.listen();
  try {
    await work(client);
  } finally {
    served.dispose();
    node.dispose();
    main.dispose();
    mainPort.close();
    nodePort.close();
  }
}

const request = {
  messages: [{ content: 'Call the tool.', role: 'user' as const }],
  modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
};

test("a typed local-model failure keeps its code across Main's port", async () => {
  await withPort(
    {
      generateForMain: async () => {
        // The shape LocalToolCallArgumentsError and the manager's request failures carry.
        throw Object.assign(
          new Error('local_tool_call_arguments_invalid: malformed JSON arguments'),
          { code: 'local_tool_call_arguments_invalid' }
        );
      },
      warmupForMain: async () => undefined,
    },
    async (client) => {
      await expect(client.generate(request)).rejects.toMatchObject({
        code: 'local_tool_call_arguments_invalid',
        message: 'local_tool_call_arguments_invalid: malformed JSON arguments',
      });
    }
  );
});

test("aborting the host's generation cancels the hidden-host request in Main", async () => {
  const started = Promise.withResolvers<void>();
  const mainSignal = Promise.withResolvers<AbortSignal>();
  await withPort(
    {
      generateForMain: async (_payload, options) => {
        const signal = options.signal;
        if (!signal) {
          throw new Error('Main received no cancellation signal');
        }
        mainSignal.resolve(signal);
        started.resolve();
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      warmupForMain: async () => undefined,
    },
    async (client) => {
      const controller = new AbortController();
      const generation = client.generate(request, { signal: controller.signal });
      await started.promise;
      controller.abort(new Error('Run stopped'));
      await expect(generation).rejects.toThrow('Run stopped');
      const signal = await mainSignal.promise;
      await expect.poll(() => signal.aborted).toBe(true);
    }
  );
});
