export const HUGGING_FACE_BASE_URL = 'https://huggingface.co';

// Keep this pinned to the same built-in local model contract as
// packages/agent/src/providers/local/local-model-specs.ts.
export const ALLOWED_MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';

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
