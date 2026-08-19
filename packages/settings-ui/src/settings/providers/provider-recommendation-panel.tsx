import { Button, Card, getProviderColor, ProviderIcon } from '@brainstrike/ui';
import { Sparkles } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { ProviderCardModel } from './provider-connection';

export interface ProviderRecommendationPanelProps {
  readonly onConnect: (providerId: string) => void;
  readonly providers: readonly ProviderCardModel[];
}

/**
 * First-run panel (BST-1358): with nothing connected, the page would otherwise
 * be a wall of identical "Not connected" cards. This names a short,
 * registry-priority shortlist and jumps straight to the card's credential row.
 */
export function ProviderRecommendationPanel({
  onConnect,
  providers,
}: ProviderRecommendationPanelProps) {
  if (providers.length === 0) {
    return null;
  }

  return (
    <Card className="border-primary/30 bg-primary/5 p-4" data-testid="provider-recommendations">
      <div className="flex items-start gap-3">
        <Sparkles aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h3 className="font-medium text-sm">Connect your first provider</h3>
            <p className="text-muted-foreground text-xs">
              Add a key for any provider below to start chatting. You can add more at any time.
            </p>
          </div>
          <ul className="flex flex-wrap gap-2">
            {providers.map((card) => (
              <li key={card.definition.id}>
                <Button
                  className="gap-2"
                  data-testid={`provider-recommendation-${card.definition.id}`}
                  onClick={() => onConnect(card.definition.id)}
                  size="sm"
                  variant="outline"
                >
                  <span
                    className="[--provider-color:var(--provider-color-light)] dark:[--provider-color:var(--provider-color-dark)]"
                    style={
                      {
                        '--provider-color-dark': getProviderColor(card.definition.id, 'dark'),
                        '--provider-color-light': getProviderColor(card.definition.id, 'light'),
                      } as CSSProperties
                    }
                  >
                    <ProviderIcon
                      className="size-3.5"
                      providerId={card.definition.id}
                      style={{ color: 'var(--provider-color)' }}
                    />
                  </span>
                  {card.definition.displayName}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
