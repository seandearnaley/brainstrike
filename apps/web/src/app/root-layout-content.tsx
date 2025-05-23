import { AppLayout, createAppConfig } from '@brainstrike/app-shell';
import { Folder, Settings } from 'lucide-react';
import { Outlet, useLocation } from 'react-router-dom';

const appConfig = createAppConfig({
  navigationItems: [
    { name: 'Context Explorer', icon: Folder, path: '/' },
    { name: 'Settings', icon: Settings, path: '/settings' },
  ],
});

export default function RootLayoutContent() {
  const { pathname } = useLocation();

  return (
    <div className="h-screen">
      <AppLayout config={appConfig} currentPath={pathname}>
        <Outlet />
      </AppLayout>
    </div>
  );
}
