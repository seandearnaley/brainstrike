import { Search } from 'lucide-react';
import type { ReactElement } from 'react';

const SETTINGS_SEARCH_ICON_LEFT_INSET = '0.75rem';

export function SettingsSearchIcon(): ReactElement {
  return (
    <Search
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      data-slot="settings-search-icon"
      style={{ left: SETTINGS_SEARCH_ICON_LEFT_INSET }}
    />
  );
}
