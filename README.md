# BrainStrike Monorepo 🚀

<!-- Add your logo here! -->
<!-- ![BrainStrike Logo](path/to/your/logo.png) -->

**BrainStrike is a 2025-ready, AI-powered productivity suite built on a robust monorepo architecture. We leverage modern technologies like Vite, React 19, and Turborepo to deliver cutting-edge tools for the future of work.**

[![Build Status](https://img.shields.io/github/actions/workflow/status/your-repo/your-workflow.yml?branch=main)](https://github.com/your-repo/actions) <!-- Replace with your actual build status badge -->
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC) <!-- Or your actual license -->
[![Version](https://img.shields.io/npm/v/your-main-package)](https://www.npmjs.com/package/your-main-package) <!-- If applicable -->
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](AGENTS.md)

---

## 🌟 Overview

BrainStrike aims to revolutionize productivity by providing intelligent tools that streamline workflows and enhance creativity. This monorepo houses our core applications (🌐 Web and 💻 Desktop) and a suite of shared packages that power them. Our architecture emphasizes speed, maintainability, and scalability.

## ✨ Features

*   🧠 **AI-Powered Productivity:** Leverage the latest AI advancements.
*   🖥️ **Cross-Platform:** Access BrainStrike on the Web and via a dedicated Desktop application.
*   🛠️ **Modern Tech Stack:** Built with React 19, Vite, TypeScript, and Tailwind CSS.
*   ⚡ **High Performance:** Optimized for speed and efficiency.
*   🧩 **Modular Design:** Shared packages ensure consistency and rapid development.
*   🔌 **Extensible:** Adapter patterns for file system and storage allow for easy expansion.

---

## 🏗️ Architecture

Our monorepo is structured to support multiple applications and shared libraries efficiently.

```mermaid
%%{
  init: {
    'theme': 'base',
    'fontFamily': 'Inter, sans-serif',
    'themeVariables': {
      'primaryColor': '#ffffff',
      'primaryTextColor': '#111827',
      'primaryBorderColor': '#d1d5db',
      'lineColor': '#6b7280',
      'secondaryColor': '#f3f4f6',
      'tertiaryColor': '#e5e7eb'
    }
  }
}%%
graph LR
    %% Root Node
    subgraph "Monorepo"
        direction LR
        A((Root)):::rootStyle
    end

    %% Application Nodes
    subgraph " "
      direction TB
      APPS_LABEL[Applications]:::subgraphLabel
      subgraph " "
        WEB[apps/web]:::appStyle
        DESKTOP[apps/desktop]:::appStyle
      end
    end


    %% Package Nodes
    subgraph " "
      direction LR
      PACKAGES_LABEL[Packages]:::subgraphLabel
        subgraph "UI & Hooks"
            direction TB
            UI[packages/ui]:::uiStyle
            HOOKS[packages/hooks]:::uiStyle
        end

        subgraph "File System"
            direction TB
            FEXPLORE_UI[packages/file-explorer-ui]:::featureStyle
            FEXPLORE_HOOKS[packages/file-explorer-hooks]:::featureStyle
            FEXPLORE[packages/file-explorer]:::featureStyle
            FILESYS[packages/file-system]:::coreStyle
            STORAGE[packages/storage]:::coreStyle
        end

        subgraph "Core & Config"
            direction TB
            UTILS[packages/utils]:::coreStyle
            TYPES[packages/types]:::coreStyle
            SERVER_CONFIG[packages/server-config]:::configStyle
            TAILWIND[packages/tailwind-config]:::configStyle
            FONTS[packages/fonts]:::configStyle
            CONFIG[packages/config]:::configStyle
            DB[packages/db]:::coreStyle
        end
    end


    %% Define Connections
    A --> APPS_LABEL
    A --> PACKAGES_LABEL


    %% App Dependencies
    WEB --> UI
    WEB --> HOOKS
    WEB --> UTILS
    WEB --> TYPES
    WEB --> FEXPLORE_UI
    WEB --> DB
    WEB --> SERVER_CONFIG
    DESKTOP --> DB

    DESKTOP --> WEB
    DESKTOP --> UTILS


    %% Package Dependencies
    UI --> TAILWIND
    UI --> FONTS
    UI --> TYPES

    FEXPLORE_UI --> UI
    FEXPLORE_UI --> FEXPLORE_HOOKS
    FEXPLORE_UI --> TYPES
    FEXPLORE_UI --> UTILS

    FEXPLORE_HOOKS --> FEXPLORE
    FEXPLORE_HOOKS --> TYPES
    FEXPLORE_HOOKS --> UTILS
    FEXPLORE_HOOKS --> STORAGE
    FEXPLORE_HOOKS --> FILESYS

    FEXPLORE --> TYPES
    FEXPLORE --> UTILS
    UTILS --> TYPES


    %% Define Styles
    classDef rootStyle fill:#be185d,stroke:#9d174d,color:#ffffff,font-weight:bold
    classDef appStyle fill:#4f46e5,stroke:#3730a3,color:#ffffff,font-weight:bold,stroke-width:2px
    classDef uiStyle fill:#16a34a,stroke:#14532d,color:#ffffff
    classDef featureStyle fill:#c026d3,stroke:#86198f,color:#ffffff
    classDef coreStyle fill:#d97706,stroke:#9a3412,color:#ffffff
    classDef configStyle fill:#64748b,stroke:#475569,color:#ffffff
    classDef subgraphLabel fill:#ffffff,stroke:#ffffff,color:#000000,font-weight:bold,font-size:18px

    %% Make label nodes invisible
    style APPS_LABEL stroke-width:0
    style PACKAGES_LABEL stroke-width:0
```

### Repository Layout

Below is a simplified overview of our monorepo structure, highlighting key areas:

```
.
├── apps/
│   ├── desktop/        # 💻 Electron wrapper for the desktop application
│   │   └── src/
│   │       ├── main.ts         # Electron main process
│   │       └── preload.ts      # Electron preload script
│   └── web/            # 🌐 Main Vite + React web application
│       ├── src/
│       │   ├── app/            # Core application components and routes
│       │   └── main.tsx        # Entry point for the web app
│       └── e2e/            # Playwright End-to-End tests
│
├── packages/
│   ├── app-shell/      # 🖼️ Core application layout and navigation
│   ├── config/         # ⚙️ Shared configurations (Biome, TSConfig, etc.)
│   │   ├── biome/
│   │   └── tsconfig/
│   ├── file-explorer/  # Core file analysis logic (platform-agnostic)
│   ├── file-explorer-hooks/ # 🎣 React hooks for file explorer features
│   ├── file-explorer-ui/ # 🖼️ UI components for file explorer
│   ├── file-system/    # Abstraction for file system operations
│   │   └── src/
│   │       └── adapters/   # (e.g., Node.js, Web, In-memory)
│   ├── fonts/          # 🖋️ Shared font assets
│   ├── hooks/          # 🎣 General-purpose React hooks
│   ├── server-config/  # 🔩 Configuration for server-side aspects
│   ├── storage/        # 💾 Abstraction for data persistence
│   │   └── src/
│   │       └── adapters/   # (e.g., LocalStorage, Electron-store)
│   ├── db/             # 🗄️ Local database helpers ([packages/db](./packages/db/README.md))
│   ├── tailwind-config/# 🎨 Shared Tailwind CSS configuration
│   ├── test-utils/     # 🧪 Utilities for testing
│   ├── types/          # 🏷️ Shared TypeScript types and interfaces
│   ├── ui/             # 🧱 Shared React UI components (buttons, dialogs, etc.)
│   ├── utils/          # 🛠️ Common utility functions (tokenizers, etc.)
│   └── workers/        # 👷 Web workers (e.g., file content processing)
│
├── .github/            # 🤖 GitHub Actions workflows
├── .husky/             # 🐶 Git hooks
├── docs/               # 📚 Project documentation
├── scripts/            # 📜 Utility scripts for the repository
├── README.md           # 👈 This file!
├── package.json        # Root package.json
├── pnpm-workspace.yaml # Defines pnpm workspace packages
├── tsconfig.json       # Root TypeScript configuration
└── turbo.jsonc         # Turborepo configuration
```
This structure helps us maintain a clean separation of concerns, allowing for independent development and testing of different parts of the application suite.

### Key Architectural Patterns
*   **Monorepo:** Managed with `pnpm` workspaces and Turborepo for optimized build and dependency management.
*   **Shared Packages:** Core logic, UI components, utilities, and types are shared across applications to promote consistency and code reuse.
*   **Adapter Pattern:** `packages/file-system` and `packages/storage` use adapters, allowing them to work seamlessly in different environments (browser, Node.js/Electron, and for testing). This is crucial for platform flexibility.

```mermaid
graph LR;
    subgraph CoreLogic[File Explorer Core]
        direction LR
        FXH[file-explorer-hooks]
    end

    subgraph Abstractions
        direction LR
        FS[packages/file-system]
        S[packages/storage]
    end

    subgraph Adapters_FileSystem[File System Adapters]
        direction TB
        FS_Node[NodeFSAdapter]
        FS_Web[WebFSAdapter e.g., via API]
        FS_Mem[InMemoryFSAdapter for tests]
    end

    subgraph Adapters_Storage[Storage Adapters]
        direction TB
        S_Local[LocalStorageAdapter Web]
        S_Electron[ElectronStoreAdapter Desktop]
        S_Mem[InMemoryStorageAdapter for tests]
    end

    FXH --> FS;
    FXH --> S;

    FS --> FS_Node;
    FS --> FS_Web;
    FS --> FS_Mem;

    S --> S_Local;
    S --> S_Electron;
    S --> S_Mem;

    APPS[Applications Web/Desktop] --> FXH;
    TESTS[Tests] --> FXH;

    style FS_Node fill:#D4E6F1,stroke:#2E86C1
    style FS_Web fill:#D4E6F1,stroke:#2E86C1
    style FS_Mem fill:#D4E6F1,stroke:#2E86C1

    style S_Local fill:#D1F2EB,stroke:#1ABC9C
    style S_Electron fill:#D1F2EB,stroke:#1ABC9C
    style S_Mem fill:#D1F2EB,stroke:#1ABC9C
```
This diagram illustrates how the `file-explorer-hooks` (representing the core logic consuming these abstractions) interact with `packages/file-system` and `packages/storage`. These packages, in turn, delegate operations to specific adapters based on the runtime environment (Node.js for desktop/CLI, Web APIs for browsers, or in-memory versions for testing). This keeps the core logic decoupled from the underlying platform specifics.

---

## 🚀 Getting Started

### ✅ Prerequisites
*   **Node.js:** Version 22+ (check `.nvmrc` for the exact version).
*   **pnpm:** Version 10+.
*   Verify that each `package.json` within `apps/*` and `packages/*` declares `"engines": { "node": ">=22" }`.

### 📦 Installation
1.  **Clone the repository:**
    ```bash
    git clone <your-repository-url> # Replace with your repository URL
    cd brainstrike-monorepo
    ```
2.  **Install dependencies:**
    ```bash
    pnpm install
    ```

### ▶️ Running the Applications
*   **Web App (Development):**
    ```bash
    pnpm dev --filter web
    ```
    Access at `http://localhost:xxxx` (port may vary).

*   **Desktop App (Development):**
    ```bash
    # In one terminal:
    pnpm dev --filter desktop
    # In another terminal:
    pnpm start --filter desktop
    ```
    _The desktop app is an Electron wrapper around the web UI, offering a native experience._

### 💡 Tokenizer Worker (Backend/Node.js)
The `@brainstrike/utils` package features a tokenizer worker for precise token counting, crucial for AI interactions:
- Requires **Node.js 18+** with ESM support.
- Utilizes OpenAI's `tiktoken` for GPT-4 level accuracy by default.
- Falls back to a heuristic estimation if the worker cannot be initialized.
- To force heuristic mode (e.g., for specific testing or environments), set the environment variable: `DISABLE_TOKEN_WORKER=1`.
- **Important:** This worker operates only in Node.js environments (like the Electron main process or backend services) and is not available in browser contexts.

---

## 🛠️ Tech Stack & Toolchain

Our choice of technologies is geared towards building a modern, scalable, and maintainable application suite with a great developer experience.

| Category          | Technology / Tool                 | Description                                                                 |
|-------------------|-----------------------------------|-----------------------------------------------------------------------------|
| **Core Framework**| React 19                          | For building dynamic and responsive user interfaces.                        |
| **Build Tool**    | Vite                              | Fast development server and optimized builds.                               |
| **Monorepo Mgmt** | Turborepo                         | High-performance build system for monorepos.                                |
| **Package Manager**| pnpm                              | Fast, disk space-efficient package manager.                                 |
| **Language**      | TypeScript 5                      | Strong typing for enhanced code quality and maintainability.                |
| **Styling**       | Tailwind CSS v4                   | Utility-first CSS framework for rapid UI development.                       |
| **Lint & Format** | Biome                             | Fast and comprehensive linter and formatter.                                |
| **Unit Testing**  | Vitest                            | Vite-native unit testing framework.                                         |
| **E2E Testing**   | Playwright                        | For robust end-to-end testing of the web application.                     |
| **Routing**       | React Router                      | Declarative routing for React applications.                                 |
| **Head Mgmt**     | `react-helmet-async`              | Manage document head changes asynchronously.                                |
| **Desktop App**   | Electron                          | Build cross-platform desktop apps with web technologies.                    |
| **Key Docs**      | [IDE Layout](./docs/ide-layout.md)| Guidelines for building multi-panel workspaces.                             |

### Common Commands

| Command                   | Description                                         |
|---------------------------|-----------------------------------------------------|
| `pnpm dev --filter web`   | Start local development for the 🌐 web app.         |
| `pnpm dev --filter desktop` | Start local development for the 💻 desktop app (Vite dev server). |
| `pnpm start --filter desktop`| Launch the Electron shell for the 💻 desktop app.   |
| `pnpm build`                | Build all apps and packages.                        |
| `pnpm test`                 | Run unit and integration tests across the monorepo. |
| `pnpm test:e2e`             | Run Playwright E2E tests for the 🌐 web app.      |
| `pnpm turbo run lint`       | Lint the entire codebase with Biome.                |
| `pnpm lint --fix`           | Auto-fix lint issues with Biome.                    |
| `pnpm turbo run type-check` | Run TypeScript type checks for all packages.        |
| `pnpm format`               | Auto-format source files using Biome.               |
| `pnpm run check`            | Run full validation: lint, type-check, build, test. |


### Tailwind Configuration
To use the shared Tailwind configuration (`@brainstrike/tailwind-config`) in any package:
1.  **Extend the base configuration.**
2.  **Specify `content` globs** to include all files that contain Tailwind classes.

Example (`tailwind.config.js` in a package):
```javascript
const base = require('@brainstrike/tailwind-config');

module.exports = {
  ...base,
  content: [
    './index.html', // If your package has an index.html
    './src/**/*.{js,ts,jsx,tsx}',
    // Ensure paths to shared UI packages are included if their components are used directly
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
};
```

---

## ⚙️ Configuration

*   For detailed information about configuring the file explorer's behavior and settings, please refer to [docs/file-explorer-settings.md](./docs/file-explorer-settings.md).

---

## 🤝 Contributing

We enthusiastically welcome contributions! To ensure a smooth collaboration, please adhere to the following:

*   📖 **Coding Standards & Workflow:** Follow the guidelines outlined in [AGENTS.md](./AGENTS.md).
*   ✍️ **Commit Messages:** Employ the [Conventional Commits](https://www.conventionalcommits.org/) format for clear and consistent commit history.
*   ✅ **Validation:** Before submitting any changes, run `pnpm run check` to ensure all tests, linting, and type checks pass.
*    Deep Dive Technical Guides:
    *   [onboarding.md](./onboarding.md) - For new contributors getting started with the project.
    *   [monorepo-docs.md](./monorepo-docs.md) - For in-depth understanding of the monorepo architecture and practices.

The file explorer's adaptability across platforms (web, desktop, testing environments) is made possible by the `@brainstrike/storage` and `@brainstrike/file-system` packages, which implement a platform-aware adapter pattern. This design is key to our cross-platform strategy.

---

## 📜 License

This project is licensed under the **ISC License**. You can find more details in the `LICENSE` file if one is present in the root of the repository. (Based on the original README, ISC is the specified license).
