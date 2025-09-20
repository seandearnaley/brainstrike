const ENV_KEYS = ['BRAINSTRIKE_OPENAI_API_KEY', 'BS_OPENAI_API_KEY', 'OPENAI_API_KEY'] as const;

function readEnvKey(): string | undefined {
  for (const key of ENV_KEYS) {
    const raw = process.env[key];
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export async function readOpenAIApiKey(): Promise<string | undefined> {
  const envKey = readEnvKey();
  if (envKey) return envKey;

  try {
    const { getSecretsService } = await import('./secrets');
    const svc = getSecretsService();
    return (await svc.getKey('openai')) || undefined;
  } catch {
    return undefined;
  }
}
