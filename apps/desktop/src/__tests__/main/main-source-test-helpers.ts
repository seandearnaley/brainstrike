import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface MainSourceSections {
  readonly assistantShutdownBlock: string;
  readonly source: string;
}

export function readMainSourceSections(): MainSourceSections {
  const source = readFileSync(path.resolve(import.meta.dirname, '../../main.ts'), 'utf8');
  const shutdownStart = source.indexOf('async function runGracefulShutdown');
  if (shutdownStart < 0) {
    throw new Error('Expected main.ts to define runGracefulShutdown');
  }
  const shutdownEnd = source.indexOf("runShutdownStep('chunking-host'", shutdownStart);
  if (shutdownEnd <= shutdownStart) {
    throw new Error('Expected chunking-host to delimit the assistant shutdown block');
  }
  return {
    assistantShutdownBlock: source.slice(shutdownStart, shutdownEnd),
    source,
  };
}
