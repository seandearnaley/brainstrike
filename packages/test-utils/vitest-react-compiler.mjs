// The shipped renderer compiles workspace React with the React Compiler
// (apps/desktop/vite.config.mts), which memoizes on what a body reads. Unit
// tests compile it the same way, so they exercise the code that ships.
import react from '@vitejs/plugin-react';

export const reactCompiler = () => react({ compiler: { compilationMode: 'infer' } });
