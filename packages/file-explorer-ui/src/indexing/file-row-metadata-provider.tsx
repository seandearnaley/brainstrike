/**
 * Provider half of the file-row metadata context.
 *
 * Component-only by contract — see the boundary note in
 * `file-row-metadata-context.ts`.
 */
import type { ReactNode } from 'react';
import {
  FileRowMetadataContext,
  type FileRowMetadataContextValue,
} from './file-row-metadata-context';

export function FileRowMetadataProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: FileRowMetadataContextValue;
}) {
  return (
    <FileRowMetadataContext.Provider value={value}>{children}</FileRowMetadataContext.Provider>
  );
}
