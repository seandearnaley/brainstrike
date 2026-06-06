import { describe, expect, it, vi } from 'vitest';
import { composeClaimPermit } from '../embedding-worker-config';

describe('composeClaimPermit', () => {
  it('passes through non-claim labels without consulting the gate', async () => {
    const gate = { waitUntilInactive: vi.fn(async () => {}) };
    const base = vi.fn(async () => {});
    const permit = composeClaimPermit(base, gate as never);
    await permit({ label: 'embedding completion' });
    expect(base).toHaveBeenCalledTimes(1);
    expect(gate.waitUntilInactive).not.toHaveBeenCalled();
  });

  it('awaits the gate after the base permit for the claim label', async () => {
    const order: string[] = [];
    const gate = {
      waitUntilInactive: vi.fn(async () => {
        order.push('gate');
      }),
    };
    const base = vi.fn(async () => {
      order.push('base');
    });
    const permit = composeClaimPermit(base, gate as never);
    await permit({ label: 'embedding claim' });
    expect(order).toEqual(['base', 'gate']);
  });

  it('is a no-op wrapper when no gate is provided', async () => {
    const base = vi.fn(async () => {});
    const permit = composeClaimPermit(base, undefined);
    await permit({ label: 'embedding claim' });
    expect(base).toHaveBeenCalledTimes(1);
  });
});
