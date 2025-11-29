import { Folder, MessageSquare, Settings } from 'lucide-react';
import type { NavigationItem } from './types';

export const navigationItems: NavigationItem[] = [
  { name: 'Context Explorer', icon: Folder, path: '/' },
  { name: 'Prompts', icon: MessageSquare, path: '/prompts' },
  { name: 'Settings', icon: Settings, path: '/settings' },
];
