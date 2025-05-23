import type { ComponentType, ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';

export interface RouterProviderProps {
  children: ReactNode;
  routerComponent?: ComponentType<{ children?: ReactNode }>;
}

export default function RouterProvider({ children, routerComponent }: RouterProviderProps) {
  const RouterComponent = routerComponent ?? BrowserRouter;
  return (
    <RouterComponent>
      <div className="h-full">{children}</div>
    </RouterComponent>
  );
}
