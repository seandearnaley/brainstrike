/**
 * The model-provider shim's OpenRouter model-metadata route: recorded public
 * OpenRouter Models API responses, served only for a recorded fixture's exact
 * model identity.
 */
import { readFileSync } from 'node:fs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Recorded public OpenRouter Models API responses, fetched without credentials:
 * Claude Sonnet 4.6 (G1, #3543 6054095971) and GPT-5.6 Terra, one of the
 * recommended coding models a new OpenRouter key enables.
 */
const RECORDED_OPENROUTER_METADATA = [
  new URL(
    '../../src/__tests__/fixtures/openrouter-sonnet-4-6-model-metadata.json',
    import.meta.url
  ),
  new URL(
    '../../src/__tests__/fixtures/openrouter-gpt-5-6-terra-model-metadata.json',
    import.meta.url
  ),
];
let recordedMetadata: ReadonlyMap<string, Buffer> | undefined;

/** Each fixture's own `data.id` is its only identity: none is ever relabelled. */
function readRecordedMetadata(): ReadonlyMap<string, Buffer> {
  if (recordedMetadata) {
    return recordedMetadata;
  }
  const byId = new Map<string, Buffer>();
  for (const fixture of RECORDED_OPENROUTER_METADATA) {
    const body = readFileSync(fixture);
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    const id = isRecord(parsed) && isRecord(parsed['data']) ? parsed['data']['id'] : undefined;
    if (typeof id !== 'string') {
      throw new Error(
        `The recorded OpenRouter metadata fixture ${fixture.pathname} has no data.id.`
      );
    }
    byId.set(id, body);
  }
  recordedMetadata = byId;
  return recordedMetadata;
}

/**
 * The model a `GET /model/<provider>/<model>` metadata request names, through
 * the OpenRouter knob or a spec shim root; `null` when malformed, `undefined`
 * when the request is not a metadata lookup.
 */
function openRouterMetadataIdentity(
  method: string | undefined,
  knob: string | null,
  route: string
): string | null | undefined {
  const segments = route.split('/').filter(Boolean);
  if (
    method !== 'GET' ||
    segments[0] !== 'model' ||
    !(knob === null || knob === 'OPENROUTER_BASE_URL')
  ) {
    return;
  }
  if (segments.length !== 3) {
    return null;
  }
  try {
    return segments
      .slice(1)
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    // A malformed escape names no model; the caller refuses and records it.
    return null;
  }
}

/**
 * A `GET /model/<provider>/<model>` request's recorded answer: its identity and
 * body, `unrecorded` when no fixture holds that identity (or the path is
 * malformed), and undefined for any request that is not a metadata lookup.
 */
export function recordedOpenRouterMetadata(
  method: string | undefined,
  knob: string | null,
  route: string
): { readonly body: Buffer; readonly identity: string } | 'unrecorded' | undefined {
  const identity = openRouterMetadataIdentity(method, knob, route);
  if (identity === undefined) {
    return;
  }
  const body = identity === null ? undefined : readRecordedMetadata().get(identity);
  return identity && body ? { body, identity } : 'unrecorded';
}
