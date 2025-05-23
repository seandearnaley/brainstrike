# @brainstrike/app-shell

Reusable layout components for BrainStrike applications. It provides a theme-aware app container with navigation and page wrappers.

## Installation

```bash
pnpm add @brainstrike/app-shell
```

## Usage

```tsx
import { AppLayout, createAppConfig } from "@brainstrike/app-shell";

const config = createAppConfig({
  navigationItems: [
    { title: "Home", href: "/" },
  ],
});

function MyApp({ children }: { children: React.ReactNode }) {
  return (
    <AppLayout config={config} currentPath="/">
      {children}
    </AppLayout>
  );
}
```
