/**
 * The model-provider shim's cassette routes (docs/agents/provider-cassettes.md):
 * replaying a recorded provider cassette byte for byte, or recording one
 * through the shim. Either takes every request on every knob; the shim's
 * scripted turns are not consulted.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createProviderCassetteReplay,
  describeProviderRequestKey,
  type ProviderCassette,
  type ProviderCassetteKnob,
  type ProviderCassetteRecording,
  type ProviderCassetteReplay,
  type ProviderCassetteSubstitution,
  readBody,
} from '@brainstrike/test-utils/provider-cassette';

/**
 * Serve a recorded provider cassette: every request gets the first unserved
 * exchange recorded under its structural key, and anything else is refused
 * (`unrecorded-exchange`). `substitutions` map this run's literals (a
 * disposable workspace path) to the placeholders the recording wrote.
 */
export interface ModelProviderCassetteScript {
  readonly cassette: ProviderCassette;
  /** Recorded-time pacing (`ProviderCassetteReplayOptions.pace`); 0 by default. */
  readonly pace?: number;
  readonly substitutions?: readonly ProviderCassetteSubstitution[];
}

/**
 * Record a cassette through the shim: every request goes to its real provider
 * with the client's own credentials, and the exchange is kept in `record`.
 * Opt-in only (provider-cassette record mode); never a default.
 */
export interface ModelProviderRecordScript {
  readonly record: ProviderCassetteRecording;
}

export type CassetteRouteScript = ModelProviderCassetteScript | ModelProviderRecordScript;

export function isCassetteRouteScript(script: unknown): script is CassetteRouteScript {
  return (
    typeof script === 'object' && script !== null && ('cassette' in script || 'record' in script)
  );
}

/** A fresh replay for a cassette script (each exchange answers once), or none for any other script. */
export function cassetteReplayFor(script: unknown): ProviderCassetteReplay | undefined {
  if (!(isCassetteRouteScript(script) && 'cassette' in script)) {
    return;
  }
  return createProviderCassetteReplay(script.cassette, {
    ...(script.pace === undefined ? {} : { pace: script.pace }),
    ...(script.substitutions ? { substitutions: script.substitutions } : {}),
  });
}

/** The request's key and the keys the cassette still held, when a replay refuses it. */
export interface CassetteRouteRefusal {
  readonly key: string;
  /** Whether the refused request asked to stream. */
  readonly stream: boolean;
  readonly unserved: readonly string[];
}

/**
 * Serves one request on a cassette route. Resolves to the refusal the shim
 * answers and records, or undefined once the response was served; a failure
 * answers 502 itself.
 */
export async function serveCassetteRoute(input: {
  readonly knob: ProviderCassetteKnob;
  readonly replay: ProviderCassetteReplay | undefined;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly route: string;
  readonly script: CassetteRouteScript;
}): Promise<CassetteRouteRefusal | undefined> {
  const { knob, replay, request, response, route, script } = input;
  const method = request.method ?? 'GET';
  try {
    const rawBody = await readBody(request);
    if ('record' in script) {
      const { search } = new URL(request.url ?? '/', 'http://127.0.0.1');
      await script.record.record({ knob, method, rawBody, request, response, route, search });
      return;
    }
    if (!replay) {
      throw new Error('A cassette script has no replay.');
    }
    const refusal = await replay.serve({ knob, method, rawBody, response, route });
    return refusal
      ? {
          key: describeProviderRequestKey(refusal.key),
          stream: refusal.key.stream,
          unserved: refusal.unserved.map(describeProviderRequestKey),
        }
      : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    response.end(JSON.stringify({ error: { message, type: 'cassette_failure' } }));
    return;
  }
}
