import { ToolInputError } from '@brainstrike/assistant-contract';
import type { SqliteCallerContext } from '@brainstrike/sqlite-query';
import type { NativeSearchAuthority } from './native-scoped-search';

interface CallerRead {
  getAuthority(): Promise<NativeSearchAuthority>;
  readonly port: { info(): Promise<{ readonly storeId: string }> };
}

export type IndexCallerRead = <T>(
  work: (context: SqliteCallerContext) => Promise<T>,
  signal?: AbortSignal
) => Promise<T>;

/** Retain the native read until the SQL process has settled and closed. */
export function createNativeCallerRead(
  withRead: <T>(work: (read: CallerRead) => Promise<T>) => Promise<T>
): IndexCallerRead {
  return (work, signal) =>
    withRead(async (read) => {
      signal?.throwIfAborted();
      const authority = await read.getAuthority();
      const { collectionId } = authority;
      if (
        authority.profile === null ||
        collectionId === null ||
        !authority.readiness.some(
          (receipt) =>
            receipt.scanComplete &&
            receipt.scope.kind === 'collection' &&
            receipt.scope.embeddingSetId === authority.collectionId
        )
      ) {
        throw new ToolInputError(
          'Caller-vector lens requires a complete current collection scan and explicitly selected vector profile.'
        );
      }
      const info = await read.port.info();
      const context: SqliteCallerContext = {
        collectionId,
        fileIds: authority.bindings
          .filter((binding) => binding.embeddingSetId === collectionId)
          .map((binding) => binding.fileId),
        profile: authority.profile,
        storeId: info.storeId,
      };
      signal?.throwIfAborted();
      const result = await work(context);
      signal?.throwIfAborted();
      if (
        JSON.stringify(await read.getAuthority()) !== JSON.stringify(authority) ||
        (await read.port.info()).storeId !== info.storeId
      ) {
        throw new ToolInputError('Native source or saved profile changed during caller query.');
      }
      return result;
    });
}
