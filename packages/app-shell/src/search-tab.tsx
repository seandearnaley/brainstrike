import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@brainstrike/ui';
import type { ReactElement } from 'react';
import { searchPanelSelectors, useSearchPanelStore } from './stores/search-panel-store';

export function SearchTab(): ReactElement {
  const [query, regex, caseSensitive, wholeWord] = useSearchPanelStore(
    searchPanelSelectors.queryAndFlags
  );
  const setQuery = useSearchPanelStore((state) => state.setQuery);
  const toggleRegex = useSearchPanelStore((state) => state.toggleRegex);
  const toggleCaseSensitive = useSearchPanelStore((state) => state.toggleCaseSensitive);
  const toggleWholeWord = useSearchPanelStore((state) => state.toggleWholeWord);

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Search</CardTitle>
        <CardDescription className="text-xs">Search and replace functionality</CardDescription>
      </CardHeader>
      <CardContent className="text-xs space-y-3">
        <div className="grid grid-cols-1 gap-2">
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="rp-search-query">
              Query
            </Label>
            <Input
              id="rp-search-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="text-xs"
              placeholder="Search..."
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1">
              <input type="checkbox" className="h-3 w-3" checked={regex} onChange={toggleRegex} />
              <span>Regex</span>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                className="h-3 w-3"
                checked={caseSensitive}
                onChange={toggleCaseSensitive}
              />
              <span>Case</span>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                className="h-3 w-3"
                checked={wholeWord}
                onChange={toggleWholeWord}
              />
              <span>Whole word</span>
            </label>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
