import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../src/tabs';

describe('Tabs', () => {
  it('renders Tabs with its children', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Tab 1 Content</TabsContent>
        <TabsContent value="tab2">Tab 2 Content</TabsContent>
      </Tabs>
    );

    expect(screen.getByText('Tab 1')).toBeInTheDocument();
    expect(screen.getByText('Tab 2')).toBeInTheDocument();
    expect(screen.getByText('Tab 1 Content')).toBeInTheDocument();
    // Tab 2 content should be hidden initially
    // Note: we can't use toBeVisible() because the element is not rendered to the DOM
    expect(screen.queryByText('Tab 2 Content')).not.toBeInTheDocument();
  });

  it('renders TabsList with custom className', () => {
    render(
      <Tabs>
        <TabsList className="custom-class">
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    const tabsList = screen.getByRole('tablist');
    expect(tabsList).toHaveClass('custom-class');
  });

  it('renders TabsTrigger with custom className', () => {
    render(
      <Tabs>
        <TabsList>
          <TabsTrigger className="custom-trigger" value="tab1">
            Tab 1
          </TabsTrigger>
        </TabsList>
      </Tabs>
    );

    const trigger = screen.getByRole('tab');
    expect(trigger).toHaveClass('custom-trigger');
  });

  it('renders TabsContent with custom className', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent className="custom-content" value="tab1">
          Content
        </TabsContent>
      </Tabs>
    );

    const content = screen.getByText('Content');
    expect(content).toHaveClass('custom-content');
  });

  it('passes additional props to TabsList', () => {
    render(
      <Tabs>
        <TabsList data-testid="tabs-list">
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    expect(screen.getByTestId('tabs-list')).toBeInTheDocument();
  });

  it('passes additional props to TabsTrigger', () => {
    render(
      <Tabs>
        <TabsList>
          <TabsTrigger data-testid="tabs-trigger" value="tab1">
            Tab 1
          </TabsTrigger>
        </TabsList>
      </Tabs>
    );

    expect(screen.getByTestId('tabs-trigger')).toBeInTheDocument();
  });

  it('passes additional props to TabsContent', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent data-testid="tabs-content" value="tab1">
          Content
        </TabsContent>
      </Tabs>
    );

    expect(screen.getByTestId('tabs-content')).toBeInTheDocument();
  });

  it('uses explicit transition properties on TabsTrigger instead of transition-all', () => {
    render(
      <Tabs>
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    const trigger = screen.getByRole('tab');
    expect(trigger.className).toContain(
      'transition-[color,background-color,border-color,box-shadow,opacity,transform]'
    );
    expect(trigger.className).not.toContain('transition-all');
  });
});
