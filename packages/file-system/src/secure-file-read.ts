import { formatFileSize, getFileSizeConfig } from './config.js';
import { AccessError } from './errors.js';

/** Native secure-fs reads cap one operation at16MiB. */
export const NATIVE_MAX_READ_BYTES = 16 * 1024 * 1024;

export interface SecureFileReadCapability {
  readFile(
    relativePath: string,
    maxBytes: number
  ): Promise<
    | { readonly content: Uint8Array; readonly status: 'ok' }
    | { readonly status: 'not-found' | 'oversized' | 'unreadable' }
  >;
}

/** Already resolved by the mounted-root authority; this projection grants no root. */
export interface SecureFileReadResolution {
  readonly mounted: { readonly root: SecureFileReadCapability };
  readonly relativePath: string;
  readonly traversedSymlink: boolean;
}

export async function readResolvedWorkspaceFile(
  requestedPath: string,
  resolved: SecureFileReadResolution,
  maxFileBytes = getFileSizeConfig().maxFileSize
): Promise<string> {
  const { maxFileSize } = getFileSizeConfig();
  if (maxFileSize > NATIVE_MAX_READ_BYTES) {
    throw new AccessError(
      `Configured maxFileSize (${formatFileSize(maxFileSize)}) exceeds the native secure-read cap (${formatFileSize(NATIVE_MAX_READ_BYTES)}).`,
      requestedPath,
      'read'
    );
  }
  if (!(Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 && maxFileBytes <= maxFileSize)) {
    throw new AccessError(
      'Read limit must be a positive safe integer within configured maxFileSize.',
      requestedPath,
      'read'
    );
  }
  const result = await resolved.mounted.root.readFile(resolved.relativePath, maxFileBytes);
  if (result.status === 'ok') {
    return Buffer.from(result.content).toString('utf8');
  }
  if (result.status === 'oversized') {
    throw new AccessError(
      `File too large (max: ${formatFileSize(maxFileBytes)})`,
      requestedPath,
      'read'
    );
  }
  if (result.status === 'not-found') {
    throw new AccessError('ENOENT: File not found', requestedPath, 'read');
  }
  if (resolved.traversedSymlink) {
    throw new AccessError(
      'File is a symbolic link. Links are not followed inside workspace roots.',
      requestedPath,
      'read'
    );
  }
  throw new AccessError('File is not accessible.', requestedPath, 'read');
}
