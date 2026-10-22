import { useNativeWorkspaceSearchDependencies } from '../core/native-workspace-search-context';
import { NativeSearchCoverage } from './native-search-coverage';

export interface SearchCoverageBannerProps {
  collectionId: string | null;
  rootIds: readonly string[];
}

/** Coverage banner for the selected embedding set, projected from the native index owner. */
export function SearchCoverageBanner(props: SearchCoverageBannerProps) {
  const native = useNativeWorkspaceSearchDependencies();
  if (!native) {
    return null;
  }
  return <NativeSearchCoverage {...props} native={native} />;
}
