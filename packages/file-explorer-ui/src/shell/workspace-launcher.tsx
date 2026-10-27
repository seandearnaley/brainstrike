import type { ReactElement } from 'react';
import { useWorkspaceTabs } from './use-workspace-tabs';

const APP_DESCRIPTIONS: Readonly<Record<string, string>> = {
  changes: 'Review agent and git changes',
  'context-explorer': 'Browse and open workspace files',
  terminal: 'Run shell commands in the workspace',
};

/**
 * The workspace empty state (BST-1262): one launcher card per REGISTERED pinned
 * app. Registration is the capability gate, so web shows only Files while
 * desktop shows Files, Changes, … — never a stubbed or disabled card. Dynamic
 * tabs (child conversations, canvases) open from where they live.
 */
export function WorkspaceLauncher(): ReactElement {
  const { apps, onOpenApp } = useWorkspaceTabs();

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
              className="flex w-40 flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
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
      </div>
    </div>
  );
}
