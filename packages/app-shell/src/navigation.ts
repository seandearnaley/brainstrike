import { Folder, Settings } from 'lucide-react';
import type { NavigationItem } from './types';

export const navigationItems: NavigationItem[] = [
  { icon: Folder, name: 'Context Explorer', path: '/' },
  { icon: Settings, name: 'Settings', path: '/settings' },
];
