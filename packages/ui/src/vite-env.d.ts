/// <reference types="vite/client" />

// Type declarations for PNG assets with ?url suffix
declare module '*.png?url' {
  const src: string;
  export default src;
}
