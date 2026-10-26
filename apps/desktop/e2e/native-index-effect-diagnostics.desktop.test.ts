import { Schema } from 'effect';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { getMainBufferedLogs } from './utils/main-logs';

test.use({ electronEnv: { LOG_LEVEL: 'info' } });
const Event = Schema.Struct({
  operation: Schema.String,
  outcome: Schema.optional(Schema.String),
  parentSpanId: Schema.optional(Schema.String),
  phase: Schema.Literals(['start', 'end', 'event']),
  spanId: Schema.String,
  traceId: Schema.String,
});
test('native-index pause exposes a correlated start, action and cleanup timeline in Logs', async ({
  window,
  homePage,
}, testInfo) => {
  await homePage.openSettings();
  const section = await new SettingsPage(window).openCategory(
    /Search & Indexing/i,
    'search-indexing'
  );
  await expect(window.getByTestId('indexing-status-trigger')).toContainText('Ready', {
    timeout: 15_000,
  });
  await section.getByRole('button', { exact: true, name: 'Pause indexing' }).click();
  await expect(window.getByTestId('indexing-status-trigger')).toContainText('Paused', {
    timeout: 15_000,
  });
  await expect
    .poll(async () =>
      (await getMainBufferedLogs(window)).some(
        (record) =>
          record.scope === 'NativeIndexWorkflow' &&
          record.message === 'Effect native-index.pause end'
      )
    )
    .toBe(true);
  const records = (await getMainBufferedLogs(window)).filter(
    (record) => record.scope === 'NativeIndexWorkflow'
  );
  const events = records.map((record) => Schema.decodeUnknownSync(Event)(record.args?.[1]));
  const pauseEnd = events.findLast(
    (event) => event.operation === 'native-index.pause' && event.phase === 'end'
  );
  expect(pauseEnd?.outcome).toBe('success');
  if (!pauseEnd) {
    throw new Error('Pause span missing');
  }
  const timeline = events.filter((event) => event.traceId === pauseEnd.traceId);
  expect(
    timeline.filter((event) => event.spanId === pauseEnd.spanId).map((event) => event.phase)
  ).toEqual(['start', 'end']);
  expect(
    timeline.some((event) => event.operation === 'native-index.action' && event.phase === 'end')
  ).toBe(true);
  for (const event of timeline.filter((entry) => entry.parentSpanId)) {
    expect(timeline.some((parent) => parent.spanId === event.parentSpanId)).toBe(true);
  }
  await testInfo.attach('native-index-effect-timeline', {
    body: JSON.stringify({ timeline }, null, 2),
    contentType: 'application/json',
  });
  await new HomePage(window).openSettings();
  const logging = await new SettingsPage(window).openCategory(/Logging & Diagnostics/i, 'logging');
  await logging.getByRole('button', { name: 'Open Logs' }).click();
  const viewer = window.getByRole('region', { name: 'Log Viewer' });
  await viewer.getByPlaceholder('Search logs...').fill(pauseEnd.traceId);
  await expect(viewer.getByText('Effect native-index.pause end', { exact: true })).toBeVisible();
  await viewer
    .getByRole('button', { name: 'View details for Effect native-index.pause end' })
    .click();
  const detail = window.getByRole('dialog');
  await expect(detail).toContainText(pauseEnd.traceId);
  await expect(detail).toContainText(pauseEnd.spanId);
  await window.screenshot({ path: testInfo.outputPath('native-index-effect-log-details.png') });
});
