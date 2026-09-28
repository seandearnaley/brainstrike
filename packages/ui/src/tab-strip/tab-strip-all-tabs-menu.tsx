import { ChevronDown } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '../button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { TabStatusIcon } from './tab-status';
import { resolveTabStatusText } from './tab-status-text';
import { TAB_ICON_CLASS_NAME, TAB_STRIP_ICON_BUTTON_CLASS_NAME } from './tab-strip-tokens';
import type { TabStripItem } from './types';

function AllTabsLeading({ item }: { readonly item: TabStripItem }): ReactElement | null {
  if (item.status) {
    return <TabStatusIcon status={item.status} />;
  }
  if (item.icon) {
    const Icon = item.icon;
    return <Icon className={TAB_ICON_CLASS_NAME} />;
  }
  return null;
}

function AllTabsItem({ item }: { readonly item: TabStripItem }): ReactElement {
  const statusText = resolveTabStatusText(item);
  return (
    <DropdownMenuRadioItem className="gap-2" value={item.id}>
      <AllTabsLeading item={item} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {statusText ? <span className="sr-only">{`, ${statusText}`}</span> : null}
    </DropdownMenuRadioItem>
  );
}

/**
 * The overflow affordance (BST-1836 D2): every tab, pinned first, with
 * type-ahead from Radix, plus strip-level bulk actions.
 */
export function TabStripAllTabsMenu({
  activeId,
  items,
  onActivate,
  onCloseAll,
  onOpenChange,
}: {
  readonly activeId: string | null;
  readonly items: readonly TabStripItem[];
  readonly onActivate: (id: string) => void;
  readonly onCloseAll?: (() => void) | undefined;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
}): ReactElement {
  return (
    <DropdownMenu {...(onOpenChange ? { onOpenChange } : {})}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="All tabs"
          className={TAB_STRIP_ICON_BUTTON_CLASS_NAME}
          data-testid="tab-strip-all-tabs"
          size="icon-xs"
          title="All tabs"
          type="button"
          variant="ghost"
        >
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto" sideOffset={4}>
        <DropdownMenuRadioGroup onValueChange={onActivate} value={activeId ?? ''}>
          {items.map((item) => (
            <AllTabsItem item={item} key={item.id} />
          ))}
        </DropdownMenuRadioGroup>
        {onCloseAll ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onCloseAll}>Close All</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
