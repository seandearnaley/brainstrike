/**
 * ADR-0040: the memory tool's execution and Undo, over the run's project
 * notes and Core's record of what each call wrote.
 */
import type { HostMemoryRecord, HostProjectMemory } from '@brainstrike/agent-host';
import { ToolInputError } from '@brainstrike/assistant-contract';
import type { MemoryInput } from '@brainstrike/assistant-contract/native-tool-schemas';
import { ProjectMemoryNotes, ProjectMemoryRefusal } from './memory-notes.ts';

/** One call's memory: the run's project notes and Core's record of the call. */
export interface ProjectMemoryPort {
  readonly notes: ProjectMemoryNotes;
  readonly record: HostMemoryRecord;
}

/**
 * Run one memory command. A write is committed as the card the thread shows;
 * a refused note is committed with why, and the model reads the refusal.
 */
export async function runProjectMemoryTool(
  input: MemoryInput,
  port: ProjectMemoryPort | undefined
): Promise<string> {
  if (!port) {
    throw new ToolInputError('Error: This thread has no project, so it has no memory.');
  }
  try {
    const result = await port.notes.execute(input, {
      untrusted: input.command !== 'view' && port.record.untrustedContext(),
    });
    if (result.change) {
      await port.record.changed(result.change);
    }
    return result.output;
  } catch (cause) {
    if (cause instanceof ProjectMemoryRefusal) {
      await port.record.refused(cause.refusal);
    }
    throw cause;
  }
}

/** The platform's project memory for Core: Undo, in the project the write named. */
export function hostProjectMemory(dataRoot: string): HostProjectMemory {
  return {
    undo: (change) => new ProjectMemoryNotes(dataRoot, change.projectId).undo(change),
  };
}
