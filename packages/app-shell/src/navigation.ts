import { Folder, Settings } from 'lucide-react';
import type { NavigationItem } from './types';

export const navigationItems: NavigationItem[] = [
  { name: 'Context Explorer', icon: Folder, path: '/' },
  { name: 'Settings', icon: Settings, path: '/settings' },
];
