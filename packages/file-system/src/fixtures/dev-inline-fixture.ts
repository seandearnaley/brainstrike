import type { FixtureDefinition } from '../dev-fixture-types';

/**
 * Default inline fixture used by the Developer: Inline Fixtures toggle.
 *
 * Simulates a realistic TypeScript monorepo (apps + packages) so engineers
 * can exercise the full file explorer without touching the host file system.
 * Includes ~40 files across ~15 directories to stress-test tree rendering,
 * filtering, lazy-loading, and selection features.
 */
export const DEV_INLINE_FIXTURE: FixtureDefinition = {
  name: 'mock-project',
  // Durable identity so file selections (persisted per-rootId in
  // folderStates[rootId]) survive a cold page reload. Without it, a fresh
  // adapter mints a new crypto.randomUUID() per boot; the resurrection reload
  // then switches currentFolderId to the new id, orphaning the persisted
  // selection. This is a one-time constant generated with crypto.randomUUID()
  // — never derived from `name`, matching the RootId invariant.
  rootId: 'f1e2d3c4-b5a6-4789-8abc-0123456789ab',
  tree: {
    apps: {
      web: {
        'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mock App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
        'package.json': `{
  "name": "@mock/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "19.0.0",
    "react-dom": "19.0.0",
    "react-router-dom": "7.0.0"
  },
  "devDependencies": {
    "typescript": "5.4.0",
    "vite": "6.0.0",
    "vitest": "2.1.0"
  }
}
`,
        src: {
          'App.tsx': `import { Route, Routes } from "react-router-dom";
import { Navbar } from "./components/Navbar";
import { Dashboard } from "./pages/Dashboard";
import { Home } from "./pages/Home";
import { Settings } from "./pages/Settings";

export default function App() {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="container mx-auto px-4 py-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
`,
          components: {
            'Button.tsx': `import type { ButtonHTMLAttributes } from "react";
import { cn } from "@mock/utils";

type Variant = "primary" | "secondary" | "destructive" | "ghost";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantStyles: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  ghost: "hover:bg-accent hover:text-accent-foreground",
};

const sizeStyles: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        variantStyles[variant],
        sizeStyles[size],
        className
      )}
      {...props}
    />
  );
}
`,
            'Input.tsx': `import type { InputHTMLAttributes } from "react";
import { cn } from "@mock/utils";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, className, id, ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
      )}
      <input
        id={id}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2",
          "text-sm ring-offset-background placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          error && "border-destructive",
          className
        )}
        {...props}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
`,
            'Modal.tsx': `import { useEffect, useRef } from "react";
import { cn } from "@mock/utils";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, className }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      dialog.showModal();
    } else {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className={cn(
        "rounded-lg border bg-background shadow-lg backdrop:bg-black/50",
        "w-full max-w-md p-6",
        className
      )}
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <button
          onClick={onClose}
          aria-label="Close modal"
          className="rounded-sm opacity-70 hover:opacity-100"
        >
          ✕
        </button>
      </div>
      {children}
    </dialog>
  );
}
`,
            'Navbar.tsx': `import { Link, useLocation } from "react-router-dom";
import { cn } from "@mock/utils";

const links = [
  { href: "/", label: "Home" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/settings", label: "Settings" },
];

export function Navbar() {
  const { pathname } = useLocation();
  return (
    <nav className="border-b bg-background/95 backdrop-blur">
      <div className="container mx-auto flex h-14 items-center gap-6 px-4">
        <span className="font-bold">Mock App</span>
        <div className="flex gap-4">
          {links.map(({ href, label }) => (
            <Link
              key={href}
              to={href}
              className={cn(
                "text-sm transition-colors hover:text-foreground",
                pathname === href ? "text-foreground font-medium" : "text-muted-foreground"
              )}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
`,
          },
          hooks: {
            'useAuth.ts': `import { useState, useCallback } from "react";
import type { User } from "@mock/types";
import { useAppStore } from "../stores/useAppStore";

interface UseAuthReturn {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

export function useAuth(): UseAuthReturn {
  const [isLoading, setIsLoading] = useState(false);
  const { user, setUser } = useAppStore();

  const login = useCallback(async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) throw new Error("Login failed");
      const data = await response.json() as { user: User };
      setUser(data.user);
    } finally {
      setIsLoading(false);
    }
  }, [setUser]);

  const logout = useCallback(() => {
    setUser(null);
  }, [setUser]);

  return { user, isLoading, login, logout };
}
`,
            'useTheme.ts': `import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem("theme") as Theme | null) ?? "system";
  });

  useEffect(() => {
    const root = document.documentElement;
    const isDark =
      theme === "dark" ||
      (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", isDark);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const setTheme = (next: Theme) => setThemeState(next);

  return { theme, setTheme };
}
`,
          },
          'main.tsx': `import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
`,
          pages: {
            'Dashboard.tsx': `import { useMemo } from "react";
import { useAppStore } from "../stores/useAppStore";
import { formatDate } from "@mock/utils";

export function Dashboard() {
  const { items } = useAppStore();
  const sorted = useMemo(
    () => [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    [items]
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <ul className="divide-y rounded-lg border">
        {sorted.map((item) => (
          <li key={item.id} className="flex items-center justify-between px-4 py-3">
            <span className="font-medium">{item.title}</span>
            <span className="text-sm text-muted-foreground">{formatDate(item.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
`,
            'Home.tsx': `import { Button } from "../components/Button";
import { useAuth } from "../hooks/useAuth";

export function Home() {
  const { user, login } = useAuth();
  return (
    <div className="flex flex-col items-center gap-8 py-16">
      <h1 className="text-4xl font-bold tracking-tight">Welcome to Mock App</h1>
      {user ? (
        <p className="text-muted-foreground">Hello, {user.name}!</p>
      ) : (
        <Button onClick={() => login("demo@example.com", "password")}>
          Sign In
        </Button>
      )}
    </div>
  );
}
`,
            'Settings.tsx': `import { useTheme } from "../hooks/useTheme";
import { useAuth } from "../hooks/useAuth";
import { Button } from "../components/Button";

export function Settings() {
  const { theme, setTheme } = useTheme();
  const { logout } = useAuth();

  return (
    <div className="max-w-lg space-y-8">
      <h1 className="text-2xl font-bold">Settings</h1>
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Appearance</h2>
        <div className="flex gap-2">
          {(["light", "dark", "system"] as const).map((t) => (
            <Button
              key={t}
              variant={theme === t ? "primary" : "secondary"}
              size="sm"
              onClick={() => setTheme(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </Button>
          ))}
        </div>
      </section>
      <section>
        <Button variant="destructive" size="sm" onClick={logout}>
          Sign Out
        </Button>
      </section>
    </div>
  );
}
`,
          },
          stores: {
            'useAppStore.ts': `import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { User, Item } from "@mock/types";

interface AppState {
  user: User | null;
  items: Item[];
  setUser: (user: User | null) => void;
  addItem: (item: Item) => void;
  removeItem: (id: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      user: null,
      items: [],
      setUser: (user) => set({ user }),
      addItem: (item) => set((s) => ({ items: [...s.items, item] })),
      removeItem: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
    }),
    { name: "mock-app-store" }
  )
);
`,
          },
          utils: {
            'api.ts': `const BASE_URL = import.meta.env.VITE_API_URL ?? "/api";

export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(\`\${BASE_URL}\${path}\`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    throw new Error(\`API error \${res.status}: \${res.statusText}\`);
  }
  return res.json() as Promise<T>;
}
`,
          },
        },
        'tsconfig.json': `{
  "extends": "../../packages/config/tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
`,
        'vite.config.ts': `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": "/src" },
  },
});
`,
      },
    },
    'biome.json': `{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  }
}
`,
    docs: {
      'api.md': `# API Reference

## Authentication

### POST /api/auth/login

Authenticate a user with email and password.

**Request body**

\`\`\`json
{
  "email": "user@example.com",
  "password": "secret"
}
\`\`\`

**Response**

\`\`\`json
{
  "user": {
    "id": "u_123",
    "name": "Alice",
    "email": "user@example.com",
    "role": "member"
  }
}
\`\`\`

## Items

### GET /api/items

Returns a paginated list of items.

| Query param | Type   | Description         |
|-------------|--------|---------------------|
| page        | number | Page number (1-based) |
| limit       | number | Items per page (max 100) |
`,
      'getting-started.md': `# Getting Started

## Prerequisites

- Node.js >= 22
- pnpm >= 9

## Installation

\`\`\`bash
pnpm install
\`\`\`

## Development

\`\`\`bash
pnpm dev
\`\`\`

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Testing

\`\`\`bash
pnpm test
\`\`\`
`,
    },
    'package.json': `{
  "name": "mock-project",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "biome check ."
  },
  "devDependencies": {
    "turbo": "2.0.0",
    "typescript": "5.4.0"
  }
}
`,
    packages: {
      config: {
        'tsconfig.base.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
`,
      },
      types: {
        'package.json': `{
  "name": "@mock/types",
  "version": "0.1.0",
  "main": "./src/index.ts",
  "types": "./src/index.ts"
}
`,
        src: {
          'api.ts': `export interface Item {
  id: string;
  title: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
`,
          'index.ts': `export type { User } from "./user";
export type { Item, ApiError } from "./api";
`,
          'user.ts': `export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  role: "admin" | "member" | "viewer";
  createdAt: Date;
}
`,
        },
      },
      ui: {
        'package.json': `{
  "name": "@mock/ui",
  "version": "0.1.0",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "peerDependencies": {
    "react": ">=19"
  }
}
`,
        src: {
          components: {
            'Badge.tsx': `import { cn } from "@mock/utils";

type BadgeVariant = "default" | "success" | "warning" | "danger";

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-muted text-muted-foreground",
  success: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  warning: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  danger: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

export function Badge({ children, variant = "default", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        variantStyles[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
`,
            'Card.tsx': `import { cn } from "@mock/utils";

interface CardProps {
  children: React.ReactNode;
  className?: string;
}

export function Card({ children, className }: CardProps) {
  return (
    <div className={cn("rounded-lg border bg-card text-card-foreground shadow-sm", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: CardProps) {
  return <div className={cn("flex flex-col space-y-1.5 p-6", className)}>{children}</div>;
}

export function CardContent({ children, className }: CardProps) {
  return <div className={cn("p-6 pt-0", className)}>{children}</div>;
}

export function CardFooter({ children, className }: CardProps) {
  return (
    <div className={cn("flex items-center p-6 pt-0", className)}>{children}</div>
  );
}
`,
            'Tooltip.tsx': `import { useState, useRef, useEffect } from "react";
import { cn } from "@mock/utils";

interface TooltipProps {
  children: React.ReactNode;
  content: string;
  side?: "top" | "bottom" | "left" | "right";
}

export function Tooltip({ children, content, side = "top" }: TooltipProps) {
  return (
    <div className="relative inline-flex">
      <TooltipTrigger>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </div>
  );
}

export function TooltipTrigger({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function TooltipContent({
  children,
  side = "top",
  className,
}: {
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  const placement: Record<string, string> = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-1",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-1",
    left: "right-full top-1/2 -translate-y-1/2 mr-1",
    right: "left-full top-1/2 -translate-y-1/2 ml-1",
  };
  return (
    <div
      role="tooltip"
      className={cn(
        "absolute z-50 rounded-md bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md",
        placement[side],
        className
      )}
    >
      {children}
    </div>
  );
}
`,
          },
          'index.ts': `export { Badge } from "./components/Badge";
export { Card, CardHeader, CardContent, CardFooter } from "./components/Card";
export { Tooltip, TooltipContent, TooltipTrigger } from "./components/Tooltip";
`,
        },
        'tsconfig.json': `{
  "extends": "../config/tsconfig.base.json",
  "include": ["src"]
}
`,
      },
      utils: {
        'package.json': `{
  "name": "@mock/utils",
  "version": "0.1.0",
  "main": "./src/index.ts",
  "types": "./src/index.ts"
}
`,
        src: {
          __tests__: {
            'array.test.ts': `import { describe, expect, it } from "vitest";
import { groupBy, unique, chunk } from "../array";

describe("groupBy", () => {
  it("groups items by a key function", () => {
    const items = [
      { type: "a", val: 1 },
      { type: "b", val: 2 },
      { type: "a", val: 3 },
    ];
    expect(groupBy(items, (i) => i.type)).toEqual({
      a: [{ type: "a", val: 1 }, { type: "a", val: 3 }],
      b: [{ type: "b", val: 2 }],
    });
  });
});

describe("unique", () => {
  it("deduplicates primitive values", () => {
    expect(unique([1, 2, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("chunk", () => {
  it("splits an array into fixed-size chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
`,
            'string.test.ts': `import { describe, expect, it } from "vitest";
import { capitalize, truncate, slugify } from "../string";

describe("capitalize", () => {
  it("uppercases the first character", () => {
    expect(capitalize("hello")).toBe("Hello");
  });
  it("returns empty string for empty input", () => {
    expect(capitalize("")).toBe("");
  });
});

describe("truncate", () => {
  it("returns the value unchanged when short enough", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });
  it("truncates and appends suffix", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
  });
});

describe("slugify", () => {
  it("converts a phrase to a kebab slug", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
  });
});
`,
          },
          'array.ts': `export function groupBy<T>(
  items: T[],
  keyFn: (item: T) => string
): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    (result[key] ??= []).push(item);
  }
  return result;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
`,
          'cn.ts': `type ClassValue = string | undefined | null | false | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  return inputs
    .flat(Infinity as 1)
    .filter(Boolean)
    .join(" ");
}
`,
          'date.ts': `const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function formatDate(date: Date): string {
  return DATE_FORMATTER.format(date);
}

export function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return \`\${minutes}m ago\`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return \`\${hours}h ago\`;
  return formatDate(date);
}
`,
          'index.ts': `export { cn } from "./cn";
export { capitalize, truncate, slugify } from "./string";
export { formatDate, formatRelativeTime } from "./date";
export { groupBy, unique, chunk } from "./array";
`,
          'string.ts': `export function capitalize(value: string): string {
  if (!value) return "";
  return \`\${value[0]?.toUpperCase()}\${value.slice(1)}\`;
}

export function truncate(value: string, maxLength: number, suffix = "…"): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - suffix.length) + suffix;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
`,
        },
        'tsconfig.json': `{
  "extends": "../config/tsconfig.base.json",
  "include": ["src"]
}
`,
      },
    },
    'README.md': `# Mock Project

A mock monorepo fixture used for Brainstrike development and testing.
It provides a realistic TypeScript + React project structure so engineers
can exercise the file explorer, filters, and selection features without
accessing the host file system.

## Structure

\`\`\`
mock-project/
├── apps/web/        — Vite + React application
├── packages/
│   ├── config/      — Shared TypeScript config
│   ├── types/       — Shared type definitions
│   ├── utils/       — Utility functions (with tests)
│   └── ui/          — Shared React UI components
└── docs/            — Documentation
\`\`\`
`,
    'tsconfig.json': `{
  "extends": "./packages/config/tsconfig.base.json",
  "include": []
}
`,
    'turbo.json': `{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "persistent": true,
      "cache": false
    },
    "test": {
      "outputs": ["coverage/**"]
    },
    "lint": {
      "outputs": []
    }
  }
}
`,
  },
} satisfies FixtureDefinition;
