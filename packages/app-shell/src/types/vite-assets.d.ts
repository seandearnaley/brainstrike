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

// TypeScript 6.0 enables `noUncheckedSideEffectImports` by default, which
// requires every side-effect import to resolve to a real module or an
// ambient declaration. `vite/client`'s `declare module '*.css' {}` wildcard
// does not satisfy the check for this package-scoped CSS specifier, so it
// needs its own declaration (mirrors the tiktoken wasm entry above).
declare module '@xterm/xterm/css/xterm.css';
