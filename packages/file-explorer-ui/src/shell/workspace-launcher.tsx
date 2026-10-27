import type { ReactElement } from 'react';
import { useWorkspaceTabs } from './use-workspace-tabs';

const APP_DESCRIPTIONS: Readonly<Record<string, string>> = {
  changes: 'Review agent and git changes',
  'context-explorer': 'Browse and open workspace files',
  terminal: 'Run shell commands in the workspace',
};

const CARD_CLASS_NAME =
  'flex w-40 flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none';

/**
 * The workspace empty state (BST-1262): one launcher card per REGISTERED pinned
 * app, then one per launch action (New browser tab). Registration is the
 * capability gate, so web shows only Files while desktop shows Files,
 * Changes, … — never a stubbed or disabled card. Other dynamic tabs (child
 * conversations, canvases) open from where they live.
 */
export function WorkspaceLauncher(): ReactElement {
  const { apps, launchActions, onOpenApp } = useWorkspaceTabs();

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-6 p-8"
      data-testid="workspace-launcher"
    >
      <div className="text-center">
        <p className="font-semibold text-foreground text-sm">Open a surface to get started</p>
        <p className="mt-1 text-muted-foreground text-xs">
          Workspace tabs you open will appear in the bar above.
        </p>
      </div>
      <div className="flex flex-wrap items-stretch justify-center gap-3">
        {apps.flatMap((app) => {
          if (app.placement !== 'pinned') {
            return [];
          }
          const Icon = app.icon;
          return (
            <button
              className={CARD_CLASS_NAME}
              data-testid={`workspace-launcher-open-${app.id}`}
              key={app.id}
              onClick={() => onOpenApp(app.id)}
              type="button"
            >
              <Icon className="size-8 text-primary" />
              <span className="font-medium text-foreground text-sm">{app.label}</span>
              <span className="text-muted-foreground text-xs">
                {APP_DESCRIPTIONS[app.id] ?? `Open the ${app.label} surface`}
              </span>
            </button>
          );
        })}
        {launchActions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              className={CARD_CLASS_NAME}
              data-testid={`workspace-launcher-open-${action.id}`}
              key={action.id}
              onClick={action.run}
              type="button"
            >
              <Icon className="size-8 text-primary" />
              <span className="font-medium text-foreground text-sm">{action.label}</span>
              <span className="text-muted-foreground text-xs">{action.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
