// app-shell source-type-checks workspace packages that use Vite wasm asset URLs.
declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module 'tiktoken/lite/tiktoken_bg.wasm?url' {
  const url: string;
  export default url;
}

declare module '*.png?url' {
  const url: string;
  export default url;
}
