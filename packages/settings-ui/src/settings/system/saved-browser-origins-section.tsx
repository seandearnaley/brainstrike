/**
 * BST-1178: the sites a person answered Always allow or Don't allow for when
 * the agent opened them in its own browser tab. The desktop's agent host owns
 * the saved answers; this section lists them and removes one, so the next
 * visit asks again.
 */
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@brainstrike/ui';
import { type ReactElement, useEffect, useState } from 'react';

/** The host's saved answer for each origin. */
export type SavedBrowserOriginAnswers = Readonly<Record<string, 'allow' | 'deny'>>;

/** The saved origin answers, read and removed through their owner. */
export interface SavedBrowserOrigins {
  read(): Promise<SavedBrowserOriginAnswers>;
  remove(origin: string): Promise<void>;
}

type Listing =
  | { readonly status: 'loading' }
  | { readonly error: string; readonly status: 'failed' }
  | { readonly answers: SavedBrowserOriginAnswers; readonly status: 'ready' };

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function SavedBrowserOriginsSection({
  origins,
}: {
  readonly origins: SavedBrowserOrigins;
}): ReactElement {
  const [listing, setListing] = useState<Listing>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const [removing, setRemoving] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();
  // `revision` rereads: a retry or a removal bumps it.
  useEffect(() => {
    let current = true;
    origins.read().then(
      (answers) => {
        if (current) {
          setListing({ answers, status: 'ready' });
        }
      },
      (cause: unknown) => {
        if (current) {
          setListing({ error: message(cause), status: 'failed' });
        }
      }
    );
    return () => {
      current = false;
    };
  }, [origins, revision]);
  const reload = (): void => {
    setListing({ status: 'loading' });
    setRevision((value) => value + 1);
  };
  const remove = async (origin: string): Promise<void> => {
    setRemoving(origin);
    setRemoveError(undefined);
    try {
      await origins.remove(origin);
      setRevision((value) => value + 1);
    } catch (cause) {
      setRemoveError(`Couldn't remove ${origin}: ${message(cause)}`);
    } finally {
      setRemoving(undefined);
    }
  };
  const entries =
    listing.status === 'ready'
      ? Object.entries(listing.answers).sort(([a], [b]) => a.localeCompare(b))
      : [];

  return (
    <Card data-testid="saved-browser-origins">
      <CardHeader>
        <CardTitle>Sites the agent may open</CardTitle>
        <CardDescription>
          The first time the agent opens a site in its own browser tab, it asks you. Always allow
          and Don't allow are saved here, whatever the policy above; remove one to be asked again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {listing.status === 'loading' ? <p role="status">Loading saved sites…</p> : null}
        {listing.status === 'failed' ? (
          <>
            <p role="alert">Unable to load saved sites: {listing.error}</p>
            <Button onClick={reload} size="sm" variant="outline">
              Retry
            </Button>
          </>
        ) : null}
        {listing.status === 'ready' && entries.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="saved-browser-origins-empty">
            No site has a saved answer.
          </p>
        ) : null}
        {entries.length > 0 ? (
          <ul aria-label="Saved sites" className="space-y-2">
            {entries.map(([origin, answer]) => (
              <li
                className="flex items-center justify-between gap-4 rounded-md border p-3"
                data-testid={`saved-browser-origin-${origin}`}
                key={origin}
              >
                <p className="min-w-0 break-all font-mono text-xs">{origin}</p>
                <div className="flex items-center gap-2">
                  <Badge variant={answer === 'allow' ? 'default' : 'secondary'}>
                    {answer === 'allow' ? 'Always allowed' : 'Not allowed'}
                  </Badge>
                  <Button
                    aria-label={`Remove ${origin}`}
                    disabled={removing !== undefined}
                    onClick={() => void remove(origin)}
                    size="sm"
                    variant="outline"
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {removeError === undefined ? null : <p role="alert">{removeError}</p>}
      </CardContent>
    </Card>
  );
}
