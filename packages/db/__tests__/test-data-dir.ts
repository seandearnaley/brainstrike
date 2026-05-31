import { tmpdir } from 'node:os';
import path from 'node:path';

export function createPGliteTestDataDir(prefix: string): string {
  return path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
}
