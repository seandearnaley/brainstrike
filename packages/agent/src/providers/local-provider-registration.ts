import { createLocalLanguageModel } from './local';
import { registerLocalLanguageModelFactory } from './provider-factory';

export function registerBrowserLocalLanguageModelFactory(): void {
  registerLocalLanguageModelFactory(createLocalLanguageModel);
}
