import { Folder, MessageSquare, Network, Settings } from 'lucide-react';
import type { NavigationItem } from './types';

export const navigationItems: NavigationItem[] = [
  { name: 'Context Explorer', icon: Folder, path: '/' },
  { name: 'Agent Hub', icon: Network, path: '/agent-hub' },
  { name: 'Prompts', icon: MessageSquare, path: '/prompts' },
  { name: 'Settings', icon: Settings, path: '/settings' },
];
