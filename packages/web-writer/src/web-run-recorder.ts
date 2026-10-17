/**
 * Records one web run as the host's run loop does (BST-1940; ADR-0022, 16 Oct
 * amendments). The turn returns its stream parts and steps; text and reasoning
 * parts stream as live telemetry, every other part commits as `stream.chunk`,
 * each step commits as `model.step`, and `run.finished` ends the run. A Stop,
 * or the client closing, keeps the open step's partial reply, as Core keeps it.
 */

import {
  HostStepPartial,
  isModelStreamTelemetry,
} from '@brainstrike/agent-host/model-stream-telemetry';
import type { HostEvent } from '@brainstrike/agent-host/protocol';
import {
  AssistantModelStepDataSchema,
  AssistantModelStreamPartSchema,
  MODEL_STEP_DATA_NAME,
  MODEL_STREAM_PART_DATA_NAME,
} from '@brainstrike/assistant-contract/model-step';
import { z } from 'zod';
import {
  type DataStreamFrame,
  dataStreamFrames,
  type WebRunTurn,
  type WebRunTurnRequest,
} from './web-run-turn';

type Json = z.infer<ReturnType<typeof z.json>>;
type StreamPart = Parameters<typeof isModelStreamTelemetry>[0];
type Finished = Extract<HostEvent, { type: 'run.finished' }>;

/** A recorded run's seams into its host client, which is the only writer. */
export interface WebRunRecordingPorts {
  /** Commits the run's events in one append, then folds them. */
  readonly commit: (events: readonly HostEvent[]) => Promise<void>;
  readonly runId: string;
  /** Aborted by a committed Stop, from any tab, or by the client closing. */
  readonly signal: AbortSignal;
  /** A live text or reasoning part: never committed. */
  readonly telemetry: (chunk: Json) => void;
}

/** The abort of a run whose client closed: it ends interrupted, not stopped. */
export class WebRunInterrupted extends Error {
  override readonly name = 'WebRunInterrupted';
}

/** The turn's out-of-band data frame: its stream parts and steps, in the host's order. */
const DataFrameSchema = z.array(z.looseObject({ data: z.json(), name: z.string() }));

/** The proxy's refusal, bounded, as a person reads it. */
async function refusal(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).slice(0, 500);
  return `The assistant proxy refused the turn (${response.status})${text ? `: ${text}` : ''}`;
}

class WebRunRecorder {
  readonly #partial = new HostStepPartial();
  /** What the turn reported failing, as its error frame or a broken read. */
  failure: string | undefined;

  constructor(private readonly ports: WebRunRecordingPorts) {}

  async frame({ code, value }: DataStreamFrame): Promise<void> {
    if (code === '2') {
      for (const entry of DataFrameSchema.parse(value)) {
        if (entry.name === MODEL_STREAM_PART_DATA_NAME) {
          await this.#part(entry.data);
        } else if (entry.name === MODEL_STEP_DATA_NAME) {
          await this.#step(entry.data);
        }
      }
    } else if (code === '3') {
      this.failure = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }

  /** Text and reasoning stream live; every other part commits, as Core's run loop does. */
  async #part(data: Json): Promise<void> {
    AssistantModelStreamPartSchema.parse(data);
    const part = data as unknown as StreamPart;
    if (isModelStreamTelemetry(part)) {
      this.#partial.observe(part);
      this.ports.telemetry(data);
      return;
    }
    await this.ports.commit([{ chunk: data, runId: this.ports.runId, type: 'stream.chunk' }]);
  }

  async #step(data: Json): Promise<void> {
    const step = AssistantModelStepDataSchema.parse(data);
    await this.ports.commit([{ ...step, runId: this.ports.runId, type: 'model.step' }]);
    // The step's committed messages own its text from here.
    this.#partial.clear();
  }

  /** How the run ended, from what aborted it and what its turn reported. */
  #outcome(): Pick<Finished, 'detail' | 'outcome'> {
    const { signal } = this.ports;
    if (signal.aborted) {
      return signal.reason instanceof WebRunInterrupted
        ? { detail: signal.reason.message, outcome: 'interrupted' }
        : { outcome: 'stopped' };
    }
    return this.failure === undefined
      ? { outcome: 'completed' }
      : { detail: this.failure, outcome: 'failed' };
  }

  async finish(): Promise<void> {
    const { runId } = this.ports;
    const finished = this.#outcome();
    const events: HostEvent[] = [];
    // Core keeps a partial reply for a Stop or a closing host; a failed turn's never entered the transcript.
    const kept =
      finished.outcome === 'stopped' || finished.outcome === 'interrupted'
        ? this.#partial.message()
        : undefined;
    if (kept) {
      events.push({
        messages: [JSON.parse(JSON.stringify(kept)) as Json],
        runId,
        type: 'model.messages',
      });
    }
    events.push({ ...finished, runId, type: 'run.finished' });
    await this.ports.commit(events);
  }
}

export async function recordWebRun(
  turn: WebRunTurn,
  request: Omit<WebRunTurnRequest, 'signal'>,
  ports: WebRunRecordingPorts
): Promise<void> {
  const recorder = new WebRunRecorder(ports);
  try {
    const response = await turn({ ...request, signal: ports.signal });
    if (response.ok && response.body) {
      for await (const frame of dataStreamFrames(response.body)) {
        await recorder.frame(frame);
      }
    } else {
      recorder.failure = await refusal(response);
    }
  } catch (cause) {
    if (!ports.signal.aborted) {
      recorder.failure = cause instanceof Error ? cause.message : String(cause);
    }
  }
  await recorder.finish();
}
