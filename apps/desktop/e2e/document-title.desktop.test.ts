import { expect, test } from './fixtures/electron-fixture';

// The window title names the route on screen. One writer (`useDocumentTitle`
// at the desktop root) keys it on the active route; a visited route stays
// mounted, so per-page `<title>` elements could not.
test('the window title follows the route on screen, after Settings stays mounted too', async ({
  homePage,
  window,
}) => {
  await expect(window).toHaveTitle('Brainstrike - Home');
  await homePage.openSettings();
  await expect(window).toHaveTitle('Brainstrike - Settings');
  await homePage.leaveSettings();
  await expect(window).toHaveTitle('Brainstrike - Home');
});
