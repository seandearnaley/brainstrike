# BrainStrike Web - File Explorer Dashboard

## Overview

BrainStrike Web is a file explorer dashboard designed to provide a seamless and intuitive way to browse, manage, and analyze file systems. Built with React, TypeScript, Vite, and Tailwind CSS, this application offers a modern and responsive interface for file management. The dashboard includes features such as filtering, reporting, and configuration options to enhance your workflow.

## Key Features

- **Intuitive File Browsing**: Effortlessly navigate directories and view files with a clear and interactive interface.
- **Flexible File Selection**: Select multiple files, with options to select all or clear your selections easily.
- **Advanced File Filtering**: Use include and exclude filters, supporting both glob and regular expression patterns.
- **Comprehensive Reporting**: Generate and download detailed reports of selected files, with the option to copy directly to your clipboard.
- **Customizable Configuration**: Adjust settings such as maximum selection count, file extension filters, and folder summary thresholds.
- **Project Tree Visualization**: Choose to include a complete project directory tree in your reports.
- **Theming**: Switch between light, dark, and system themes with a single click.
- **Error Handling**: Robust error handling and notifications to ensure a smooth user experience.
- **Keyboard Accessibility**: Enhanced keyboard navigation.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Development](#development)
  - [Code Quality](#code-quality)
  - [Knip (Unused Code Detection)](#knip-unused-code-detection)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)
- [Release Process](#release-process)

## Installation

### Prerequisites

- Node.js (>= 22.x recommended)
- npm (>= 9.x) or yarn (>= 1.22)

### Setup Steps

1. **Clone the repository:**

   ```sh
   git clone https://github.com/seandearnaley/brainstrike-web.git
   cd brainstrike-web
   ```

2. **Install dependencies:**

   ```sh
   npm install
   # or
   yarn install
   ```

3. **Start the development server:**

   ```sh
   npm run dev
   # or
   yarn dev
   ```

4. Open your browser and navigate to `http://localhost:3000`.

## Usage

### Navigation

1. **Select Root Directory**: Click the "Select Root" button to choose the directory you want to explore.
2. **App Navigation**: Use the sidebar to switch between different applications within the dashboard.

### File Management

1. **Filtering**: Use the configuration panel to set include and exclude file filters.
2. **Selection**: Select individual files using the checkboxes or use "Select All" to include all displayed files.
3. **Reporting**:
   - Click "Download Report" to download a text file containing the selected files.
   - Click "Copy Report" to copy the report to your clipboard.

### Configuration

1. **File Explorer Settings**: Open the settings using the gear icon to configure:
   - **Max Selection Count**: Set the maximum number of files that can be selected at once.
   - **File Filters**: Specify patterns to include or exclude specific files or directories, using either glob or regex patterns.
   - **Folder Summary Threshold**: Adjust the number of files to display before summarizing folder contents in the report.
   - **Include Project Tree**: Toggle to include a complete project tree in your reports.
2. **Theme Settings**: Toggle between light, dark, and system-based themes in the "Settings" app.

## Development

### Code Style

This project enforces code style and quality with:

-   **Biome**: For formatting and linting.
-   **TypeScript**: For static typing.
-   **Commitlint**: For consistent commit messages.

Use the following commands to check and fix code style issues:

```sh
npm run lint # Check for linting issues
npm run lint:fix # Automatically fix linting issues
npm run format # Check for formatting issues
npm run format:fix # Automatically fix formatting issues
npm run type-check # Check typescript issues
```

### Project Structure

- `src/components`: React components, further organized into `custom` and `ui` directories.
- `src/constants`: Project constants such as file extensions and default filters.
- `src/hooks`: Custom React hooks for managing state and side effects.
- `src/lib`: Utility functions for file system interactions and data manipulation.
- `src/providers`: Context providers for theming and other app-wide states.
- `src/services`: Placeholder for future services.
- `src/types`: TypeScript types used throughout the application.
- `src/utils`: Utility functions for filters, reports, and tree generation.
- `e2e`: End-to-end tests with Playwright.
- `test`: Test utilities and factories.
- `public`: Static assets.

### Code Quality

This project enforces code style and quality with:

-   **Biome**: For formatting and linting.
-   **TypeScript**: For static typing.
-   **Commitlint**: For consistent commit messages.

Use the following commands to check and fix code style issues:

```sh
npm run lint # Check for linting issues
npm run lint:fix # Automatically fix linting issues
npm run format # Check for formatting issues
npm run format:fix # Automatically fix formatting issues
npm run type-check # Check typescript issues
```

### Knip (Unused Code Detection)

We use [Knip](https://knip.dev) to detect unused files, exports, and dependencies in the codebase. This helps us maintain a clean and efficient codebase by identifying and removing dead code.

#### Running Knip Locally

```sh
# Run standard analysis
npm run knip

# Run production-focused analysis
npm run knip:production
```

Knip is configured in `knip.jsonc` with appropriate ignore patterns to prevent false positives.

#### CI Integration

Knip is integrated into our CI pipeline in two ways:

1. **Pull Request Checks**: A basic Knip check runs on every PR to catch any new unused code.
2. **On-Demand Analysis**: A comprehensive Knip analysis can be manually triggered when needed.

For PRs that modify source code or Knip configuration, a detailed report is generated and posted as a comment.

#### Fixing Issues

When Knip identifies unused code:

1. Verify that the code is truly unused (not dynamically imported or referenced)
2. Remove the unused code or add it to the ignore list in `knip.jsonc` if it's a false positive
3. Run Knip again to confirm the issue is resolved

## Testing

This project uses Jest, React Testing Library, and Playwright for testing.

### Test Commands

- **Run all tests:**

  ```sh
  npm test
  # or
  yarn test
  ```

- **Run unit tests:**

  ```sh
  npm run test:unit
  # or
  yarn test:unit
  ```

- **Run integration tests:**

  ```sh
  npm run test:integration
  # or
  yarn test:integration
  ```

- **Run all tests with coverage:**

  ```sh
  npm run test:coverage
  # or
  yarn test:coverage
  ```

- **Run E2E tests:**

  ```sh
  npm run test:e2e
  # or
  yarn test:e2e
  ```

- **Run E2E tests in UI mode:**

  ```sh
  npm run test:e2e:ui
  # or
  yarn test:e2e:ui
  ```
- **Show E2E Report**

    ```sh
    npm run test:e2e:report
    # or
    yarn test:e2e:report
    ```

### Testing Guidelines

Please refer to [`testing-guidelines.md`](testing-guidelines.md) for detailed information on test types, configuration, best practices, and more.

### Local Workflow Testing

#### Act

We use [Act](https://github.com/nektos/act) to test GitHub Actions workflows locally.

1.  Install Act:

    ```sh
    # macOS
    brew install act
    
    # test workflow
    act pull_request -W .github/workflows/test.yml --container-architecture linux/amd64
    
    # Other platforms see: https://github.com/nektos/act#installation
    ```

2.  Run workflows:

    ```sh
    # Test all workflows
    npm run test:workflow

    # Test release workflow
    npm run test:workflow:release

    # Test PR workflow
    npm run test:workflow:test
    ```

#### Semantic Release

Test the release process without making actual releases:

```sh
# Dry run
npm run test:release

# Debug mode
npm run test:release:debug
```

#### Commit Messages

Verify that commit messages follow conventional commits specification:

```sh
# Test last commit
npm run test:commit

# Test a specific message
npm run test:commit:msg
```

#### Local Secrets Configuration

For local testing with Act, create a `.secrets` file (git-ignored):

```sh
GITHUB_TOKEN=your_github_token
CODECOV_TOKEN=your_codecov_token
```

## Contributing

Contributions are welcome! Please read our [`CONTRIBUTING.md`](docs/CONTRIBUTING.md) for guidelines on how to contribute to this project.

## License

This project is licensed under the MIT License. See the [`LICENSE`](LICENSE) file for more details.