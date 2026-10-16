import { storedHostEvent } from '@brainstrike/agent-host/event-storage';
import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import plan from '@brainstrike/test-utils/fixtures/committed-host-plan.json' with { type: 'json' };
import rich from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import type { TestProject } from 'vitest/node';

/** Recorded committed host runs, stored as Core stores them (`storedHostEvent`), for the browser tests to append. */
export interface StoredHostCorpus {
  readonly blobs: readonly (readonly [hash: string, content: string])[];
  /** The writer's append rows, per thread in seq order: [threadId, type, runId, body, rawCount, hydrate]. */
  readonly rows: readonly (readonly [string, string, string | null, string, null, 0 | 1])[];
  readonly threadIds: readonly string[];
}

declare module 'vitest' {
  export interface ProvidedContext {
    storedHostCorpus: StoredHostCorpus;
  }
}

/**
 * Core's encoder is Node code, so the corpus is stored here, in Node, and
 * handed to the browser page.
 */
export default function setup(project: TestProject): void {
  const blobs = new Map<string, string>();
  const rows: StoredHostCorpus['rows'][number][] = [];
  for (const recorded of [rich, plan] as readonly (readonly unknown[])[]) {
    for (const input of recorded) {
      const row = HostLogRowSchema.parse(input);
      const stored = storedHostEvent(row.threadId, row.event);
      for (const blob of stored.blobs ?? []) {
        blobs.set(blob.hash, blob.content);
      }
      const runId = (stored.event as { runId?: unknown }).runId;
      rows.push([
        row.threadId,
        stored.event.type,
        typeof runId === 'string' ? runId : null,
        JSON.stringify(stored.event),
        null,
        stored.hydrate === false ? 0 : 1,
      ]);
    }
  }
  project.provide('storedHostCorpus', {
    blobs: [...blobs],
    rows,
    threadIds: [...new Set(rows.map((row) => row[0]))],
  });
}
