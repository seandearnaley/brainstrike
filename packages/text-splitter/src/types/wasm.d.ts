declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module 'tiktoken/lite/init' {
  export const Tiktoken: unknown;
  export const init: unknown;
}

declare module 'tiktoken/lite/tiktoken_bg.wasm?url' {
  const url: string;
  export default url;
}

declare module 'tiktoken/encoders/o200k_base.json' {
  const encoderConfig: Record<string, unknown>;
  export default encoderConfig;
}
