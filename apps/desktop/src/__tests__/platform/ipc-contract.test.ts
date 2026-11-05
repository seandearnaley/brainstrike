import { refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { describe, expect, it } from 'vitest';
import {
  type Bridge,
  type Contract,
  channel,
  type Handlers,
  ipcFailure,
  ipcOk,
  pushEvent,
  rawChannel,
} from '../../platform/ipc-contract';

const contract = {
  changed: pushEvent<{ readonly watchId: string }>({ channel: 'fixture:changed' }),
  list: rawChannel<[], { readonly ok: boolean }>({ channel: 'fixture:list' }),
  writeText: channel<[text: string], void>({ channel: 'fixture:write-text' }),
} satisfies Contract;

describe('IPC contract module', () => {
  it('stamps the discriminators so the bridge and the registry can derive behaviour', () => {
    expect(contract.writeText).toMatchObject({
      channel: 'fixture:write-text',
      envelope: 'ipc-result',
      kind: 'invoke',
    });
    expect(contract.list).toMatchObject({ envelope: 'raw', kind: 'invoke' });
    expect(contract.changed).toEqual({ channel: 'fixture:changed', kind: 'push' });
  });

  it('derives the renderer bridge and the main handler map from the same contract', () => {
    // Compile-time derivation proof: assigning the wrong shape fails `tsc`.
    const handlers: Handlers<typeof contract> = {
      list: () => ({ ok: true }),
      writeText: (text) =>
        text.length > 0
          ? ipcOk(undefined)
          : ipcFailure(refusal({ category: 'input', code: 'fixture.empty', message: 'x' })),
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
    const ok: BoundaryResult<number> = ipcOk(1);
    const failed: BoundaryResult<number> = ipcFailure(
      refusal({ category: 'input', code: 'validation.bad-input', message: 'Input was bad' })
    );
    expect(ok).toEqual({ ok: true, value: 1 });
    expect(failed).toEqual({
      error: {
        category: 'input',
        code: 'validation.bad-input',
        kind: 'refusal',
        message: 'Input was bad',
      },
      ok: false,
    });
  });
});
