import { GEMMA4_E2B_MODEL_ID, GEMMA4_E2B_REVISION } from './local-llm.js';

export { GEMMA4_E2B_MODEL_ID, GEMMA4_E2B_REVISION } from './local-llm.js';

export interface LocalModelArtifactManifest {
  audio?: readonly string[];
  text: readonly string[];
  vision?: readonly string[];
}

export interface LocalLlmModelSpec {
  artifacts: LocalModelArtifactManifest;
  family: 'gemma4';
  modelId: string;
  quantization: 'q4f16';
  remoteRevision: string;
  requiredDevice: 'webgpu';
  supportsThinking: boolean;
  supportsTools: boolean;
  textOnly: boolean;
  totalSizeBytes: number;
}

const GEMMA4_E2B_TEXT_ARTIFACTS = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'chat_template.jinja',
  'onnx/embed_tokens_q4f16.onnx',
  'onnx/decoder_model_merged_q4f16.onnx',
] as const;

const LOCAL_LLM_MODEL_SPECS: readonly LocalLlmModelSpec[] = [
  {
    artifacts: {
      text: GEMMA4_E2B_TEXT_ARTIFACTS,
    },
    family: 'gemma4',
    modelId: GEMMA4_E2B_MODEL_ID,
    quantization: 'q4f16',
    remoteRevision: GEMMA4_E2B_REVISION,
    requiredDevice: 'webgpu',
    supportsThinking: true,
    supportsTools: true,
    textOnly: true,
    totalSizeBytes: 3900 * 1024 * 1024,
  },
];

const LOCAL_LLM_MODEL_SPEC_BY_ID = new Map(
  LOCAL_LLM_MODEL_SPECS.map((spec) => [spec.modelId, spec] as const)
);

export function listLocalLlmModelSpecs(): readonly LocalLlmModelSpec[] {
  return LOCAL_LLM_MODEL_SPECS;
}

export function getLocalLlmModelSpec(modelId: string): LocalLlmModelSpec | undefined {
  return LOCAL_LLM_MODEL_SPEC_BY_ID.get(modelId);
}
