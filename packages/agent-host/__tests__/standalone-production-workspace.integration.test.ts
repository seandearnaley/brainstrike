import {
  DEFAULT_PERMISSION_POLICIES,
  deriveSkillPreferenceKey,
} from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import {
  CliWorkspaceRunInputSchema,
  materializeCliWorkspaceIntent,
  revalidateCliWorkspaceRoots,
  selectCliWorkspaceRoots,
} from '../src/standalone-workspace-input.js';

const selected = {
  instructions: 'inherit' as const,
  rootIds: ['owned-root'],
  skills: 'off' as const,
};
const firstRoot = {
  displayName: 'Owned workspace',
  path: '/owner/workspace',
  rootId: 'owned-root',
};
const ownerRoots = [
  firstRoot,
  { displayName: 'Other workspace', path: '/owner/other', rootId: 'other-owned-root' },
];
const ownerIntent = {
  enabledNativeToolIds: ['brainstrike.readWorkspaceFile', 'brainstrike.writeWorkspaceFile'],
  modelConfiguration: { model: 'gpt-6-sol', provider: 'openai' },
  permissionPolicy: {
    perToolOverrides: { 'brainstrike.writeWorkspaceFile': 'deny' },
    policies: DEFAULT_PERMISSION_POLICIES,
    yolo: false,
  },
  selectionFolderId: 'other-owned-root',
  skillsPreference: {
    disabledSkillKeys: [deriveSkillPreferenceKey({ name: 'disabled', sourceRootId: 'owned-root' })],
    masterEnabled: false,
  },
  workspaceContext: {
    files: [
      { path: 'notes.txt', rootId: 'owned-root' },
      { path: 'other.txt', rootId: 'other-owned-root' },
      { path: 'unqualified.txt' },
    ],
  },
  workspaceInstructionsPreference: {
    masterEnabled: false,
    oversizedOptInByRootId: { 'other-owned-root': true, 'owned-root': true },
  },
};

test('per-run materialization reduces owner context while preserving model and denial policy', () => {
  const materialized = materializeCliWorkspaceIntent(ownerIntent, selected);
  expect(materialized).toMatchObject({
    cliWorkspace: selected,
    enabledNativeToolIds: ownerIntent.enabledNativeToolIds,
    modelConfiguration: ownerIntent.modelConfiguration,
    permissionPolicy: ownerIntent.permissionPolicy,
    skillsPreference: ownerIntent.skillsPreference,
    workspaceContext: { files: [{ path: 'notes.txt', rootId: 'owned-root' }] },
    workspaceInstructionsPreference: {
      masterEnabled: false,
      oversizedOptInByRootId: { 'owned-root': true },
    },
  });
  expect(materialized).not.toHaveProperty('selectionFolderId');
  expect(ownerIntent.selectionFolderId).toBe('other-owned-root');
  expect(
    materializeCliWorkspaceIntent(ownerIntent, { ...selected, rootIds: [] }).workspaceContext?.files
  ).toEqual([]);
  expect(
    materializeCliWorkspaceIntent(ownerIntent, { ...selected, skills: 'inherit' }).skillsPreference
      ?.masterEnabled
  ).toBe(false);
});

test('live canonical roots authorize selection; captured observations only restrict fresh reads', () => {
  const captured = selectCliWorkspaceRoots(ownerRoots, selected);
  expect(captured).toEqual([firstRoot]);
  expect(selectCliWorkspaceRoots(ownerRoots, { ...selected, rootIds: [] })).toEqual([]);
  expect(() =>
    selectCliWorkspaceRoots(ownerRoots, { ...selected, rootIds: ['/owner/workspace'] })
  ).toThrow();
  expect(() => selectCliWorkspaceRoots([], selected)).toThrow();
  expect(() => revalidateCliWorkspaceRoots(captured, [], selected)).toThrow();
  expect(() =>
    revalidateCliWorkspaceRoots(captured, [{ ...firstRoot, path: '/replacement' }], selected)
  ).toThrow();
  expect(
    revalidateCliWorkspaceRoots(
      captured,
      [...ownerRoots, { displayName: 'New', path: '/new', rootId: 'new-root' }],
      selected
    )
  ).toEqual(captured);
  expect(() =>
    materializeCliWorkspaceIntent(
      { ...ownerIntent, cliWorkspace: selected },
      { ...selected, rootIds: ['other-owned-root'] }
    )
  ).toThrow();
});

test.each([
  'workspaceRootPath',
  'homeDir',
  'roots',
  'system',
  'modelConfiguration',
  'permissionPolicy',
  'snapshot',
])('strict envelope refuses client authority field %s', (field) => {
  expect(
    CliWorkspaceRunInputSchema.safeParse({
      kind: 'cli-workspace',
      version: 1,
      workspace: selected,
      [field]: 'untrusted',
    }).success
  ).toBe(false);
  expect(
    CliWorkspaceRunInputSchema.safeParse({
      kind: 'cli-workspace',
      version: 1,
      workspace: { ...selected, [field]: 'untrusted' },
    }).success
  ).toBe(false);
});
