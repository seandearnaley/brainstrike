/**
 * Bedrock cross-region inference-profile prefixing (BST-1350).
 *
 * The catalog stores UNPREFIXED Bedrock model ids (e.g.
 * `anthropic.claude-sonnet-5`); specific model/region combinations must be
 * invoked through a cross-region inference profile (`us.` / `eu.` / `jp.` /
 * `apac.` / `au.` / `global.` prefix). This table is ported from opencode's
 * `resolveModelID` (packages/core/src/plugin/provider/amazon-bedrock.ts) and
 * kept deliberately NARROW: ids already carrying a cross-region prefix pass
 * through untouched (never double-prefixed), and model/region pairs outside
 * the table are sent verbatim — Bedrock itself rejects an invalid invocation
 * visibly, which beats guessing a profile that may not exist.
 *
 * Unlike opencode there is NO default region here: the caller (the bedrock
 * factory case) guarantees a region, because a missing region is a typed init
 * failure — never a silent `us-east-1`.
 */

const CROSS_REGION_PREFIXES = ['global.', 'us.', 'eu.', 'jp.', 'apac.', 'au.'] as const;

const US_PREFIX_MODEL_SUBSTRINGS = [
  'nova-micro',
  'nova-lite',
  'nova-pro',
  'nova-premier',
  'nova-2',
  'claude',
  'deepseek',
] as const;

const EU_PREFIX_REGIONS = [
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-north-1',
  'eu-central-1',
  'eu-south-1',
  'eu-south-2',
] as const;

const EU_PREFIX_MODEL_SUBSTRINGS = [
  'claude',
  'nova-lite',
  'nova-micro',
  'llama3',
  'pixtral',
] as const;

const AU_REGIONS = ['ap-southeast-2', 'ap-southeast-4'] as const;

const AU_PREFIX_MODEL_SUBSTRINGS = [
  'anthropic.claude-sonnet-4-5',
  'anthropic.claude-haiku',
] as const;

const APAC_PREFIX_MODEL_SUBSTRINGS = ['claude', 'nova-lite', 'nova-micro', 'nova-pro'] as const;

export function resolveBedrockModelId(modelId: string, region: string): string {
  if (CROSS_REGION_PREFIXES.some((prefix) => modelId.startsWith(prefix))) {
    return modelId;
  }

  const regionPrefix = region.split('-')[0];
  if (regionPrefix === 'us') {
    const requiresPrefix = US_PREFIX_MODEL_SUBSTRINGS.some((item) => modelId.includes(item));
    if (requiresPrefix && !region.startsWith('us-gov')) {
      return `us.${modelId}`;
    }
    return modelId;
  }

  if (regionPrefix === 'eu') {
    const regionRequiresPrefix = EU_PREFIX_REGIONS.some((item) => region.includes(item));
    const modelRequiresPrefix = EU_PREFIX_MODEL_SUBSTRINGS.some((item) => modelId.includes(item));
    return regionRequiresPrefix && modelRequiresPrefix ? `eu.${modelId}` : modelId;
  }

  if (regionPrefix !== 'ap') {
    return modelId;
  }

  const australia = AU_REGIONS.some((item) => item === region);
  if (australia && AU_PREFIX_MODEL_SUBSTRINGS.some((item) => modelId.includes(item))) {
    return `au.${modelId}`;
  }

  const prefix = region === 'ap-northeast-1' ? 'jp' : 'apac';
  return APAC_PREFIX_MODEL_SUBSTRINGS.some((item) => modelId.includes(item))
    ? `${prefix}.${modelId}`
    : modelId;
}
