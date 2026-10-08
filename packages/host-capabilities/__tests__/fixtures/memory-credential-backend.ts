import type {
  KeyringCredentialBackend,
  KeyringEntryRequest,
} from '@brainstrike/agent-host/credential-contract';

/** Disposable in-process keyring: never touches the OS credential store. */
export function memoryCredentialBackend(initial: Record<string, string> = {}): {
  readonly backend: KeyringCredentialBackend;
  readonly entries: Map<string, string>;
  readonly services: string[];
} {
  const entries = new Map(Object.entries(initial));
  const services: string[] = [];
  const backend: KeyringCredentialBackend = {
    createEntry: async (request: KeyringEntryRequest) => {
      services.push(request.service);
      return {
        deleteCredential: async () => entries.delete(request.account),
        getPassword: async () => entries.get(request.account),
        setPassword: async (value: string) => {
          entries.set(request.account, value);
        },
      };
    },
    listAccounts: async () => [...entries.keys()],
  };
  return { backend, entries, services };
}
