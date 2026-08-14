import { createHash } from 'node:crypto';

const sha = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const KNOWN_INPUT_MODALITIES = new Set(['audio', 'file', 'image', 'text', 'video']);
const KNOWN_OUTPUT_MODALITIES = new Set(['audio', 'image', 'text']);
const cleanUrl = (url) => {
  const result = new URL(url);
  result.search = '';
  return result.href;
};
function evidence({ value, source, modelId, pointer, retrievedAt, authority = 'route' }) {
  return {
    authority,
    freshness: 'live',
    jsonPointer: pointer,
    rawValueSha256: sha(value),
    retrievedAt,
    sourceId: source.id,
    sourceModelId: modelId,
    sourceUrl: cleanUrl(source.url),
    value,
  };
}
function decimalPerMillion(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/u.test(value)) {
    throw new Error('invalid pricing decimal');
  }
  const [whole, fraction = ''] = value.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+/u, '') || '0';
  const scale = fraction.length - 6;
  if (scale <= 0) {
    return Number(`${digits}${'0'.repeat(-scale)}`);
  }
  const padded = digits.padStart(scale + 1, '0');
  const rendered = `${padded.slice(0, -scale)}.${padded.slice(-scale)}`
    .replace(/\.0+$/u, '')
    .replace(/(\.\d*?)0+$/u, '$1');
  return Number(rendered);
}
function normalizeOpenRouter(payload, source, retrievedAt) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    throw new Error('invalid OpenRouter payload');
  }
  const seen = new Set();
  return payload.data.map((raw, index) => {
    if (!raw || typeof raw.id !== 'string' || seen.has(raw.id)) {
      throw new Error('duplicate or invalid model ID');
    }
    seen.add(raw.id);
    if (!Number.isSafeInteger(raw.context_length) || raw.context_length <= 0) {
      throw new Error('invalid context window');
    }
    if (!Number.isSafeInteger(raw.created) || raw.created <= 0) {
      throw new Error('invalid model creation time');
    }
    const output = raw.top_provider?.max_completion_tokens;
    if (output !== null && output !== undefined && (!Number.isSafeInteger(output) || output <= 0)) {
      throw new Error('invalid output limit');
    }
    const inputs = raw.architecture?.input_modalities;
    const outputs = raw.architecture?.output_modalities;
    if (
      !Array.isArray(inputs) ||
      inputs.length === 0 ||
      inputs.some(
        (modality) => typeof modality !== 'string' || !KNOWN_INPUT_MODALITIES.has(modality)
      ) ||
      new Set(inputs).size !== inputs.length ||
      !Array.isArray(outputs) ||
      outputs.length === 0 ||
      outputs.some(
        (modality) => typeof modality !== 'string' || !KNOWN_OUTPUT_MODALITIES.has(modality)
      ) ||
      new Set(outputs).size !== outputs.length ||
      !outputs.includes('text')
    ) {
      throw new Error('unknown modality');
    }
    const promptPrice = raw.pricing?.prompt;
    const completionPrice = raw.pricing?.completion;
    const dynamicRouterPricing = promptPrice === '-1' && completionPrice === '-1';
    const floatingAlias = raw.id.startsWith('~');
    if (
      (promptPrice === '-1' || completionPrice === '-1') &&
      !(dynamicRouterPricing && raw.id.startsWith('openrouter/'))
    ) {
      throw new Error('invalid pricing decimal');
    }
    const promptPerMTok = dynamicRouterPricing ? undefined : decimalPerMillion(promptPrice);
    const completionPerMTok = dynamicRouterPricing ? undefined : decimalPerMillion(completionPrice);
    const label = `${raw.name.replace(/^[^:]+: /u, '')} (OpenRouter)`;
    const at = (value, suffix, authority) =>
      evidence({
        authority,
        modelId: raw.id,
        pointer: `/data/${index}/${suffix}`,
        retrievedAt,
        source,
        value,
      });
    return {
      fields: {
        ...(dynamicRouterPricing || floatingAlias
          ? {
              catalogEligibility: at(false, dynamicRouterPricing ? 'pricing' : 'id'),
              catalogEligibilityReason: at(
                dynamicRouterPricing ? 'dynamic router pricing sentinel' : 'floating latest alias',
                dynamicRouterPricing ? 'pricing' : 'id'
              ),
            }
          : {}),
        ...(Number.isSafeInteger(output) && output > raw.context_length
          ? { catalogLimitsConsistent: at(false, 'top_provider/max_completion_tokens') }
          : {}),
        contextWindow: at(raw.context_length, 'context_length'),
        createdAt: at(new Date(raw.created * 1000).toISOString(), 'created'),
        id: at(raw.id, 'id'),
        inputModalities: at(inputs, 'architecture/input_modalities'),
        label: at(label, 'name'),
        ...(output === null || output === undefined
          ? {}
          : { maxOutputTokens: at(output, 'top_provider/max_completion_tokens') }),
        outputModalities: at(outputs, 'architecture/output_modalities'),
        ...(dynamicRouterPricing
          ? {}
          : {
              pricing: at(
                { inputPerMTok: promptPerMTok, outputPerMTok: completionPerMTok },
                'pricing'
              ),
            }),
        supportsStreaming: evidence({
          authority: 'manifest-policy',
          modelId: raw.id,
          pointer: '/streamingPolicy',
          retrievedAt,
          source,
          value: true,
        }),
        type: at('llm', 'architecture/output_modalities'),
        vision: at(
          inputs.includes('image') ? 'supported' : 'unsupported',
          'architecture/input_modalities'
        ),
      },
      modelId: raw.id,
      providerId: source.providerId,
    };
  });
}
export async function fetchSource({ source, credential, fetchImpl, now }) {
  if (source.credential.kind !== 'none' && !credential) {
    return { sourceId: source.id, status: 'skipped_missing_secret' };
  }
  const headers = { accept: 'application/json' };
  if (source.adapter === 'openai') {
    headers.authorization = `Bearer ${credential}`;
  }
  if (source.adapter === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    headers['x-api-key'] = credential;
  }
  let url = source.url;
  if (source.adapter === 'google') {
    url = `${source.url}?key=${encodeURIComponent(credential)}`;
  }
  try {
    const response = await fetchImpl(url, { headers, method: 'GET' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const retrievedAt = now().toISOString();
    const models =
      source.adapter === 'openrouter'
        ? normalizeOpenRouter(payload, source, retrievedAt)
        : normalizePresence(payload, source, retrievedAt);
    return {
      observation: {
        exhaustive: source.catalogCompleteness === 'exhaustive',
        models,
        providerId: source.providerId,
        requestUrl: cleanUrl(source.url),
        retrievedAt,
        sourceId: source.id,
      },
      sourceId: source.id,
      status: 'success',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown source failure';
    return {
      error: credential ? message.replaceAll(credential, '[redacted]') : message,
      sourceId: source.id,
      status: 'failed',
    };
  }
}
function normalizePresence(payload, source, retrievedAt) {
  const rows = source.adapter === 'google' ? payload?.models : payload?.data;
  if (!Array.isArray(rows)) {
    throw new Error('invalid presence payload');
  }
  const seen = new Set();
  return rows.map((row, index) => {
    const id = source.adapter === 'google' ? row.name?.replace(/^models\//u, '') : row.id;
    if (typeof id !== 'string' || seen.has(id)) {
      throw new Error('duplicate or invalid model ID');
    }
    seen.add(id);
    return {
      fields: {
        id: evidence({
          authority: 'vendor',
          modelId: id,
          pointer: `/${source.adapter === 'google' ? 'models' : 'data'}/${index}/${source.adapter === 'google' ? 'name' : 'id'}`,
          retrievedAt,
          source,
          value: id,
        }),
      },
      modelId: id,
      providerId: source.providerId,
    };
  });
}
