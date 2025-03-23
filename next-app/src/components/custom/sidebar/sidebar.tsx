'use client';

import { cn } from '@/lib/utils';
import { FileText, Folder, Settings } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import React from 'react';
import { ThemeToggle } from '../theme-toggle';

const apps = [
  { name: 'Context Explorer', icon: Folder, path: '/' },
  { name: 'App 2', icon: FileText, path: '/app2' },
  { name: 'Settings', icon: Settings, path: '/settings' },
];

const Sidebar = () => {
  const pathname = usePathname();

  return (
    <aside className="w-16 bg-gray-100 dark:bg-gray-800 h-full flex flex-col items-center py-4 space-y-4">
      {apps.map((app) => (
        <Link
          key={app.name}
          href={app.path}
          className={cn(
            'p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors',
            pathname === app.path && 'bg-gray-200 dark:bg-gray-700'
          )}
          title={app.name}
        >
          <app.icon className="w-6 h-6" />
        </Link>
      ))}
      <div className="mt-auto">
        <ThemeToggle />
      </div>
    </aside>
  );
};

export default Sidebar;
