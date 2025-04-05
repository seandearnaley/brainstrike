import { Component, type ErrorInfo, type ReactNode } from 'react';
interface Props {
    children: ReactNode;
    fallback?: ReactNode;
    onReset?: () => void;
    onError?: (error: Error, errorInfo: ErrorInfo) => void;
    showDetails?: boolean;
}
interface State {
    hasError: boolean;
    error: Error | null;
    errorInfo: ErrorInfo | null;
    isDetailsVisible: boolean;
}
/**
 * Enhanced ErrorBoundary component that provides specialized error handling
 * for different error types and offers appropriate recovery options.
 */
declare class ErrorBoundary extends Component<Props, State> {
    state: State;
    static getDerivedStateFromError(error: Error): Partial<State>;
    componentDidCatch(error: Error, errorInfo: ErrorInfo): void;
    private handleReload;
    private handleReset;
    private handleToggleDetails;
    private handleCopyErrorDetails;
    private getErrorTypeInfo;
    render(): string | number | bigint | boolean | Iterable<ReactNode> | Promise<string | number | bigint | boolean | import("react").ReactPortal | import("react").ReactElement<unknown, string | import("react").JSXElementConstructor<any>> | Iterable<ReactNode> | null | undefined> | import("react/jsx-runtime").JSX.Element | null | undefined;
}
export default ErrorBoundary;
//# sourceMappingURL=error-boundary.d.ts.map