/**
 * Who made a model, apart from the route that serves it. Claude reaches the
 * app through Anthropic's own API, through OpenRouter and through Bedrock; its
 * vendor is Anthropic on every route. Each catalog row declares its vendor
 * (`provider-catalog.json`), because a model ID's prefix is the route's naming
 * scheme, not a contract the app may read meaning from.
 */
export const MODEL_VENDOR_NAMES = {
  amazon: 'Amazon',
  anthropic: 'Anthropic',
  'bytedance-seed': 'ByteDance Seed',
  cohere: 'Cohere',
  deepseek: 'DeepSeek',
  google: 'Google',
  inclusionai: 'inclusionAI',
  kwaipilot: 'Kwaipilot',
  meituan: 'Meituan',
  meta: 'Meta',
  minimax: 'MiniMax',
  mistral: 'Mistral AI',
  moonshot: 'Moonshot AI',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  poolside: 'Poolside',
  qwen: 'Qwen',
  tencent: 'Tencent',
  'thinking-machines': 'Thinking Machines',
  upstage: 'Upstage',
  xai: 'xAI',
  xiaomi: 'Xiaomi',
  zai: 'Z.ai',
} as const;

export type ModelVendorId = keyof typeof MODEL_VENDOR_NAMES;

export const MODEL_VENDOR_IDS = Object.keys(MODEL_VENDOR_NAMES) as readonly ModelVendorId[];

/** A model's maker, as people read it. */
export interface ModelVendor {
  readonly id: ModelVendorId;
  readonly name: string;
}

export function modelVendor(id: ModelVendorId): ModelVendor {
  return { id, name: MODEL_VENDOR_NAMES[id] };
}
