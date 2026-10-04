export const NATIVE_COVERAGE_OBSERVATION_INVALIDATED = 'native-coverage-observation-invalidated';

/** The admitted coverage observation lost its source/readiness fence; it contains no result. */
export class NativeCoverageObservationInvalidatedError extends Error {
  readonly code = NATIVE_COVERAGE_OBSERVATION_INVALIDATED;

  constructor() {
    super('Native source or saved profile changed during search.');
    this.name = 'NativeCoverageObservationInvalidatedError';
  }
}
