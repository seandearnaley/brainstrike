import { Copy, ExternalLink, Globe } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';

/** Where a web link can go when the app has a browser of its own. */
export interface LinkChoices {
  readonly copyLink: () => void;
  readonly openInAppBrowser: () => void;
  readonly openInDefaultBrowser: () => void;
}

/**
 * Asks where to open a web link: Brainstrike's own browser, the default
 * browser, or the clipboard. `children` is the link itself, which stays a
 * real anchor so it keeps its focus order and hover preview; activating it
 * opens the menu, and the anchor must prevent its own navigation.
 */
export function LinkChoiceMenu({
  children,
  choices,
}: {
  readonly children: ReactElement;
  readonly choices: LinkChoices;
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={choices.openInAppBrowser}>
          <Globe aria-hidden="true" />
          Open in Brainstrike browser
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={choices.openInDefaultBrowser}>
          <ExternalLink aria-hidden="true" />
          Open in default browser
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={choices.copyLink}>
          <Copy aria-hidden="true" />
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
