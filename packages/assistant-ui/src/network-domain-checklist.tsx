import { Checkbox } from '@brainstrike/ui';
import { type ReactElement, useId } from 'react';

/** "— any host ending in .example.com" for wildcards; exact hosts need no gloss. */
function wildcardGloss(domain: string): string | null {
  return domain.startsWith('*.') ? `— any host ending in ${domain.slice(1)}` : null;
}

/**
 * run_python's requested domains (BST-1070 §3.3), each ticked by hand before
 * Allow enables. The ticks are the owner's local state, never persisted, so a
 * remount asks again. Shared by the legacy network escalation and a host
 * thread's network card.
 */
export function NetworkDomainChecklist({
  disabled,
  domains,
  onTick,
  ticked,
}: {
  readonly disabled: boolean;
  readonly domains: readonly string[];
  readonly onTick: (domain: string, checked: boolean) => void;
  readonly ticked: ReadonlySet<string>;
}): ReactElement {
  const fieldId = useId();
  return (
    <>
      <p className="text-muted-foreground mt-2 text-xs">It will be able to connect to:</p>
      <div
        className="mt-1 max-h-48 space-y-1.5 overflow-auto"
        data-testid="run-python-network-domains"
      >
        {domains.map((domain) => (
          <div className="flex items-start gap-2 text-xs" key={domain}>
            <Checkbox
              checked={ticked.has(domain)}
              data-testid={`run-python-network-domain-${domain}`}
              disabled={disabled}
              id={`${fieldId}-${domain}`}
              onCheckedChange={(checked) => onTick(domain, checked === true)}
            />
            <label className="min-w-0" htmlFor={`${fieldId}-${domain}`}>
              {/* Never truncate a domain with an ellipsis: pypi.org.evil.com
                  clipped to pypi.org… is a lie. */}
              <span className="text-foreground/90 font-mono break-all">{domain}</span>
              {wildcardGloss(domain) ? (
                <span className="text-muted-foreground ml-1">{wildcardGloss(domain)}</span>
              ) : null}
            </label>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        Nothing else. Every other address is blocked.
      </p>
      <p className="text-foreground/90 mt-1 text-xs">
        Once it can connect, it can also send data out — including anything it read from your files.
      </p>
    </>
  );
}
