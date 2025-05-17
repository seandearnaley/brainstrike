import { NavigationSidebar } from '@brainstrike/ui';
import { Folder, Settings } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { ThemeToggle } from '../../custom/theme-toggle';

const items = [
  { name: 'Context Explorer', icon: Folder, path: '/' },
  { name: 'Settings', icon: Settings, path: '/settings' },
];

const Sidebar = () => {
  const { pathname } = useLocation();

  return (
    <NavigationSidebar items={items} currentPath={pathname}>
      <ThemeToggle />
    </NavigationSidebar>
  );
};

export default Sidebar;
