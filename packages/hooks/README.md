# @brainstrike/hooks

This package contains reusable React hooks used across the Brainstrike project.

## Installation

Link the hooks package through pnpm workspaces rather than the public registry.

```bash
# Add to a specific workspace (example: apps/web)
pnpm add @brainstrike/hooks --filter @brainstrike/web

# Or declare it manually inside the target package.json
"dependencies": {
  "@brainstrike/hooks": "workspace:*"
}
```

## Usage

```tsx
import { useDebouncedValue } from "@brainstrike/hooks";

function MyComponent() {
  const [value, setValue] = useState("");
  // Value will only update after 300ms of no changes
  const debouncedValue = useDebouncedValue(value, 300);

  return (
    <div>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <p>Debounced value: {debouncedValue}</p>
    </div>
  );
}
```

## Available Hooks

- **useDebouncedValue**: Creates a debounced version of a value
- **useQuickFilter**: Filters a tree of IFileNode with debounced include/exclude search
- **useFileFilters**: Applies include or exclude filters to a file tree using globs or regex
- **useLoadingManager**: Manages asynchronous loading state for a collection of keys

## Development

```bash
# Build the package
pnpm run build

# Run in watch mode during development
pnpm run dev

# Run tests
pnpm run test
```
