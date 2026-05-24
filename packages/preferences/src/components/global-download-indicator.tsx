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
    <div className="flex min-w-[150px] items-center gap-2 text-muted-foreground text-xs">
      <Download className="h-3 w-3 animate-pulse" />
      <span className="max-w-[100px] truncate">Downloading model...</span>
      <Progress
        aria-label="Global model download progress"
        className="h-1.5 w-16"
        value={progress}
      />
      <span className="w-8 text-right">{progress}%</span>
    </div>
  );
}
