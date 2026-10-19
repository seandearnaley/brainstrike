import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * BST-2239 proof only. A host-side timing line on stderr and, under E2E path
 * isolation, appended synchronously to `<userData>/logs/agent-host-timing.ndjson`:
 * a packaged Windows utility's stderr never reaches the harness.
 */
export function proofTiming(msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ...fields, msg, pid: process.pid, time: new Date().toISOString() });
  process.stderr.write(`${line}\n`);
  const userData = process.env['BRAINSTRIKE_E2E_USER_DATA_DIR'];
  if (!userData) {
    return;
  }
  try {
    mkdirSync(join(userData, 'logs'), { recursive: true });
    appendFileSync(join(userData, 'logs', 'agent-host-timing.ndjson'), `${line}\n`);
  } catch (error) {
    process.stderr.write(`BST-2239 proof timing write failed: ${String(error)}\n`);
  }
}
