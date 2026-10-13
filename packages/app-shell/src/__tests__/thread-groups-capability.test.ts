import { INTERNAL_FAULT, refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryTransport } from '@brainstrike/assistant-contract/boundary-result';
import type { ThreadGroupsCapability } from '@brainstrike/types';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createNativeThreadGroupsRepository,
  getThreadGroupsCapability,
} from '../thread-groups-capability';

afterEach(() => Reflect.deleteProperty(window, 'threadGroups'));

it('decodes committed group and root envelopes into one stable repository capability', async () => {
  const group = {
    color: null,
    icon: null,
    id: 'group-current',
    name: 'My work',
    rank: 'a0',
    resourceId: 'workspace',
  };
  const root = {
    displayName: 'Current',
    id: 'root-current',
    path: '/fixture',
    status: 'live' as const,
  };
  const transport: BoundaryTransport<ThreadGroupsCapability> = {
    readRoots: vi.fn(async () => structuredClone({ ok: true as const, value: [root] })),
    request: vi.fn(async () =>
      structuredClone({ ok: true as const, value: { groups: [group], placements: [] } })
    ),
  };
  Object.defineProperty(window, 'threadGroups', { configurable: true, value: transport });
  const capability = getThreadGroupsCapability();
  expect(capability).toBe(getThreadGroupsCapability());
  if (!capability) {
    throw new Error('Missing native group capability');
  }
  expect(await capability.readRoots()).toEqual([root]);
  expect(await createNativeThreadGroupsRepository(capability).listGroups('workspace')).toEqual([
    group,
  ]);
});

it('preserves a transported refusal and rejects an unwrapped response without fallback', async () => {
  const failure = refusal({
    category: 'availability',
    code: 'catalog.closed',
    message: 'Catalog is closed.',
    remedy: 'Reopen the app.',
  });
  const request = vi.fn().mockResolvedValue(structuredClone({ error: failure, ok: false }));
  Object.defineProperty(window, 'threadGroups', { configurable: true, value: { request } });
  const capability = getThreadGroupsCapability();
  if (!capability) {
    throw new Error('Missing native group capability');
  }
  const repository = createNativeThreadGroupsRepository(capability);
  await expect(repository.listGroups('workspace')).rejects.toMatchObject({
    code: 'catalog.closed',
    failure,
  });
  request.mockResolvedValue({ groups: [], placements: [] });
  await expect(repository.listGroups('workspace')).rejects.toMatchObject({
    failure: INTERNAL_FAULT,
  });
});
