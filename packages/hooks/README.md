# @brainstrike/hooks

This package contains reusable React hooks used across the Brainstrike project.

## Installation

```bash
# From the project root
pnpm add @brainstrike/hooks
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

### `useUndoableAction`

```tsx
import { useUndoableAction } from "@brainstrike/hooks";

function DeleteButton({ file }: { file: string }) {
  const { performUndoableAction } = useUndoableAction<string>();

  return (
    <button
      onClick={() =>
        performUndoableAction(file, file, {
          actionName: "Deleted file",
          itemDescription: file,
          onUndo: (f) => {
            // restore the file here
          },
        })
      }
    >
      Delete
    </button>
  );
}
```

## Available Hooks

- **useDebouncedValue**: Creates a debounced version of a value
- **useUndoableAction**: Allows actions to be reverted with a toast-based undo
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
