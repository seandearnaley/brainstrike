import { TOOL_TELEMETRY_OMITTED_TYPE } from '@brainstrike/assistant-contract/tool-telemetry';
import type { HostLogRow, HostRunTelemetry } from './protocol.js';

/**
 * The most chunk JSON, in bytes, Core keeps for a running call's replay, and
 * for the open step's text and reasoning (ADR-0011 amendment). Past it the
 * oldest chunks drop and a replay opens with an omission marker.
 */
export const HOST_TELEMETRY_REPLAY_BYTES = 512 * 1024;

interface Kept {
  readonly bytes: number;
  readonly telemetry: HostRunTelemetry;
}

/** The newest chunks of one stream within the byte bound, and what the bound dropped. */
class ReplayRing {
  private kept: Kept[] = [];
  private first = 0;
  private bytes = 0;
  private omittedBytes = 0;

  constructor(private readonly limit: number) {}

  push(telemetry: HostRunTelemetry): void {
    const bytes = Buffer.byteLength(JSON.stringify(telemetry.chunk), 'utf8');
    this.kept.push({ bytes, telemetry });
    this.bytes += bytes;
    while (this.bytes > this.limit && this.first < this.kept.length) {
      const dropped = this.kept[this.first] as Kept;
      this.first += 1;
      this.bytes -= dropped.bytes;
      this.omittedBytes += dropped.bytes;
    }
    if (this.first * 2 > this.kept.length) {
      this.kept = this.kept.slice(this.first);
      this.first = 0;
    }
  }

  replay(stream: TelemetryStream): HostRunTelemetry[] {
    const kept = this.kept.slice(this.first).map(({ telemetry }) => telemetry);
    if (this.omittedBytes === 0) {
      return kept;
    }
    const call: Readonly<Record<string, string>> =
      stream.toolCallId === undefined ? {} : { toolCallId: stream.toolCallId };
    const marker: HostRunTelemetry = {
      chunk: {
        omittedBytes: this.omittedBytes,
        resumesAt: kept[0]?.ordinal ?? stream.next,
        ...call,
        type: TOOL_TELEMETRY_OMITTED_TYPE,
      },
      runId: stream.runId,
      threadId: stream.threadId,
      ...call,
    };
    return [marker, ...kept];
  }
}

/**
 * One numbered telemetry stream: a tool call's, or a run's model text and
 * reasoning (no `toolCallId`). A ring exists while the stream is replayable.
 */
interface TelemetryStream {
  next: number;
  ring: ReplayRing | undefined;
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId: string | undefined;
}

function streamKey(runId: string, toolCallId: string | undefined): string {
  return JSON.stringify([runId, toolCallId ?? null]);
}

/**
 * Core's in-memory replay of live telemetry, never committed (ADR-0011
 * amendment). It numbers each stream's chunks and keeps a running call's
 * chunks until its `effect.finished` commits, and the open step's text and
 * reasoning from its `start-step` until its `model.step` (or a Stop's partial
 * `model.messages`) commits; `run.finished` drops the run's streams. A view that
 * subscribes late is replayed what it missed.
 */
export class HostTelemetryReplay {
  private readonly streams = new Map<string, TelemetryStream>();
  private readonly listeners = new Set<(telemetry: HostRunTelemetry) => void>();

  constructor(private readonly limit = HOST_TELEMETRY_REPLAY_BYTES) {}

  subscribe(listener: (telemetry: HostRunTelemetry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Number and keep one live chunk, then send it to the listeners. */
  publish(telemetry: HostRunTelemetry): void {
    const numbered = this.record(telemetry);
    for (const listener of this.listeners) {
      listener(numbered);
    }
  }

  /** Number one live chunk and keep it while its stream is replayable. */
  record(telemetry: HostRunTelemetry): HostRunTelemetry {
    const stream = this.stream(telemetry.runId, telemetry.threadId, telemetry.toolCallId);
    const numbered = { ...telemetry, ordinal: stream.next };
    stream.next += 1;
    stream.ring?.push(numbered);
    return numbered;
  }

  /** A committed row opens or closes the streams it settles. */
  committed({ event, threadId }: HostLogRow): void {
    if (event.type === 'effect.finished') {
      this.streams.delete(streamKey(event.runId, event.toolCallId));
    } else if (event.type === 'run.finished') {
      for (const [key, stream] of this.streams) {
        if (stream.runId === event.runId) {
          this.streams.delete(key);
        }
      }
    } else if (event.type === 'model.step' || event.type === 'model.messages') {
      const text = this.streams.get(streamKey(event.runId, undefined));
      if (text) {
        text.ring = undefined;
      }
    } else if (event.type === 'stream.chunk' && isStepStart(event.chunk)) {
      this.stream(event.runId, threadId, undefined).ring = new ReplayRing(this.limit);
    }
  }

  /** The thread's replayable streams, each opening with its omission marker when the bound dropped output. */
  replay(threadId: string): HostRunTelemetry[] {
    return [...this.streams.values()].flatMap((stream) =>
      stream.threadId === threadId && stream.ring ? stream.ring.replay(stream) : []
    );
  }

  clear(): void {
    this.listeners.clear();
    this.streams.clear();
  }

  private stream(runId: string, threadId: string, toolCallId: string | undefined): TelemetryStream {
    const key = streamKey(runId, toolCallId);
    const existing = this.streams.get(key);
    if (existing) {
      return existing;
    }
    const created: TelemetryStream = {
      next: 0,
      // A call is replayable from its first chunk; text only inside an open step.
      ring: toolCallId === undefined ? undefined : new ReplayRing(this.limit),
      runId,
      threadId,
      toolCallId,
    };
    this.streams.set(key, created);
    return created;
  }
}

function isStepStart(chunk: unknown): boolean {
  return (
    typeof chunk === 'object' &&
    chunk !== null &&
    !Array.isArray(chunk) &&
    (chunk as Record<string, unknown>)['type'] === 'start-step'
  );
}
