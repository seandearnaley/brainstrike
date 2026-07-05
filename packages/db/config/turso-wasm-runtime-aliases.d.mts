type TursoWasmRuntimeAliasSpecifier =
  | '@emnapi/core'
  | '@emnapi/runtime'
  | '@emnapi/wasi-threads'
  | '@tybys/wasm-util';

export declare function createTursoWasmRuntimeAliasMap(
  fromDir: string
): Record<TursoWasmRuntimeAliasSpecifier, string>;
