import { executeQuickJs } from "./quickjs-sandbox.ts";

const result = await executeQuickJs(
  `
    const task = "summarize: local-first sandbox";
    hostAnnotate(task.toUpperCase());
  `,
  {
    hostFunctions: [
      {
        name: "hostAnnotate",
        invoke: (input: string): string => `HOST[${input}]`,
      },
    ],
    memoryLimitBytes: 8 * 1024 * 1024,
    timeoutMs: 100,
  }
);

console.log(JSON.stringify(result, null, 2));
