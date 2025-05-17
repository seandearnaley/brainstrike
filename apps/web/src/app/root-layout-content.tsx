import { Toaster } from '@brainstrike/ui';
import { ThemeProvider } from '@brainstrike/ui';
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/custom/sidebar/sidebar';

export default function RootLayoutContent() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="app-theme">
      <div className="flex h-screen">
        <Sidebar />
        <main className="flex-1 overflow-auto p-4">
          {/* Child routes will render here */}
          <Outlet />
        </main>
      </div>
      <Toaster />
    </ThemeProvider>
  );
}
