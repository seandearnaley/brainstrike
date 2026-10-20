import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Opt-in proof sidecar; canonical evidence and process ownership stay unchanged.
export function createOfficialLifecycleTrace(
  outputPath,
  runnerTemp,
  getMetadata,
  now = () => performance.now()
) {
  if (!outputPath) {
    return;
  }
  if (
    !(runnerTemp && path.isAbsolute(outputPath)) ||
    path.dirname(outputPath) !== path.resolve(runnerTemp)
  ) {
    throw new Error('Official MCP lifecycle output must be directly inside RUNNER_TEMP');
  }
  const startedAt = now();
  const events = [];
  let truncated = false;
  return {
    record(event) {
      if (events.length >= 2048) {
        truncated = true;
        return;
      }
      events.push({ ...event, atMs: Math.round((now() - startedAt) * 1000) / 1000 });
    },
    write() {
      writeFileSync(
        outputPath,
        `${JSON.stringify(
          {
            ...getMetadata(),
            events,
            runtime: {
              architecture: process.arch,
              node: process.version,
              platform: process.platform,
            },
            schemaVersion: 1,
            truncated,
          },
          null,
          2
        )}\n`,
        { mode: 0o600 }
      );
      if (truncated) {
        throw new Error('Official MCP lifecycle capture exceeded its event bound');
      }
    },
  };
}

export async function withOfficialLifecycleTrace(lifecycle, run) {
  try {
    await run();
  } catch (error) {
    try {
      lifecycle?.write();
    } catch (captureError) {
      throw new AggregateError(
        [error, captureError],
        'Official MCP conformance and lifecycle capture failed'
      );
    }
    throw error;
  }
  lifecycle?.write();
}
