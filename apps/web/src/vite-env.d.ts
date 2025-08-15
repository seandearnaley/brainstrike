/// <reference types="vite/client" />

// Type declarations for PNG assets with ?url suffix
declare module '*.png?url' {
  const src: string;
  export default src;
}

// Extend vite client types indirectly by referencing keys in code where needed.
// Declaring interfaces here causes lints for unused types; avoid explicit interfaces.

// Keep default ImportMeta from vite/client reference; no redeclare needed here
