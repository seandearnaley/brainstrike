import { Folder, Network, Settings } from 'lucide-react';
import { navigationItems } from '../navigation';

describe('navigationItems', () => {
  it('should have the correct number of items', () => {
    expect(navigationItems).toHaveLength(4);
  });

  it('should have the correct properties for Context Explorer', () => {
    const contextExplorerItem = navigationItems.find((item) => item.name === 'Context Explorer');
    expect(contextExplorerItem).toBeDefined();
    expect(contextExplorerItem?.icon).toBe(Folder);
    expect(contextExplorerItem?.path).toBe('/');
  });

  it('should have the correct properties for Agent Hub', () => {
    const agentHubItem = navigationItems.find((item) => item.name === 'Agent Hub');
    expect(agentHubItem).toBeDefined();
    expect(agentHubItem?.icon).toBe(Network);
    expect(agentHubItem?.path).toBe('/agent-hub');
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
