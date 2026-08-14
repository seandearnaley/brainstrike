import { readFile } from 'node:fs/promises';

const ROOT_KEYS = new Set(['schemaVersion', 'sources']);
const SOURCE_KEYS = new Set([
  'adapter',
  'catalogCompleteness',
  'credential',
  'enabled',
  'id',
  'maxObservationAgeHours',
  'providerId',
  'required',
  'safeAddition',
  'sourceKind',
  'streamingPolicy',
  'url',
]);
const ADAPTERS = new Set(['anthropic', 'google', 'openai', 'openrouter']);
const ENV = /^[A-Z][A-Z0-9_]*$/u;

function rejectUnknown(object, keys, at) {
  for (const key of Object.keys(object)) {
    if (!keys.has(key)) {
      throw new Error(`unknown key ${at}/${key}`);
    }
  }
}

export function validateSourceManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('manifest must be an object');
  }
  rejectUnknown(value, ROOT_KEYS, 'manifest');
  if (value.schemaVersion !== 1 || !Array.isArray(value.sources) || value.sources.length === 0) {
    throw new Error('invalid source manifest');
  }
  const ids = new Set();
  const tuples = new Set();
  for (const source of value.sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('invalid source');
    }
    rejectUnknown(source, SOURCE_KEYS, `source ${source.id ?? '?'}`);
    if (typeof source.id !== 'string' || ids.has(source.id)) {
      throw new Error('duplicate or invalid source ID');
    }
    ids.add(source.id);
    if (typeof source.required !== 'boolean') {
      throw new Error('source required policy must be boolean');
    }
    if (!ADAPTERS.has(source.adapter) || source.providerId !== source.adapter) {
      throw new Error('invalid provider ID or adapter');
    }
    const expectedSourceKind =
      source.adapter === 'openrouter' ? 'gateway-model-list-api' : 'vendor-model-list-api';
    if (source.sourceKind !== expectedSourceKind) {
      throw new Error('source kind does not match adapter authority');
    }
    const tuple = `${source.providerId}/${source.adapter}`;
    if (tuples.has(tuple)) {
      throw new Error('duplicate provider/adapter tuple');
    }
    tuples.add(tuple);
    if (typeof source.url !== 'string' || new URL(source.url).protocol !== 'https:') {
      throw new Error('source URL must be HTTPS');
    }
    if (
      !Number.isSafeInteger(source.maxObservationAgeHours) ||
      source.maxObservationAgeHours <= 0
    ) {
      throw new Error('invalid freshness window');
    }
    if (!['exhaustive', 'presence-only'].includes(source.catalogCompleteness)) {
      throw new Error('invalid completeness');
    }
    if (!source.credential || typeof source.credential.kind !== 'string') {
      throw new Error('invalid credential policy');
    }
    if (source.credential.kind !== 'none' && !ENV.test(source.credential.env ?? '')) {
      throw new Error('invalid credential environment variable');
    }
    if (source.safeAddition?.eligible === true && source.adapter !== 'openrouter') {
      throw new Error('safe addition adapter is not allowed');
    }
    for (const id of source.safeAddition?.approvedModelIds ?? []) {
      if (
        typeof id !== 'string' ||
        !id.includes('/') ||
        !id.startsWith(`${source.providerId === 'openrouter' ? '' : `${source.providerId}/`}`)
      ) {
        throw new Error('approved model ID has wrong provider prefix');
      }
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    sources: Object.freeze(
      [...value.sources].sort((a, b) => a.adapter.localeCompare(b.adapter)).map(Object.freeze)
    ),
  });
}

export async function loadSourceManifest(url = new URL('./source-manifest.json', import.meta.url)) {
  return validateSourceManifest(JSON.parse(await readFile(url, 'utf8')));
}
