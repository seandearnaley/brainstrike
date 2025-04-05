'use client';

import { FileExplorerStrings } from './constants/file-explorer-constants';

export const FileExplorerHeader: React.FC = () => {
  return (
    <header className="mb-4">
      <h1 className="text-2xl font-bold">{FileExplorerStrings.TITLE}</h1>
    </header>
  );
};
