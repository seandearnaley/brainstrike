import type { ChildExecutionConfiguration } from '@brainstrike/assistant-contract';
import { formatTokenCount } from '@brainstrike/tokenization';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { SlidersHorizontal } from 'lucide-react';
import type { ReactElement } from 'react';
import { capturedEffort } from './delegated-conversation-toolbar';

/** BST-1932 (F15): a host child's facts as its committed log records them. */
export interface HostChildToolbarDetails {
  /** Delegation depth: 1 for a top-level thread's own child. */
  readonly depth: number;
  /** The latest run's admitted model settings, when its configuration records them. */
  readonly execution?: ChildExecutionConfiguration;
  /** The latest run's configuration records settings that cannot be read. */
  readonly executionUnreadable?: true;
  /** The latest run's admitted step budget. */
  readonly maxSteps?: number;
  /** The latest run's `provider::model`. */
  readonly modelId: string;
  readonly planMode: boolean;
  /** The persona as it was admitted; children committed before it carry none. */
  readonly profile?: { readonly label: string; readonly mode: 'read-only' | 'worker' };
  /** Model steps the latest run has taken. */
  readonly steps: number;
  /** The latest run's admitted tools. */
  readonly tools?: readonly string[];
  /** Tokens all of this child's runs have used, as their steps reported them. */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

function AdmittedConfiguration({ details }: { readonly details: HostChildToolbarDetails }) {
  const { execution } = details;
  const separator = details.modelId.indexOf('::');
  const model = execution?.model ?? details.modelId.slice(separator + 2);
  const provider =
    execution?.provider ?? (separator > 0 ? details.modelId.slice(0, separator) : undefined);
  return (
    <div className="space-y-1">
      <p className="font-medium">Admitted child configuration</p>
      <p>{model}</p>
      {provider ? <p className="text-muted-foreground">{provider}</p> : null}
      <p>{execution ? `Effort ${capturedEffort(execution)}` : 'Effort not recorded'}</p>
      <p>{details.planMode ? 'Plan mode' : 'Agent mode'}</p>
      {execution?.modelSettings?.maxOutputTokens ? (
        <p>Up to {execution.modelSettings.maxOutputTokens.toLocaleString()} output tokens</p>
      ) : null}
      {details.maxSteps === undefined ? null : <p>Up to {details.maxSteps} steps</p>}
      <p>Level {details.depth}</p>
      <p className="text-muted-foreground">
        Current host permissions still apply. This admitted profile cannot expand them.
      </p>
      {details.tools ? (
        <details>
          <summary className="cursor-pointer">
            {details.tools.length} admitted {details.tools.length === 1 ? 'tool' : 'tools'}
          </summary>
          <ul className="mt-1 max-h-36 overflow-auto break-words text-muted-foreground">
            {details.tools.map((id) => (
              <li key={id}>{id.replace(/^brainstrike\./u, '')}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * BST-1932 (F15): a host child's toolbar. It names the persona the child was
 * admitted under and the steps its run has taken; its popover lists the
 * admitted configuration and the tokens the child has used. Every fact comes
 * from the child's committed log; nothing is read from current settings.
 */
export function HostChildToolbar({
  details,
}: {
  readonly details: HostChildToolbarDetails;
}): ReactElement {
  const { profile, usage } = details;
  if (!profile) {
    return (
      <p className="px-2 text-destructive text-xs" role="alert">
        This child’s admitted persona was not recorded.
      </p>
    );
  }
  const used = usage.inputTokens > 0 || usage.outputTokens > 0;
  return (
    <div className="flex items-center gap-2">
      {details.executionUnreadable ? (
        <p className="px-2 text-destructive text-xs" role="alert">
          Latest run settings are unavailable.
        </p>
      ) : null}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            aria-label="Child details"
            className="h-7 gap-1.5 px-2 text-xs"
            size="sm"
            variant="ghost"
          >
            <SlidersHorizontal aria-hidden="true" className="size-3.5" />
            <span>{profile.label}</span>
            <span className="text-muted-foreground">
              · {profile.mode === 'worker' ? 'Worker mode' : 'Read-only'}
            </span>
            {details.maxSteps === undefined ? null : (
              <span className="text-muted-foreground" data-testid="child-budget-usage">
                {`· steps ${details.steps}/${details.maxSteps}`}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="Child execution details"
          className="w-80 max-w-[calc(100vw-2rem)] space-y-3 text-xs"
        >
          <AdmittedConfiguration details={details} />
          <div className="space-y-1 border-t pt-2">
            <p className="font-medium">Captured usage</p>
            {used ? (
              <>
                <p>Input {formatTokenCount(usage.inputTokens)}</p>
                <p>Output {formatTokenCount(usage.outputTokens)}</p>
              </>
            ) : (
              <p>No captured usage yet</p>
            )}
            <p className="text-muted-foreground">
              This child only; its descendants are not included.
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
