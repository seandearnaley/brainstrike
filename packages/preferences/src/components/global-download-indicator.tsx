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
  if (!activeId) return null;
  const progress = downloadProgress[activeId] || 0;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-[150px]">
      <Download className="h-3 w-3 animate-pulse" />
      <span className="truncate max-w-[100px]">Downloading model...</span>
      <Progress value={progress} className="h-1.5 w-16" />
      <span className="w-8 text-right">{progress}%</span>
    </div>
  );
}
