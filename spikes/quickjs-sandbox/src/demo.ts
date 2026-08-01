import { executeQuickJs } from './quickjs-sandbox.ts';

const result = await executeQuickJs(
  `
    const task = "summarize: local-first sandbox";
    hostAnnotate(task.toUpperCase());
  `,
  {
    hostFunctions: [
      {
        invoke: (input: string): string => `HOST[${input}]`,
        name: 'hostAnnotate',
      },
    ],
    memoryLimitBytes: 8 * 1024 * 1024,
    timeoutMs: 100,
  }
);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
