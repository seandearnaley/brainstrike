import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceOwner } from '@brainstrike/host-lease';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createStandaloneCliMcpFixture,
  type StandaloneCliResult,
} from './fixtures/standalone-cli-mcp-fixture';

const f = vi.hoisted(() => ({
  inspect: vi.fn(),
  processStartTime: vi.fn(),
}));
vi.mock('@brainstrike/state-store', async () => ({
  ...(await vi.importActual<typeof import('@brainstrike/state-store')>('@brainstrike/state-store')),
  processStartTime: f.processStartTime,
  RootLock: { inspect: f.inspect },
}));
const root = mkdtempSync(join(tmpdir(), 'bs-m3-cli-mcp-control-'));
const owner = {
  host: 'fixture-host',
  pid: 12_345,
  root,
  start: 'recorded-start',
  token: '11'.repeat(32),
};
const success: StandaloneCliResult = { code: 0, stderr: '', stdout: '' };

beforeEach(() => {
  vi.resetAllMocks();
  f.inspect.mockReturnValue({ gen: 1, owner });
  f.processStartTime.mockReturnValue(owner.start);
  writeFileSync(
    join(root, 'host.json'),
    JSON.stringify({
      endpoint: '/fixture/host.sock',
      hostVersion: '0.1.0',
      pid: owner.pid,
      protocolVersion: 1,
      start: owner.start,
      token: '22'.repeat(32),
    })
  );
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(root, { force: true, recursive: true }));

test('an acquired Root without host.json still reaches canonical stop and physical join', async () => {
  // Windows protocol8: startup timed out after Root acquisition, before discovery existed.
  unlinkSync(join(root, 'host.json'));
  const command = vi.fn(async () => {
    f.processStartTime.mockReturnValue(null);
    return success;
  });
  const fixture = createStandaloneCliMcpFixture(root, command);
  await fixture.close();
  expect(command).toHaveBeenCalledExactlyOnceWith(['host', 'stop']);
  expect(f.processStartTime).toHaveBeenCalledWith(owner.pid);
});

test('failed stop preserves its cause, still joins the process and releases independent resources', async () => {
  const failure = new Error('recorded stop connection refusal');
  const command = vi.fn(async () => {
    f.processStartTime.mockReturnValue(null);
    throw failure;
  });
  const fixture = createStandaloneCliMcpFixture(root, command);
  const resources = new ResourceOwner();
  const released: string[] = [];
  await resources.acquire(
    async () => 'server',
    async (value) => {
      released.push(value);
    }
  );
  await resources.acquire(
    async () => 'shim',
    async (value) => {
      released.push(value);
    }
  );
  await resources.acquire(
    async () => fixture,
    (owned) => owned.close()
  );
  await expect(resources.close()).rejects.toBe(failure);
  expect(released).toEqual(['shim', 'server']);
  expect(f.processStartTime).toHaveBeenCalledWith(owner.pid);
  expect(f.processStartTime).toHaveBeenCalledTimes(2);
});

test('cleanup fences later calls and joins the already started CLI command', async () => {
  f.inspect.mockReturnValue(null);
  const pending = Promise.withResolvers<StandaloneCliResult>();
  const command = vi.fn((args: readonly string[]) =>
    args[0] === 'run' ? pending.promise : Promise.resolve(success)
  );
  const fixture = createStandaloneCliMcpFixture(root, command);
  const running = fixture.run(['run', 'fixture prompt']);
  let closed = false;
  const closing = fixture.close().then(() => {
    closed = true;
  });
  try {
    await expect(fixture.run(['threads', 'list'])).rejects.toThrow('MCP CLI fixture is closing');
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(command).toHaveBeenCalledTimes(1);
  } finally {
    pending.resolve(success);
    await Promise.all([running, closing]);
  }
  expect(closed).toBe(true);
});
