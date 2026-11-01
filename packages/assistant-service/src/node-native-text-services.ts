export type {
  NativeAcknowledgedPublication,
  NativeScopeReadiness,
} from '@brainstrike/canonical-ingestion';
export {
  NATIVE_COVERAGE_OBSERVATION_INVALIDATED,
  NativeAuthorityTransitionError,
  NativeIndexRefusalError,
  NativeIndexSetupRequiredError,
} from './node-native-index/errors.ts';
export {
  createNativeIndexSearchCapability,
  grepSnapshot,
} from './node-native-index/index-search.ts';
export {
  createNativeScopedSearchCapability,
  type NativeScopedRead,
  type NativeScopedSearchDependencies,
  type NativeSearchAuthority,
} from './node-native-index/scoped-search.ts';
