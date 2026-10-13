import type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPresetCapability,
  ViewFilterPresetIcon,
  ViewFilterPresetRequest,
} from '@brainstrike/types';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { channel } from '../platform/ipc-contract';
import { assertArgCount, assertSupportedKeys, parseRecord } from './contract-args';

const icons: readonly ViewFilterPresetIcon[] = [
  'file',
  'file-code',
  'file-text',
  'folder',
  'folder-open',
  'code',
  'settings',
  'database',
  'box',
  'user',
  'layout',
  'globe',
  'cpu',
  'palette',
  'flask-conical',
  'test-tube',
];
function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Preset text must be a string');
  }
  return value;
}
function patterns(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Preset patterns must be an array');
  }
  return value.map(text);
}
function input(value: unknown): UpdateViewFilterPresetInput {
  const row = parseRecord(value, 'View filter preset');
  assertSupportedKeys(
    row,
    ['name', 'description', 'icon', 'includes', 'excludes', 'useRegex', 'sortOrder'],
    'View filter preset'
  );
  const result: UpdateViewFilterPresetInput = {};
  if (row['name'] !== undefined) {
    result.name = text(row['name']);
  }
  if (row['description'] !== undefined) {
    result.description = row['description'] === null ? null : text(row['description']);
  }
  if (row['includes'] !== undefined) {
    result.includes = patterns(row['includes']);
  }
  if (row['excludes'] !== undefined) {
    result.excludes = patterns(row['excludes']);
  }
  if (row['icon'] !== undefined) {
    const icon = icons.find((candidate) => candidate === row['icon']);
    if (!icon) {
      throw new Error('Unsupported preset icon');
    }
    result.icon = icon;
  }
  if (row['useRegex'] !== undefined) {
    if (typeof row['useRegex'] !== 'boolean') {
      throw new Error('Invalid regex flag');
    }
    result.useRegex = row['useRegex'];
  }
  if (row['sortOrder'] !== undefined) {
    if (typeof row['sortOrder'] !== 'number' || !Number.isSafeInteger(row['sortOrder'])) {
      throw new Error('Invalid preset order');
    }
    result.sortOrder = row['sortOrder'];
  }
  return result;
}
export function parseViewFilterPresetRequest(value: unknown): ViewFilterPresetRequest {
  const row = parseRecord(value, 'Preset request');
  if (row['operation'] === 'list') {
    assertSupportedKeys(row, ['operation'], 'Preset list');
    return { operation: 'list' };
  }
  if (row['operation'] === 'delete') {
    assertSupportedKeys(row, ['operation', 'id'], 'Preset delete');
    return { id: text(row['id']), operation: 'delete' };
  }
  if (row['operation'] === 'update') {
    assertSupportedKeys(row, ['operation', 'id', 'input'], 'Preset update');
    return { id: text(row['id']), input: input(row['input']), operation: 'update' };
  }
  if (row['operation'] !== 'create') {
    throw new Error('Unknown preset operation');
  }
  assertSupportedKeys(row, ['operation', 'input'], 'Preset create');
  const parsed = input(row['input']);
  if (
    parsed.name === undefined ||
    parsed.includes === undefined ||
    parsed.excludes === undefined ||
    parsed.description === null ||
    parsed.sortOrder !== undefined
  ) {
    throw new Error('Invalid preset creation');
  }
  const created: CreateViewFilterPresetInput = {
    excludes: parsed.excludes,
    includes: parsed.includes,
    name: parsed.name,
    ...(parsed.description === undefined ? {} : { description: parsed.description }),
    ...(parsed.icon === undefined ? {} : { icon: parsed.icon }),
    ...(parsed.useRegex === undefined ? {} : { useRegex: parsed.useRegex }),
  };
  return { input: created, operation: 'create' };
}
export const viewFilterPresetsContract = {
  request: channel<
    Parameters<ViewFilterPresetCapability['request']>,
    Awaited<ReturnType<ViewFilterPresetCapability['request']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.viewFilterPresets.request,
    parseArgs: (raw) => {
      assertArgCount(raw, 1, 'Preset request');
      return [parseViewFilterPresetRequest(raw[0])];
    },
    roles: ['visible-ui'],
  }),
};
