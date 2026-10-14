# @brainstrike/hooks

Small shared React hooks. [`index.ts`](src/index.ts) owns exports including
`useDebouncedValue`, `useFileFilters` and `useLoadingManager`.

`useDebouncedValue(value, delay)` takes an explicit delay and cancels its prior
scheduled update when the value/delay changes or the component unmounts:

```tsx
import { useState } from 'react';
import { useDebouncedValue } from '@brainstrike/hooks';

export function QueryPreview() {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 300);
  return (
    <>
      <input value={query} onChange={(event) => setQuery(event.target.value)} />
      <output>{debouncedQuery}</output>
    </>
  );
}
```

Hook cleanup is scoped to its own resources; a loading flag does not own or cancel
a longer-lived host operation. Use the filter/loading hooks' actual input and
result types instead of copying package-local stores into this generic layer.

Exports, scripts and versions live in [`package.json`](package.json). Local
consumers use `workspace:*`; [shared contribution/validation policy](../../AGENTS.md)
applies.
