declare module 'react-router-dom' {
  import type { ComponentType, ReactNode } from 'react';

  export const BrowserRouter: ComponentType<{ children?: ReactNode }>;
}
