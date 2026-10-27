import { Copy, ExternalLink, Globe } from 'lucide-react';
import type { MouseEvent, ReactElement } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { useMenuOpenReporter } from './tab-strip/use-menu-open-reporter';

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
 *
 * The menu does not open on a Ctrl-click, which macOS treats as a right
 * click, so a Ctrl-click opens the link in the default browser, as a middle
 * click does.
 */
export function LinkChoiceMenu({
  children,
  choices,
  onOpenChange,
}: {
  readonly children: ReactElement;
  readonly choices: LinkChoices;
  /** The menu can drop over a native view, which the host hides while it is open. */
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
}): ReactElement {
  const reportOpenChange = useMenuOpenReporter(onOpenChange);
  const openCtrlClickInDefaultBrowser = (event: MouseEvent): void => {
    if (event.ctrlKey) {
      choices.openInDefaultBrowser();
    }
  };
  return (
    <DropdownMenu onOpenChange={reportOpenChange}>
      <DropdownMenuTrigger asChild onClick={openCtrlClickInDefaultBrowser}>
        {children}
      </DropdownMenuTrigger>
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
