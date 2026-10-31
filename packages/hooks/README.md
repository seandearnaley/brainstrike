# @brainstrike/hooks

Small shared React hooks; exports are in [`index.ts`](src/index.ts).

- `useDebouncedValue(value, delay)` cancels the pending update when the value or delay changes or the component unmounts:

  ```tsx
  const debouncedQuery = useDebouncedValue(query, 300);
  ```

- `useFileFilters` and the loading hooks: use their actual input and result types; don't copy package-local stores into this generic layer.
- Hook cleanup covers only its own resources; a loading flag never owns or cancels a longer-lived host operation.
