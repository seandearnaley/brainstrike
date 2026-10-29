import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import createMainLogTransport from '../../diagnostics/main-log-transport';

async function endTransport(transport: Writable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    transport.once('error', reject);
    transport.end(resolve);
  });
}

describe('main log transport', () => {
  it('fails loudly when the required destination is absent', () => {
    expect(() => createMainLogTransport({})).toThrow(/destination/u);
  });

  it('returns a writable destination for valid rotating options', () => {
    const transport = createMainLogTransport({
      destination: '/tmp/brainstrike.log',
      maxBytes: 1024,
      maxFiles: 3,
    });

    expect(transport).toBeInstanceOf(Writable);
  });

  it('trims the required destination before opening it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstrike-main-log-transport-trim-'));
    const destination = path.join(dir, 'brainstrike.log');
    const transport = createMainLogTransport({
      destination: `  ${destination}  `,
      maxBytes: 1024,
      maxFiles: 3,
    });

    try {
      transport.write('{"msg":"trimmed"}\n');
      await endTransport(transport);

      expect(await fs.readFile(destination, 'utf8')).toBe('{"msg":"trimmed"}\n');
    } finally {
      await fs.rm(dir, { force: true, recursive: true });
    }
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
      await endTransport(transport);

      expect(await fs.readFile(destination, 'utf8')).toBe('{"msg":"two"}\n');
      expect(await fs.readFile(`${destination}.1`, 'utf8')).toBe('{"msg":"one"}\n');
    } finally {
      await fs.rm(dir, { force: true, recursive: true });
    }
  });

  it('coalesces complete records up to a rotation boundary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstrike-main-log-transport-batch-'));
    const destination = path.join(dir, 'brainstrike.log');
    const transport = createMainLogTransport({
      destination,
      maxBytes: 4096,
      maxFiles: 3,
    });
    const records = Array.from({ length: 100 }, (_, index) => `{"msg":"${index}"}\n`).join('');
    const writeSyncSpy = vi.spyOn(fsSync, 'writeSync');

    try {
      transport.write(records);
      await endTransport(transport);

      expect(await fs.readFile(destination, 'utf8')).toBe(records);
      expect(writeSyncSpy).toHaveBeenCalledTimes(1);
    } finally {
      writeSyncSpy.mockRestore();
      await fs.rm(dir, { force: true, recursive: true });
    }
  });

  it('reports a sink failure once without erroring the shared transport stream', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstrike-main-log-failure-'));
    const blockingFile = path.join(dir, 'not-a-directory');
    await fs.writeFile(blockingFile, 'blocking');
    const destination = path.join(blockingFile, 'nested', 'brainstrike.log');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const transport = createMainLogTransport({ destination });

    try {
      transport.write('{"msg":"first"}\n');
      transport.write('{"msg":"second"}\n');
      await endTransport(transport);

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[main-log-transport] rotating file sink disabled after a write failure',
        expect.anything()
      );
    } finally {
      consoleErrorSpy.mockRestore();
      await fs.rm(dir, { force: true, recursive: true });
    }
  });

  it('flushes an intentional trailing partial record at stream finalization', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstrike-main-log-partial-'));
    const destination = path.join(dir, 'brainstrike.log');
    const transport = createMainLogTransport({ destination });

    try {
      transport.write('{"msg":"partial"');
      await endTransport(transport);

      expect(await fs.readFile(destination, 'utf8')).toBe('{"msg":"partial"');
    } finally {
      await fs.rm(dir, { force: true, recursive: true });
    }
  });
});
