/**
 * The standalone platform's close order: live commands are retired first, and
 * only then do MCP and the host capabilities close. A failed retirement still
 * closes both and is reported beside any later failure.
 */
import { expect, test, vi } from 'vitest';
import { closeStandaloneOwners } from '../src/standalone-close.js';

function owners() {
  const events: string[] = [];
  const retired = Promise.withResolvers<void>();
  return {
    events,
    owners: {
      commands: vi.fn(async () => {
        events.push('commands:start');
        await retired.promise;
        events.push('commands:end');
      }),
      host: { close: vi.fn(async () => void events.push('host')) },
      mcp: { close: vi.fn(async () => void events.push('mcp')) },
    },
    retired,
  };
}

test('MCP and the host close only after live commands are retired', async () => {
  const { events, owners: closing, retired } = owners();
  const closed = closeStandaloneOwners(closing);
  await vi.waitFor(() => expect(events).toEqual(['commands:start']));
  // Nothing else may start while a command is still being retired.
  await new Promise((resolve) => setImmediate(resolve));
  expect(closing.mcp.close).not.toHaveBeenCalled();
  expect(closing.host.close).not.toHaveBeenCalled();
  retired.resolve();
  await closed;
  expect(events).toEqual(['commands:start', 'commands:end', 'mcp', 'host']);
});

test('a failed retirement still closes MCP and the host, and is reported', async () => {
  const failure = new Error('Live command process retirement failed');
  const host = { close: vi.fn(async () => undefined) };
  const mcp = { close: vi.fn(async () => undefined) };
  const closed = closeStandaloneOwners({ commands: () => Promise.reject(failure), host, mcp });
  await expect(closed).rejects.toMatchObject({
    errors: [failure],
    message: 'Standalone platform close failed',
  });
  expect(mcp.close).toHaveBeenCalledTimes(1);
  expect(host.close).toHaveBeenCalledTimes(1);
});

test('retirement and host failures are both reported', async () => {
  const retirement = new Error('Live command process retirement failed');
  const credentials = new Error('Credential store close failed');
  await expect(
    closeStandaloneOwners({
      commands: () => Promise.reject(retirement),
      host: { close: () => Promise.reject(credentials) },
    })
  ).rejects.toMatchObject({ errors: [retirement, credentials] });
});
