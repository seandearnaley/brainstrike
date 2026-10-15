import { Folder, Settings } from 'lucide-react';
import { navigationItems } from '../navigation';

describe('navigationItems', () => {
  it('should have the correct number of items', () => {
    expect(navigationItems).toHaveLength(2);
  });

  it('keeps prompts in the agent sidebar instead of root navigation', () => {
    expect(navigationItems.find((item) => item.name === 'Prompts')).toBeUndefined();
    expect(navigationItems.find((item) => item.path === '/prompts')).toBeUndefined();
  });

  it('should have the correct properties for Context Explorer', () => {
    const contextExplorerItem = navigationItems.find((item) => item.name === 'Context Explorer');
    expect(contextExplorerItem).toBeDefined();
    expect(contextExplorerItem?.icon).toBe(Folder);
    expect(contextExplorerItem?.path).toBe('/');
  });

  it('should have the correct properties for Settings', () => {
    const settingsItem = navigationItems.find((item) => item.name === 'Settings');
    expect(settingsItem).toBeDefined();
    expect(settingsItem?.icon).toBe(Settings);
    expect(settingsItem?.path).toBe('/settings');
  });

  it('should define all required properties for each item', () => {
    for (const item of navigationItems) {
      expect(item.name).toBeDefined();
      expect(typeof item.name).toBe('string');
      expect(item.icon).toBeDefined();
      // expect(typeof item.icon).toBe('function'); // Lucide icons are functions
      expect(item.path).toBeDefined();
      expect(typeof item.path).toBe('string');
    }
  });
});
