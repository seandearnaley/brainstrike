import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** A collapsed approval row hides its buttons; open it before asserting on them. */
export async function expandApprovalRow(user: UserEvent): Promise<void> {
  await user.click(screen.getByRole('button', { name: /show approval details/i }));
}
