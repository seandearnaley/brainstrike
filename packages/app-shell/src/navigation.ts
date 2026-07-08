import { Folder, MessageSquare, Settings } from 'lucide-react';
import type { NavigationItem } from './types';

export const navigationItems: NavigationItem[] = [
  { icon: Folder, name: 'Context Explorer', path: '/' },
  { icon: MessageSquare, name: 'Prompts', path: '/prompts' },
  { icon: Settings, name: 'Settings', path: '/settings' },
];
