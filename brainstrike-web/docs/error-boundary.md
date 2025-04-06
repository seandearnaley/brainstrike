# Enhanced Error Boundary Component

This document describes the enhanced Error Boundary component, its features, and how to use it effectively in your application.

## Overview

The enhanced Error Boundary is a React component that catches JavaScript errors anywhere in its child component tree, logs those errors, and displays a fallback UI instead of crashing the entire application. This implementation extends the basic React error boundary with specialized error handling for different error types, improved UI, and additional recovery options.

## Key Features

- **Error Type Detection**: Automatically detects different error types and provides specialized UI and recovery options for each
- **Detailed Error Information**: Shows detailed error information in development mode, including stack traces
- **Recovery Options**: Provides context-specific recovery actions based on the error type
- **Customizable UI**: Allows for custom fallback UI and styling
- **Error Reporting**: Includes "Copy Error Details" functionality for easy sharing and debugging
- **Developer Experience**: Shows component stack traces and detailed error information in development mode

## Supported Error Types

The error boundary provides specialized handling for the following error types:

1. **FSInitializationError**: File system initialization errors
2. **GitOperationError**: Git operation failures
3. **FileContentError**: File content loading errors
4. **ConcurrentLoadingError**: Errors from too many concurrent loading operations
5. **PartialRefreshError**: Partial refresh failures
6. **Generic Errors**: All other error types

## Usage

### Basic Usage

Wrap any component that might throw an error with the ErrorBoundary component:

```jsx
import ErrorBoundary from '@/components/custom/error-boundary';

<ErrorBoundary>
  <YourComponent />
</ErrorBoundary>
```

### With Custom Error Handling

```jsx
<ErrorBoundary
  onError={(error, errorInfo) => {
    // Log error to an error tracking service
    logErrorToService(error, errorInfo);
  }}
  onReset={() => {
    // Handle reset logic here
    resetApplicationState();
  }}
>
  <YourComponent />
</ErrorBoundary>
```

### With Custom Fallback UI

```jsx
<ErrorBoundary
  fallback={<CustomErrorComponent />}
>
  <YourComponent />
</ErrorBoundary>
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `children` | ReactNode | (required) | The components to render |
| `fallback` | ReactNode | `undefined` | Custom fallback UI to display when an error occurs |
| `onReset` | () => void | `undefined` | Callback function called when the error boundary is reset |
| `onError` | (error: Error, errorInfo: ErrorInfo) => void | `undefined` | Callback function called when an error is caught |
| `showDetails` | boolean | `process.env.NODE_ENV === 'development'` | Whether to show detailed error information |

## Error Recovery Actions

The error boundary provides different recovery actions based on the error type:

- **FSInitializationError**: "Request Permissions Again" button
- **GitOperationError**: "Retry Git Operation" button
- **FileContentError**: "Retry Loading" and "Skip File" buttons
- **ConcurrentLoadingError**: "Retry with Fewer Concurrent Operations" button
- **PartialRefreshError**: "Retry Failed Operations" button
- **All Errors**: "Reload Page" and "Go Back" buttons

## Example

See the example component in `src/components/custom/examples/error-boundary-example.tsx` for a complete demonstration of how to use the error boundary with different error types.

## Testing

The error boundary includes comprehensive tests in `src/components/custom/__tests__/error-boundary.test.tsx` that demonstrate how to test error boundaries and verify their behavior with different error types.

## Best Practices

1. **Place Error Boundaries Strategically**: Place error boundaries at logical boundaries in your application to isolate failures to specific sections
2. **Provide Meaningful Recovery Options**: Consider what actions users can take to recover from errors
3. **Log Errors**: Always log errors to an error tracking service to help with debugging
4. **Show Appropriate Information**: Show detailed error information in development, but limit what's shown to users in production
5. **Test Error Scenarios**: Test that your error boundaries correctly catch and handle different error types

## Implementation Details

The enhanced error boundary is implemented as a class component because React's error boundary functionality requires the use of lifecycle methods like `componentDidCatch` and `getDerivedStateFromError`, which are not available in function components.

The component uses a combination of React's error boundary API and custom logic to provide a better error handling experience:

1. `getDerivedStateFromError`: Updates state when an error occurs
2. `componentDidCatch`: Logs errors and calls the `onError` callback
3. `getErrorTypeInfo`: Determines the appropriate UI and actions based on the error type
4. Custom handlers for different recovery actions

## Future Improvements

Potential future improvements to consider:

1. Integration with error tracking services like Sentry
2. More granular error type detection
3. Animated transitions for error states
4. Localization support for error messages
5. Retry mechanisms with exponential backoff for transient errors
