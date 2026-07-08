const API_KEY_ENV_VARS = [
  'BRAINSTRIKE_OPENAI_API_KEY',
  'BS_OPENAI_API_KEY',
  'OPENAI_API_KEY',
] as const;

type ApiKeyEnvVar = (typeof API_KEY_ENV_VARS)[number];

export interface AssistantProviderConfig {
  apiKey?: string;
  disabledReason?: 'missing_api_key';
  enabled: boolean;
  source?: ApiKeyEnvVar;
}

function readEnvVar(name: ApiKeyEnvVar): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string') {
    return;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveAssistantProviderConfig(): AssistantProviderConfig {
  for (const name of API_KEY_ENV_VARS) {
    const value = readEnvVar(name);
    if (value) {
      return { apiKey: value, enabled: true, source: name };
    }
  }
  return { disabledReason: 'missing_api_key', enabled: false };
}

export function getAssistantApiKey(): string | undefined {
  return resolveAssistantProviderConfig().apiKey;
}
