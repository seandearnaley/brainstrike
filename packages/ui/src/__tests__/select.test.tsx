import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../src/select';

beforeAll(() => {
  // @ts-expect-error - JSDOM does not implement hasPointerCapture
  Element.prototype.hasPointerCapture = () => false;
  // @ts-expect-error - JSDOM does not implement scrollIntoView
  Element.prototype.scrollIntoView = () => {};
});

describe('Select', () => {
  it('opens and selects item', async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select an option" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">One</SelectItem>
        </SelectContent>
      </Select>
    );

    await user.click(screen.getByRole('combobox'));
    const item = screen.getByText('One');
    expect(item).toBeInTheDocument();
    await user.click(item);
    await screen.findByRole('combobox');
  });
});
