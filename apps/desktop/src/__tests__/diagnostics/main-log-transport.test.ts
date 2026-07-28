import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import createMainLogTransport from '../../diagnostics/main-log-transport';

describe('main log transport', () => {
  it('fails loudly when the required destination is absent', () => {
    expect(() => createMainLogTransport({})).toThrow(/destination/);
  });

  it('returns a writable destination for valid rotating options', () => {
    const transport = createMainLogTransport({
      destination: '/tmp/brainstrike.log',
      maxBytes: 1024,
      maxFiles: 3,
    });

    expect(transport).toBeInstanceOf(Writable);
  });

  it('rotates batched Pino records individually and preserves a split record', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstrike-main-log-transport-'));
    const destination = path.join(dir, 'brainstrike.log');
    const transport = createMainLogTransport({
      destination,
      maxBytes: 18,
      maxFiles: 3,
    });

    try {
      transport.write('{"msg":"one"}\n{"msg":"tw');
      transport.write('o"}\n');
      await new Promise<void>((resolve, reject) => {
        transport.once('error', reject);
        transport.end(resolve);
      });

      expect(await fs.readFile(destination, 'utf8')).toBe('{"msg":"two"}\n');
      expect(await fs.readFile(`${destination}.1`, 'utf8')).toBe('{"msg":"one"}\n');
    } finally {
      await fs.rm(dir, { force: true, recursive: true });
    }
  });
});
