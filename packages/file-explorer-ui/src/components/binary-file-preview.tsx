import type { ActionOutcome, AnyContextAction, TargetOf } from '@brainstrike/context-actions';
import { Badge, Button, useActionRegistry, useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { FileBox } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { type FileSurfaceTab, fileViewerToTarget } from '../context-actions/file-surface-target';

const logger = createLogger('BinaryFilePreview');

interface BinaryFilePreviewProps {
  readonly rootPath: string | null;
  readonly tab: FileSurfaceTab;
}

/**
 * Buttons are a projection of the shared context-action registry (same
 * capability gating and executors as the right-click menu): reveal, open in
 * default app, and a single copy variant — full path when the target has one,
 * otherwise relative. Web builds without fs bridges simply show fewer buttons.
 */
function pickButtonActions(
  registry: ReturnType<typeof useActionRegistry>,
  target: TargetOf<'file-viewer'> | null
): AnyContextAction[] {
  if (!target) {
    return [];
  }
  const usable = new Map<string, AnyContextAction>();
  for (const group of registry.actionsFor(target)) {
    for (const action of group.actions) {
      usable.set(action.id, action);
    }
  }
  const picked: AnyContextAction[] = [];
  const reveal = usable.get('file.reveal-in-os');
  if (reveal) {
    picked.push(reveal);
  }
  const openInDefaultApp = usable.get('file.open-in-default-app');
  if (openInDefaultApp) {
    picked.push(openInDefaultApp);
  }
  const copyPath = usable.get('file.copy-full-path') ?? usable.get('file.copy-relative-path');
  if (copyPath) {
    picked.push(copyPath);
  }
  return picked;
}

export function BinaryFilePreview({ rootPath, tab }: BinaryFilePreviewProps) {
  const registry = useActionRegistry();
  const { toast } = useToast();

  const target = useMemo(
    () =>
      fileViewerToTarget(tab, rootPath, {
        selectionText: null,
        sourceRange: null,
        viewMode: 'source',
      }),
    [rootPath, tab]
  );

  const actions = useMemo(() => pickButtonActions(registry, target), [registry, target]);

  const runAction = useCallback(
    (action: AnyContextAction) => {
      if (!target) {
        return;
      }
      const onOutcome = (outcome: ActionOutcome): void => {
        if (outcome.ok) {
          if (outcome.message) {
            toast({ description: outcome.message });
          }
          return;
        }
        logger.error('Binary preview action failed', {
          actionId: action.id,
          error: outcome.error,
        });
        toast({ description: outcome.error, title: 'Action failed', variant: 'destructive' });
      };
      // Same surfacing boundary as ActionContextMenu: a throwing/rejecting
      // action violates the ActionOutcome contract, so report it loudly.
      const onUnexpected = (error: unknown): void => {
        logger.error('Binary preview action threw', { actionId: action.id, error });
        toast({
          description: error instanceof Error ? error.message : String(error),
          title: 'Action failed unexpectedly',
          variant: 'destructive',
        });
      };
      try {
        void action.run(target, registry.services).then(onOutcome).catch(onUnexpected);
      } catch (error) {
        onUnexpected(error);
      }
    },
    [registry.services, target, toast]
  );

  const fileName = target?.name ?? tab.path.split('/').pop() ?? tab.path;
  const dotIndex = fileName.lastIndexOf('.');
  const extension = dotIndex > 0 ? fileName.slice(dotIndex + 1).toUpperCase() : null;
  const displayPath = target?.absolutePath ?? target?.relativePath ?? tab.path;

  return (
    <div
      className="flex h-full flex-col items-center justify-center p-6 text-center"
      data-testid="binary-file-preview"
    >
      <div aria-live="polite" className="sr-only">
        Binary file {fileName}. No text preview is available.
      </div>
      <div className="flex w-full max-w-md flex-col items-center">
        <div className="mb-5 flex h-20 w-20 items-center justify-center rounded-2xl border bg-muted/40">
          <FileBox aria-hidden="true" className="h-10 w-10 text-muted-foreground" />
        </div>
        <div className="flex max-w-full items-center gap-2">
          <p className="truncate font-semibold text-lg" title={fileName}>
            {fileName}
          </p>
          {extension ? <Badge variant="secondary">{extension}</Badge> : null}
        </div>
        <p
          className="mt-1 max-w-full truncate font-mono text-muted-foreground text-xs"
          title={displayPath}
        >
          {displayPath}
        </p>
        <p className="mt-4 text-muted-foreground text-sm">
          This file is stored in a binary format, so there is no text preview.
        </p>
        {target && actions.length > 0 ? (
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {actions.map((action, index) => {
              const label =
                typeof action.label === 'function' ? action.label(target) : action.label;
              const Icon = action.icon;
              return (
                <Button
                  key={action.id}
                  onClick={() => runAction(action)}
                  variant={index === 0 ? 'default' : 'outline'}
                >
                  {Icon ? <Icon className="mr-2 h-4 w-4" /> : null}
                  {label}
                </Button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
