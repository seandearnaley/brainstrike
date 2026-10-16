import { NativeIndexSetupRequiredError } from '@brainstrike/assistant-service/node-native-text-services';

export { NativeIndexSetupRequiredError };

/** The shared profile resolver's setup refusal, as desktop's Search & Indexing settings surface it. */
export const desktopSetupRequired = (message: string): Error =>
  new NativeIndexSetupRequiredError(message);
