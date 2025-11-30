import { FileExplorerStrings } from '@brainstrike/types';

export const FileExplorerHeader: React.FC = () => (
  <header className="border-b bg-gradient-to-b from-background/60 to-background p-4">
    <h1 className="font-semibold text-xl tracking-tight">{FileExplorerStrings.title}</h1>
    <p className="mt-1 text-muted-foreground text-sm">
      Navigate and select files to include in your project
    </p>
  </header>
);
