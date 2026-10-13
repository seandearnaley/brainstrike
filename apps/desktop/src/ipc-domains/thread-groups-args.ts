import type {
  AgentSemanticColor,
  AssistantThreadGroup,
  AssistantThreadIconId,
  AssistantThreadPlacement,
  ThreadGroupsRequest,
} from '@brainstrike/types';
import { assertSupportedKeys, parseRecord } from './contract-args';

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Thread group text must be nonempty');
  }
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function color(value: unknown): AgentSemanticColor | null {
  switch (value) {
    case null:
    case 'blue':
    case 'emerald':
    case 'amber':
    case 'rose':
    case 'violet':
    case 'slate':
    case 'cyan':
    case 'lime':
    case 'orange':
    case 'fuchsia':
    case 'indigo':
    case 'red':
    case 'teal':
    case 'green':
    case 'yellow':
    case 'pink':
    case 'purple':
    case 'zinc':
      return value;
    default:
      throw new Error('Unknown thread group color');
  }
}
function icon(value: unknown): AssistantThreadIconId | null {
  switch (value) {
    case null:
    case 'message':
    case 'bug':
    case 'code':
    case 'rocket':
    case 'research':
    case 'plan':
      return value;
    default:
      throw new Error('Unknown thread group icon');
  }
}
function group(value: unknown): AssistantThreadGroup {
  const row = parseRecord(value, 'Thread group');
  assertSupportedKeys(row, ['id', 'resourceId', 'name', 'rank', 'color', 'icon'], 'Thread group');
  return {
    color: color(row['color']),
    icon: icon(row['icon']),
    id: text(row['id']),
    name: text(row['name']),
    rank: text(row['rank']),
    resourceId: text(row['resourceId']),
  };
}
function placement(value: unknown): AssistantThreadPlacement {
  const row = parseRecord(value, 'Thread placement');
  assertSupportedKeys(
    row,
    ['threadId', 'resourceId', 'groupId', 'rank', 'flatRank'],
    'Thread placement'
  );
  return {
    flatRank: nullableText(row['flatRank']),
    groupId: nullableText(row['groupId']),
    rank: text(row['rank']),
    resourceId: text(row['resourceId']),
    threadId: text(row['threadId']),
  };
}
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    throw new Error('Thread group entries must be an array');
  }
  return value.map(parse);
}
function ranked(value: unknown) {
  const row = parseRecord(value, 'Thread group rank');
  assertSupportedKeys(row, ['groupId', 'rank'], 'Thread group rank');
  return { groupId: text(row['groupId']), rank: text(row['rank']) };
}
export function parseThreadGroupsRequest(value: unknown): ThreadGroupsRequest {
  const row = parseRecord(value, 'Thread groups');
  const operation = row['operation'];
  const keys = (allowed: readonly string[]) =>
    assertSupportedKeys(row, ['operation', ...allowed], 'Thread groups');
  switch (operation) {
    case 'list':
      keys(['resourceId']);
      return { operation, resourceId: text(row['resourceId']) };
    case 'create':
      keys(['group']);
      return { group: group(row['group']), operation };
    case 'delete':
      keys(['groupId']);
      return { groupId: text(row['groupId']), operation };
    case 'rename':
      keys(['groupId', 'name']);
      return { groupId: text(row['groupId']), name: text(row['name']), operation };
    case 'color':
      keys(['groupId', 'color']);
      return { color: color(row['color']), groupId: text(row['groupId']), operation };
    case 'icon':
      keys(['groupId', 'icon']);
      return { groupId: text(row['groupId']), icon: icon(row['icon']), operation };
    case 'ranks':
      keys(['entries']);
      return { entries: array(row['entries'], ranked), operation };
    case 'placements':
      keys(['placements']);
      return { operation, placements: array(row['placements'], placement) };
    case 'clear':
      keys(['threadIds']);
      return { operation, threadIds: array(row['threadIds'], text) };
    default:
      throw new Error('Unknown thread groups operation');
  }
}
