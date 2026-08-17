import {
  GEMMA4_E2B_MODEL_ID,
  GEMMA4_E2B_REVISION,
} from '@brainstrike/assistant-contract/local-llm-model-specs';

export const HUGGING_FACE_BASE_URL = 'https://huggingface.co';

export const ALLOWED_MODEL_ID = GEMMA4_E2B_MODEL_ID;
export const ALLOWED_MODEL_REVISION = GEMMA4_E2B_REVISION;

export const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'if-modified-since',
  'if-none-match',
  'range',
] as const;

export const PASSTHROUGH_RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
] as const;
