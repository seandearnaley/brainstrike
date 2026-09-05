import { describe, expect, it } from 'vitest';
import {
  type Bridge,
  type Contract,
  channel,
  type Handlers,
  type IpcResult,
  ipcFailure,
  ipcOk,
  parseNoArgs,
  pushEvent,
  rawChannel,
} from '../../platform/ipc-contract';

function assertString(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throw new Error(message);
  }
  return value;
}

const contract = {
  changed: pushEvent<{ readonly watchId: string }>({ channel: 'fixture:changed' }),
  list: rawChannel<[], { readonly ok: boolean }>({
    channel: 'fixture:list',
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
  writeText: channel<[text: string], void>({
    channel: 'fixture:write-text',
    parseArgs: ([text]) => [assertString(text, 'fixture writeText requires a string payload')],
    roles: ['visible-ui'],
  }),
} satisfies Contract;

describe('IPC contract module', () => {
  it('stamps the discriminators so the bridge and the registry can derive behaviour', () => {
    expect(contract.writeText).toMatchObject({
      channel: 'fixture:write-text',
      envelope: 'ipc-result',
      kind: 'invoke',
      roles: ['visible-ui'],
    });
    expect(contract.list).toMatchObject({ envelope: 'raw', kind: 'invoke' });
    expect(contract.changed).toEqual({ channel: 'fixture:changed', kind: 'push' });
  });

  it('runs parseArgs as a plain function that throws on malformed input', () => {
    expect(contract.writeText.parseArgs(['hello'])).toEqual(['hello']);
    expect(() => contract.writeText.parseArgs([42])).toThrow(
      'fixture writeText requires a string payload'
    );
    expect(contract.list.parseArgs(['ignored'])).toEqual([]);
    expect(parseNoArgs()).toEqual([]);
  });

  it('derives the renderer bridge and the main handler map from the same contract', () => {
    // Compile-time derivation proof: assigning the wrong shape fails `tsc`.
    const handlers: Handlers<typeof contract> = {
      list: () => ({ ok: true }),
      writeText: (text) =>
        text.length > 0 ? ipcOk(undefined) : ipcFailure('fixture', 'empty', 'x'),
    };
    const bridge: Bridge<typeof contract> = {
      changed: () => () => {},
      list: () => Promise.resolve({ ok: true }),
      writeText: () => Promise.resolve(),
    };
    expect(Object.keys(handlers).sort()).toEqual(['list', 'writeText']);
    expect(Object.keys(bridge).sort()).toEqual(['changed', 'list', 'writeText']);
  });

  it('builds result envelopes that carry the fixed failure taxonomy', () => {
    const ok: IpcResult<number> = ipcOk(1);
    const failed: IpcResult<number> = ipcFailure('validation', 'bad_input', 'Input was bad');
    expect(ok).toEqual({ ok: true, value: 1 });
    expect(failed).toEqual({
      error: { category: 'validation', code: 'bad_input', message: 'Input was bad' },
      ok: false,
    });
  });
});
