import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../../src/accordion';

describe('Accordion', () => {
  it('toggles content visibility when trigger clicked', async () => {
    const user = userEvent.setup();
    render(
      <Accordion collapsible type="single">
        <AccordionItem value="item1">
          <AccordionTrigger>Item 1</AccordionTrigger>
          <AccordionContent>Content 1</AccordionContent>
        </AccordionItem>
      </Accordion>
    );

    expect(screen.queryByText('Content 1')).not.toBeInTheDocument();
    await user.click(screen.getByText('Item 1'));
    expect(screen.getByText('Content 1')).toBeInTheDocument();
  });

  it('applies custom class to AccordionItem', () => {
    render(
      <Accordion collapsible type="single">
        <AccordionItem className="custom" value="item1">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>
    );

    screen.getByText('Trigger');
    // The custom class should be applied to the AccordionItem element
    const item = document.querySelector('.custom');
    expect(item).not.toBeNull();
  });

  it('uses explicit transition properties on AccordionTrigger instead of transition-all', () => {
    render(
      <Accordion collapsible type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>Item</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>
    );

    const trigger = screen.getByRole('button', { name: 'Item' });
    expect(trigger.className).toContain('transition-[color,opacity,box-shadow,border-color]');
    expect(trigger.className).not.toContain('transition-all');
  });
});
