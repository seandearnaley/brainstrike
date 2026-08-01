import { Component, type ReactNode } from 'react';
import { BrainstrikeMark } from './brainstrike-mark';

interface SiteErrorBoundaryProps {
  readonly children: ReactNode;
}

interface SiteErrorBoundaryState {
  readonly error: string | null;
}

// biome-ignore lint/style/useReactFunctionComponents: React exposes error-boundary lifecycle APIs only to class components.
export class SiteErrorBoundary extends Component<SiteErrorBoundaryProps, SiteErrorBoundaryState> {
  override state: SiteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): SiteErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <main className="site-fatal" role="alert">
        <BrainstrikeMark className="brand-mark" />
        <p className="eyebrow">INTERFACE / HALTED</p>
        <h1>The product interface stopped.</h1>
        <p>{this.state.error}</p>
        <button onClick={() => window.location.reload()} type="button">
          Reload the site
        </button>
      </main>
    );
  }
}
