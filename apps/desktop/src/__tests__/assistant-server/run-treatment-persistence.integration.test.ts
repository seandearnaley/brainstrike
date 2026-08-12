/**
 * `recordDesktopRunTreatment` against a REAL PGlite (BST-1250): the insert is
 * typed correctly against the bootstrap DDL and `ON CONFLICT (run_id) DO
 * NOTHING` preserves the FIRST recorded treatment — a duplicate prompt
 * assembly for the same run must not rewrite the evidence.
 */
import { MASTRA_MEMORY_SCHEMA_SQL } from '@brainstrike/assistant-contract';
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import {
  hashSignalContent,
  recordDesktopRunTreatment,
} from '../../assistant-server/run-treatment-persistence';

describe('recordDesktopRunTreatment against real PGlite', () => {
  it('writes one typed row per run and keeps the first treatment on conflict', async () => {
    const db = await wasmLoader.createPGlite(`memory://run-treatment-real-${Date.now()}`);
    try {
      await db.exec(MASTRA_MEMORY_SCHEMA_SQL);
      // The bootstrap DDL for the treatments table lives in the assistant-data
      // repository initialization (mirroring migration 093).
      const repository = createPgliteAssistantThreadRepository(db as DbHandle);
      await repository.createThread('workspace-a');

      const provider = async () => db;
      await recordDesktopRunTreatment(
        {
          experimentId: 'search-policy-2026-08',
          resourceId: 'workspace-a',
          runId: 'run-1',
          signalContentHash: hashSignalContent('## Self-assessment signal'),
          signalInjected: true,
          threadId: 'thread-1',
          variant: 'signal-on',
        },
        provider
      );
      // Duplicate assembly for the same run: first row wins.
      await recordDesktopRunTreatment(
        {
          experimentId: null,
          resourceId: 'workspace-a',
          runId: 'run-1',
          signalContentHash: null,
          signalInjected: false,
          threadId: 'thread-1',
          variant: null,
        },
        provider
      );

      const result = await db.query(
        `SELECT run_id, thread_id, resource_id, experiment_id, variant, signal_injected, signal_content_hash
         FROM brainstrike_assistant_run_treatments`
      );
      expect(result.rows).toEqual([
        {
          experiment_id: 'search-policy-2026-08',
          resource_id: 'workspace-a',
          run_id: 'run-1',
          signal_content_hash: hashSignalContent('## Self-assessment signal'),
          signal_injected: true,
          thread_id: 'thread-1',
          variant: 'signal-on',
        },
      ]);
    } finally {
      await db.close();
    }
  });
});
