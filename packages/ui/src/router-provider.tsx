import type { ComponentType, ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';

export type RouterProviderProps = {
  children: ReactNode;
  routerComponent?: ComponentType<{ children?: ReactNode }>;
};

export default function RouterProvider({ children, routerComponent }: RouterProviderProps) {
  const RouterComponent = routerComponent ?? BrowserRouter;
  return (
    <RouterComponent>
      <div className="h-screen">{children}</div>
    </RouterComponent>
  );
}
