import { Progress } from '@brainstrike/ui';
import { Download } from 'lucide-react';
import { useModelRegistryStore } from '../stores/model-registry-store';

export function GlobalDownloadIndicator() {
  const { downloadProgress, isDownloading } = useModelRegistryStore();

  // Calculate total progress or show the most active one
  // For simplicity, if any is downloading, show the one with highest progress or just the first one
  const activeDownloads = Object.entries(isDownloading)
    .filter(([_, downloading]) => downloading)
    .map(([id]) => id);

  if (activeDownloads.length === 0) {
    return null;
  }

  const activeId = activeDownloads[0];
  if (!activeId) {
    return null;
  }
  const progress = downloadProgress[activeId] || 0;

  return (
    <div className="flex h-7 w-14 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground lg:w-28 xl:w-auto">
      <Download
        aria-hidden="true"
        className="h-3 w-3 shrink-0 animate-pulse motion-reduce:animate-none"
      />
      <span className="hidden max-w-[100px] truncate whitespace-nowrap xl:block">
        Downloading model…
      </span>
      <Progress
        aria-label="Global model download progress"
        className="h-1.5 w-8 shrink-0 lg:w-12"
        value={progress}
      />
      <span className="sr-only tabular-nums lg:not-sr-only lg:w-8 lg:text-right">{progress}%</span>
    </div>
  );
}
