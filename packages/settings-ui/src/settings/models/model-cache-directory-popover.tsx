import { resolveCacheDirectorySelectionTestOverride } from '@brainstrike/app-state/automation-overrides';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import {
  Button,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useToast,
} from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

const logger = createLogger('ModelCacheDirectoryPopover');

type ToastFn = ReturnType<typeof useToast>['toast'];

function applySelectedCacheDirectory(args: {
  db: ReturnType<typeof usePGliteDatabase>;
  fetchRegistry: (db: NonNullable<ReturnType<typeof usePGliteDatabase>>) => Promise<void>;
  selectedPath: string;
  setModelCacheDir: (dir: string) => void;
  toast: ToastFn;
}): void {
  args.setModelCacheDir(args.selectedPath);
  args.toast({
    description: args.selectedPath,
    title: 'Cache directory updated',
  });
  if (args.db) {
    void args.fetchRegistry(args.db).catch((error: unknown) => {
      logger.warn('Failed to refresh model registry after cache directory change', { error });
    });
  }
}

function applyCacheDirectorySelectionTestOverride(args: {
  db: ReturnType<typeof usePGliteDatabase>;
  fetchRegistry: (db: NonNullable<ReturnType<typeof usePGliteDatabase>>) => Promise<void>;
  setModelCacheDir: (dir: string) => void;
  toast: ToastFn;
}): boolean {
  const resolution = resolveCacheDirectorySelectionTestOverride();
  if (resolution.kind === 'none') {
    return false;
  }

  switch (resolution.kind) {
    case 'unavailable':
      args.toast({
        description: 'Choose a cache directory from the desktop app.',
        title: 'Directory selection unavailable',
        variant: 'destructive',
      });
      return true;
    case 'error':
      args.toast({
        description: resolution.message,
        title: 'Directory selection failed',
        variant: 'destructive',
      });
      return true;
    case 'cancelled':
      args.toast({
        description: 'Please choose a folder to store local model files.',
        title: 'No directory selected',
        variant: 'destructive',
      });
      return true;
    case 'selected':
      applySelectedCacheDirectory({
        db: args.db,
        fetchRegistry: args.fetchRegistry,
        selectedPath: resolution.path,
        setModelCacheDir: args.setModelCacheDir,
        toast: args.toast,
      });
      return true;
    default: {
      const exhaustiveResolution: never = resolution;
      return exhaustiveResolution;
    }
  }
}

/**
 * The local model cache directory, compacted into a header button that shows
 * the current value and opens the original form (design §3.1).
 */
export function ModelCacheDirectoryPopover() {
  const db = usePGliteDatabase();
  const { fetchRegistry, modelCacheDir, setModelCacheDir } = useModelRegistryStore(
    useShallow((state) => ({
      fetchRegistry: state.fetchRegistry,
      modelCacheDir: state.modelCacheDir,
      setModelCacheDir: state.setModelCacheDir,
    }))
  );
  const { toast } = useToast();
  const [isSelectingCacheDir, setIsSelectingCacheDir] = useState<boolean>(false);

  const handleSelectCacheDir = async (): Promise<void> => {
    if (
      applyCacheDirectorySelectionTestOverride({
        db,
        fetchRegistry,
        setModelCacheDir,
        toast,
      })
    ) {
      return;
    }

    const requestDirectoryAccess = (
      window as unknown as {
        electronAPI?: {
          fileSystem?: { requestDirectoryAccess?: () => Promise<{ path?: string }> };
        };
      }
    ).electronAPI?.fileSystem?.requestDirectoryAccess;

    if (typeof requestDirectoryAccess !== 'function') {
      toast({
        description: 'Choose a cache directory from the desktop app.',
        title: 'Directory selection unavailable',
        variant: 'destructive',
      });
      return;
    }

    setIsSelectingCacheDir(true);
    try {
      let handle: { path?: string };
      try {
        handle = await requestDirectoryAccess();
      } catch (err: unknown) {
        logger.error('Failed to select cache directory', err);
        toast({
          description:
            err instanceof Error
              ? err.message
              : 'The directory picker failed without an error message.',
          title: 'Directory selection failed',
          variant: 'destructive',
        });
        return;
      }

      const selectedPath = typeof handle.path === 'string' ? handle.path : '';
      if (!selectedPath) {
        toast({
          description: 'Please choose a folder to store local model files.',
          title: 'No directory selected',
          variant: 'destructive',
        });
        return;
      }

      applySelectedCacheDirectory({
        db,
        fetchRegistry,
        selectedPath,
        setModelCacheDir,
        toast,
      });
    } finally {
      setIsSelectingCacheDir(false);
    }
  };

  // An empty value IS the system default (the form's documented meaning).
  const currentLabel = modelCacheDir || 'System default';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className="h-8 max-w-80 gap-2 px-3 text-xs"
          data-testid="model-cache-dir-trigger"
          size="sm"
          variant="outline"
        >
          <Folder aria-hidden="true" className="size-3.5" />
          {/* The space is a text node so the accessible name reads "Local cache · <dir>". */}
          <span>Local cache ·</span>{' '}
          <span className="min-w-0 truncate font-mono text-muted-foreground" title={currentLabel}>
            {currentLabel}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-2 p-3">
        <Label htmlFor="model-cache-dir">Local model cache directory</Label>
        <div className="flex gap-2">
          <Input
            className="font-mono text-xs"
            data-testid="model-cache-dir-input"
            id="model-cache-dir"
            onChange={(e) => setModelCacheDir(e.target.value)}
            placeholder="System default (Transformers.js cache)"
            value={modelCacheDir || ''}
          />
          <Button
            aria-label="Select Model Cache Directory"
            data-testid="model-cache-dir-select"
            disabled={isSelectingCacheDir}
            onClick={handleSelectCacheDir}
            size="icon"
            title="Select Directory"
            variant="outline"
          >
            <Folder className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Stored on disk for local models only. Leave blank to use the system cache directory.
        </p>
      </PopoverContent>
    </Popover>
  );
}
