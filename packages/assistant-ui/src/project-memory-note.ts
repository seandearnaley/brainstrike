/**
 * ADR-0040: a project memory write, as the card its thread shows. A host
 * thread's committed `memory.changed` and `memory.refused` become one data
 * part per call; `memory.undone` marks that part undone.
 */
import { Predicate } from 'effect';

export const PROJECT_MEMORY_NOTE_DATA_NAME = 'brainstrike.memory-note';

export interface ProjectMemoryNote {
  /** A rename's source path. */
  readonly fromPath?: string;
  readonly path: string;
  /** Why the host did not store the note; nothing else about it was kept. */
  readonly refusal?: string;
  readonly runId: string;
  /** The note after the write; null once deleted, or when refused. */
  readonly text: string | null;
  readonly title: string;
  readonly toolCallId: string;
  /** Whether Undo has something to restore. */
  readonly undoable: boolean;
  /** Undo restored what the write replaced. */
  readonly undone: boolean;
  /** Written while the run was reading web or MCP content. */
  readonly untrusted: boolean;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** The card a committed memory write or refusal shows; undefined for any other event. */
export function committedMemoryNote(
  event: Readonly<Record<string, unknown>>
): ProjectMemoryNote | undefined {
  const { path, runId, title, toolCallId, type } = event;
  if (
    !(
      (type === 'memory.changed' || type === 'memory.refused') &&
      text(path) &&
      text(runId) &&
      text(title) &&
      text(toolCallId)
    )
  ) {
    return;
  }
  const call = { path, runId, title, toolCallId, undone: false };
  if (type === 'memory.refused') {
    if (!text(event['reason'])) {
      throw new Error('A committed memory refusal has no reason.');
    }
    return { ...call, refusal: event['reason'], text: null, undoable: false, untrusted: false };
  }
  const { fromPath, previous, untrusted } = event;
  if (
    !(
      nullableText(event['text']) &&
      nullableText(previous) &&
      typeof untrusted === 'boolean' &&
      (fromPath === undefined || text(fromPath))
    )
  ) {
    throw new Error('A committed memory write is unreadable.');
  }
  return {
    ...call,
    ...(fromPath === undefined ? {} : { fromPath }),
    text: event['text'],
    undoable: fromPath !== undefined || event['text'] !== null || previous !== null,
    untrusted,
  };
}

/** A memory note data part's payload, as the projection wrote it. */
export function readProjectMemoryNote(data: unknown): ProjectMemoryNote {
  if (
    Predicate.isObject(data) &&
    text(data['path']) &&
    text(data['title']) &&
    text(data['toolCallId']) &&
    text(data['runId']) &&
    typeof data['undone'] === 'boolean'
  ) {
    return data as unknown as ProjectMemoryNote;
  }
  throw new Error('A memory note part is unreadable.');
}

/** The data part a projection keeps for a memory note, and how an event changes it. */
interface MemoryNotePart {
  readonly data: unknown;
  readonly name: string;
  readonly type: 'data';
}

/**
 * A memory event's card part in its run: the key the call's part is kept under
 * and how the event changes it. A write or refusal sets the card; an undo
 * marks it undone. Undefined for any other event.
 */
export function committedMemoryPart(event: Readonly<Record<string, unknown>>):
  | {
      readonly key: string;
      readonly update: <P extends { readonly type: string }>(
        previous?: P
      ) => MemoryNotePart | P | undefined;
    }
  | undefined {
  const toolCallId = event['toolCallId'];
  if (event['type'] === 'memory.undone' && typeof toolCallId === 'string') {
    return {
      key: `memory:${toolCallId}`,
      update: (previous) =>
        previous?.type === 'data' && 'data' in previous
          ? { ...previous, data: { ...readProjectMemoryNote(previous.data), undone: true } }
          : undefined,
    };
  }
  const note = committedMemoryNote(event);
  return note
    ? {
        key: `memory:${note.toolCallId}`,
        update: () => ({ data: note, name: PROJECT_MEMORY_NOTE_DATA_NAME, type: 'data' }),
      }
    : undefined;
}
