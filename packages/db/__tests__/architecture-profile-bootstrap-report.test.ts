import {
  createProfileBootstrapReport,
  failProfileBootstrapReport,
  getBlockingProfileBootstrapIssues,
  isProfileBootstrapReportReady,
  type ProfileBootstrapCheck,
} from '../src/bootstrap/profile-bootstrap-report.js';

const BASE_RUNTIME = {
  engine: 'pglite',
  host: 'browser',
  persistence: 'memory',
} as const;

function passedRequiredCheck(id: string): ProfileBootstrapCheck {
  return {
    id,
    label: id,
    required: true,
    status: 'passed',
  };
}

describe('profile bootstrap report', () => {
  it('keeps a profile blocked until the phase is ready and every required check passes', () => {
    const report = createProfileBootstrapReport({
      checks: [
        passedRequiredCheck('store.open'),
        {
          id: 'schema.migrated',
          label: 'schema migrated',
          required: true,
          status: 'pending',
        },
      ],
      phase: 'migrating-schema',
      profileId: 'default',
      runtime: BASE_RUNTIME,
      startedAt: '2026-06-21T00:00:00.000Z',
      updatedAt: '2026-06-21T00:00:01.000Z',
    });

    expect(isProfileBootstrapReportReady(report)).toBe(false);
    expect(getBlockingProfileBootstrapIssues(report)).toEqual([
      {
        checkId: 'schema.migrated',
        message: 'Required bootstrap check is pending: schema migrated',
        phase: 'migrating-schema',
        severity: 'blocking',
      },
      {
        checkId: null,
        message: 'Bootstrap phase has not reached ready: migrating-schema',
        phase: 'migrating-schema',
        severity: 'blocking',
      },
    ]);
  });

  it('treats optional check failures as diagnostic but not readiness blocking', () => {
    const report = createProfileBootstrapReport({
      checks: [
        passedRequiredCheck('store.open'),
        passedRequiredCheck('schema.migrated'),
        {
          id: 'search.vector-index-warm',
          label: 'vector index warm',
          message: 'Index will be built by the maintenance lane.',
          required: false,
          status: 'failed',
        },
      ],
      phase: 'ready',
      profileId: 'default',
      runtime: BASE_RUNTIME,
      startedAt: '2026-06-21T00:00:00.000Z',
      updatedAt: '2026-06-21T00:00:02.000Z',
    });

    expect(isProfileBootstrapReportReady(report)).toBe(true);
    expect(getBlockingProfileBootstrapIssues(report)).toEqual([]);
  });

  it('fails closed with a sanitized failure snapshot', () => {
    const report = createProfileBootstrapReport({
      checks: [passedRequiredCheck('store.open')],
      phase: 'opening-store',
      profileId: 'default',
      runtime: BASE_RUNTIME,
      startedAt: '2026-06-21T00:00:00.000Z',
      updatedAt: '2026-06-21T00:00:01.000Z',
    });

    const failed = failProfileBootstrapReport(report, {
      code: 'bootstrap_store_open_failed',
      error: new TypeError('could not open store at /Users/example/profile.db'),
      failedAt: '2026-06-21T00:00:03.000Z',
      phase: 'opening-store',
    });

    expect(failed.phase).toBe('failed');
    expect(failed.ready).toBe(false);
    expect(failed.failure).toEqual({
      code: 'bootstrap_store_open_failed',
      message: 'could not open store at <path>',
      name: 'TypeError',
      phase: 'opening-store',
      timestamp: '2026-06-21T00:00:03.000Z',
    });
    expect(isProfileBootstrapReportReady(failed)).toBe(false);
    expect(getBlockingProfileBootstrapIssues(failed)).toEqual([
      {
        checkId: null,
        message: 'Bootstrap failed during opening-store: could not open store at <path>',
        phase: 'failed',
        severity: 'blocking',
      },
    ]);
  });
});
