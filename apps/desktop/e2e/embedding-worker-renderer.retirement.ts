import type { ElectronApplication } from 'playwright';
import { expect } from './fixtures/electron-fixture';

/** Capture the real process receipt: exit zero alone did not catch the M3 native cleanup failure. */
export function captureNativeShutdown(app: ElectronApplication): () => void {
  const process = app.process();
  let output = '';
  const append = (chunk: Buffer): void => {
    output += chunk.toString('utf8');
  };
  process.stdout?.on('data', append);
  return () => {
    process.stdout?.off('data', append);
    const reports = output.split('\n').flatMap((line) => {
      if (!line.startsWith('{')) {
        return [];
      }
      const record: unknown = JSON.parse(line);
      if (typeof record !== 'object' || record === null || !('steps' in record)) {
        return [];
      }
      return Array.isArray(record.steps) ? [record.steps] : [];
    });
    expect(process.exitCode).toBe(0);
    expect(process.signalCode).toBeNull();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ failed: false, step: 'native-index' }),
        expect.objectContaining({ failed: false, step: 'embedding-host' }),
      ])
    );
    expect(reports[0]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ failed: true })])
    );
  };
}
