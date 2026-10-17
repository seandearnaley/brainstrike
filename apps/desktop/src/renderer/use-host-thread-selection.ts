import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostRunSelection } from '@brainstrike/agent-host/protocol';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
import { useCallback, useEffect, useState } from 'react';

/** ADR-0019: a host thread's run selection as the composer reads and sets it. */
export interface HostThreadSelectionBinding {
  /** Why the selection could not be read; the composer gates its send on it. */
  readonly error?: string;
  /** The committed selection; null before any; undefined until the first read answers. */
  readonly selection: HostRunSelection | null | undefined;
  /** Commits a composer pick; resolves once the host has committed it. */
  set(modelId: string, configuration: Record<string, unknown>): Promise<void>;
}

type Read =
  | { readonly error: string; readonly threadId: string }
  | { readonly selection: HostRunSelection | null; readonly threadId: string };

const Configuration = Schema.Record(Schema.String, Schema.MutableJson);

/** The host's committed selection, read once and then followed through committed rows. */
export function useHostThreadSelection(
  client: Pick<HostClient, 'onEvent' | 'request'>,
  threadId: string
): HostThreadSelectionBinding {
  const [read, setRead] = useState<Read>();
  useEffect(() => {
    let followed = false;
    let open = true;
    const release = client.onEvent((row) => {
      if (row.threadId !== threadId || row.event.type !== 'thread.selection.updated') {
        return;
      }
      followed = true;
      const { type: _type, ...selection } = row.event;
      setRead({ selection, threadId });
    });
    client.request('thread/selection/read', { threadId }).then(
      ({ selection }) => {
        // A row committed while the read was in flight is newer than its answer.
        if (open && !followed) {
          setRead({ selection, threadId });
        }
      },
      (error: unknown) => {
        if (open) {
          setRead({ error: error instanceof Error ? error.message : String(error), threadId });
        }
      }
    );
    return () => {
      open = false;
      release();
    };
  }, [client, threadId]);
  const set = useCallback(
    async (modelId: string, configuration: Record<string, unknown>): Promise<void> => {
      const committed = {
        configuration: wireDecoder(Configuration, { errors: 'all', onExcessProperty: 'error' })(
          JSON.parse(JSON.stringify(configuration))
        ),
        modelId,
      };
      await client.request('thread/selection/set', {
        ...committed,
        commandId: crypto.randomUUID(),
        threadId,
      });
      setRead({ selection: committed, threadId });
    },
    [client, threadId]
  );
  if (read?.threadId !== threadId) {
    return { selection: undefined, set };
  }
  return 'error' in read
    ? { error: `Could not read this thread's model: ${read.error}`, selection: undefined, set }
    : { selection: read.selection, set };
}
