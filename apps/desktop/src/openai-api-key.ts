import { readProviderApiKey } from './provider-api-key';

export async function readOpenAIApiKey(): Promise<string | undefined> {
  return await readProviderApiKey('openai');
}
