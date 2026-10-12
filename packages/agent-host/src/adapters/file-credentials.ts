import { isAbsolute, resolve } from 'node:path';
import type { KeyringCredentialBackend, KeyringEntryRequest } from './credential-contract.js';
import {
  readPrivateCredentialFile,
  writePrivateCredentialFile,
} from './private-credential-file.js';

export {
  readPrivateCredentialFile,
  writePrivateCredentialFile,
} from './private-credential-file.js';

interface FileCredentialRecords {
  readonly records: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly version: 1;
}

export class CredentialFileFormatError extends Error {
  readonly code = 'credential_file_malformed';
  constructor() {
    super('The configured credential file is malformed.');
    this.name = 'CredentialFileFormatError';
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function parseFileCredentialRecords(raw: string): FileCredentialRecords {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON syntax errors can quote credential bytes; preserve only the classification.
    throw new CredentialFileFormatError();
  }
  if (
    !isRecord(parsed) ||
    parsed['version'] !== 1 ||
    Object.keys(parsed).some((key) => !['records', 'secrets', 'version'].includes(key)) ||
    !isStringRecord(parsed['records']) ||
    !isStringRecord(parsed['secrets']) ||
    Object.keys(parsed['records']).some((key) => !isMcpOAuthCredentialAccount(key)) ||
    Object.keys(parsed['secrets']).some(isMcpOAuthCredentialAccount)
  ) {
    throw new CredentialFileFormatError();
  }
  return { records: parsed['records'], secrets: parsed['secrets'], version: 1 };
}

/** The shipped OAuth identity is a SHA-256 hex key, with no new account prefix. */
export function isMcpOAuthCredentialAccount(account: string): boolean {
  return /^[a-f0-9]{64}$/u.test(account);
}

/**
 * Explicit opt-in only. The credential facade serializes every file operation and
 * retains its actual completion; this backend neither caches values nor selects
 * a fallback. Existing provider keys and OAuth record hashes stay unchanged.
 */
export function createFileCredentialBackend(path: string): KeyringCredentialBackend {
  if (!isAbsolute(path)) {
    throw new TypeError('The credential file requires an explicit absolute path.');
  }
  const file = resolve(path);
  const validate = (request: Omit<KeyringEntryRequest, 'account'>): void => {
    if (request.service !== file) {
      throw new Error('Credential operation does not belong to the configured file.');
    }
  };

  const read = async (): Promise<FileCredentialRecords> => {
    const content = await readPrivateCredentialFile(file);
    return content === undefined
      ? { records: {}, secrets: {}, version: 1 }
      : parseFileCredentialRecords(content);
  };

  const write = async (records: FileCredentialRecords): Promise<void> => {
    await writePrivateCredentialFile(file, JSON.stringify(records));
  };

  const section = (account: string): 'records' | 'secrets' =>
    isMcpOAuthCredentialAccount(account) ? 'records' : 'secrets';

  return {
    async createEntry(request) {
      validate(request);
      const key = section(request.account);
      return {
        async deleteCredential() {
          const records = await read();
          if (!Object.hasOwn(records[key], request.account)) {
            return false;
          }
          const next = { ...records[key] };
          delete next[request.account];
          await write({ ...records, [key]: next });
          return true;
        },
        async getPassword() {
          const records = await read();
          return Object.hasOwn(records[key], request.account)
            ? records[key][request.account]
            : undefined;
        },
        async setPassword(value) {
          const records = await read();
          await write({ ...records, [key]: { ...records[key], [request.account]: value } });
        },
      };
    },
    async listAccounts(request) {
      validate(request);
      const records = await read();
      return [...Object.keys(records.secrets), ...Object.keys(records.records)];
    },
  };
}
