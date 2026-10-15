// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { shouldRenderAssistantThreadDatabaseStartupLoading } from '../assistant-thread-database-state';

describe('shouldRenderAssistantThreadDatabaseStartupLoading', () => {
  it('shows startup loading while database initialization is idle or in flight', () => {
    expect(
      shouldRenderAssistantThreadDatabaseStartupLoading({
        databaseError: null,
        databaseInitializing: false,
        databaseStatus: 'idle',
        repositoryReady: false,
      })
    ).toBe(true);
    expect(
      shouldRenderAssistantThreadDatabaseStartupLoading({
        databaseError: null,
        databaseInitializing: true,
        databaseStatus: 'initializing',
        repositoryReady: false,
      })
    ).toBe(true);
  });

  it('does not hide settled unavailable or error states behind loading', () => {
    expect(
      shouldRenderAssistantThreadDatabaseStartupLoading({
        databaseError: null,
        databaseInitializing: false,
        databaseStatus: 'ready',
        repositoryReady: false,
      })
    ).toBe(false);
    expect(
      shouldRenderAssistantThreadDatabaseStartupLoading({
        databaseError: new Error('PGlite failed'),
        databaseInitializing: true,
        databaseStatus: 'error',
        repositoryReady: false,
      })
    ).toBe(false);
    expect(
      shouldRenderAssistantThreadDatabaseStartupLoading({
        databaseError: null,
        databaseInitializing: true,
        databaseStatus: 'initializing',
        repositoryReady: true,
      })
    ).toBe(false);
  });
});
