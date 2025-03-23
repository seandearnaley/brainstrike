# Brainstrike Desktop

A cross-platform desktop application that bundles the Brainstrike Next.js 15 + React 19 app.

## Development Setup

### Prerequisites

- Node.js (version 18 or later recommended)
- npm (or yarn/pnpm)

### Installation

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```

### Running the App

To run the app in development mode:

```
npm run dev
```

### Building the App

To build the app for distribution:

```
npm run build
```

This will create installers in the `dist` directory.

## Project Structure

- `/main` - Main process code (Electron)
- `/renderer` - Renderer process code (HTML/CSS/JS, future Next.js integration)

## Next Steps

After this basic Electron setup is confirmed working, we'll integrate the Next.js 15 application.