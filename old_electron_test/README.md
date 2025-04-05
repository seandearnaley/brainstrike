# Brainstrike Desktop

A cross-platform desktop application that bundles the Brainstrike Next.js 15 + React 19 app.

## Development Setup

### Prerequisites

- Node.js (version 18 or later recommended)
- npm (or yarn/pnpm)

### Installation

1. Clone this repository
2. Run the setup script to copy the Next.js app:
   ```
   ./setup-nextapp.sh
   ```
3. Install dependencies for the Electron app:
   ```
   npm install
   ```
4. Install dependencies for the Next.js app:
   ```
   cd next-app && npm install
   ```

### Running the App

To run the app in development mode:

```
npm run dev
```

This will build the Next.js app with static export, fix the resource paths, and then launch Electron to serve it.

To run just the Next.js app in development mode (useful for faster iteration):

```
npm run dev:next
```

### Building the App

To build the app for distribution:

```
npm run build
```

This will create installers in the `dist` directory.

## Project Structure

- `/main` - Main process code (Electron)
  - `main.js` - Main Electron process
  - `fixStaticPaths.js` - Utility to fix Next.js static export paths
- `/next-app` - Next.js application code
  - `/next-app/src` - Source code for the Next.js app
  - `/next-app/out` - Built static output from Next.js
  
## Testing

To run tests:

```
npm run test
```

To lint the code:

```
npm run lint
```

## How It Works

1. The Next.js app is built as a static export (output to `/next-app/out`)
2. A path fixer utility modifies the HTML files to use relative paths 
3. Electron loads the modified HTML directly from the filesystem
4. This clean approach avoids the need for a local server