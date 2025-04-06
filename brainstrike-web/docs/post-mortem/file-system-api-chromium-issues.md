# Post-Mortem: File System Access API Issues Across Chromium Browsers

**Date**: January 20, 2025
**Author**: Cascade AI
**Issue**: File System Access API failures in non-Chrome Chromium browsers

## Executive Summary

Despite sharing the same Chromium engine, several Chromium-based browsers experienced failures when using the File System Access API. This post-mortem analyzes the root causes and provides insights into the complex nature of browser API support beyond simple engine compatibility.

## Background

The File System Access API is a modern web API that enables web applications to interact with the user's local file system. While primarily supported in Chromium-based browsers, we discovered that sharing the same engine does not guarantee consistent API behavior across different browser implementations.

## Root Causes Analysis

### 1. Secure Context Requirements

```typescript
if (!window.isSecureContext) {
  return {
    supported: false,
    reason: 'File System Access API requires a secure context (HTTPS)',
  };
}
```

**Impact**: Even Chromium-based browsers would fail if not running in a secure context (HTTPS or localhost). This security requirement is enforced regardless of the browser engine.

**Why It Matters**: 
- Local development environments might not always use HTTPS
- Some deployment environments might not properly configure SSL
- Browser extensions or developer tools might affect the secure context status

### 2. Feature Detection vs. Browser Detection

```typescript
if (typeof window.showDirectoryPicker !== 'function') {
  return {
    supported: false,
    reason: 'File System Access API is not supported in this browser',
  };
}
```

**Impact**: Different Chromium browsers may:
- Disable the API by default
- Modify the API implementation
- Hide the API behind flags or settings
- Implement different versions of the API

**Why It Matters**:
- Browser vendors can customize API availability for security or policy reasons
- Enterprise policies might restrict API access
- Browser settings or user preferences might affect API availability

### 3. Permission Model Variations

```typescript
if (error instanceof Error) {
  if (error.name === 'SecurityError') {
    throw new Error('Permission denied');
  }
  if (error.name === 'AbortError') {
    throw new Error('User cancelled');
  }
}
```

**Impact**: Different Chromium browsers implement varying:
- Permission prompts
- Permission persistence models
- Security policy enforcement
- User interaction requirements

**Why It Matters**:
- Users might experience different permission flows
- Permissions might not persist across sessions
- Security policies might block permissions entirely

### 4. Content Security Policy (CSP) Differences

Different Chromium browsers might implement stricter default CSP settings or handle CSP violations differently. This affects:
- API availability
- Permission handling
- Resource access
- Script execution context

## Solutions Implemented

1. **Robust Feature Detection**
   - Implemented proper feature detection instead of browser detection
   - Added comprehensive error handling for various failure scenarios
   - Included secure context verification

2. **Enhanced Error Handling**
   - Created specific error types for different failure scenarios
   - Improved error messages for better debugging
   - Added fallback mechanisms where possible

3. **Security-First Approach**
   - Verified secure context requirements
   - Implemented proper permission handling
   - Added CSP compatibility checks

## Recommendations

1. **Development Environment**
   - Always test in multiple Chromium-based browsers
   - Use proper HTTPS setup in development
   - Test with various security settings

2. **Code Implementation**
   - Use feature detection instead of browser detection
   - Implement robust error handling
   - Provide clear feedback for permission states
   - Add fallback mechanisms where possible

3. **Testing**
   - Test in different security contexts
   - Verify behavior with different permission states
   - Check enterprise policy impacts
   - Test with various CSP configurations

4. **Documentation**
   - Document browser-specific requirements
   - Maintain a compatibility matrix
   - Update troubleshooting guides
   - Document known limitations

## Future Considerations

1. **Browser Support**
   - Monitor changes in Chromium implementations
   - Track browser vendor policies
   - Stay updated with Web API standards

2. **Security**
   - Regular security audits
   - CSP refinements
   - Permission model updates

3. **User Experience**
   - Improve error messaging
   - Enhance permission flow
   - Add better fallback experiences

## Lessons Learned

1. Don't assume API consistency across same-engine browsers
2. Implement thorough feature detection
3. Consider security context variations
4. Plan for permission model differences
5. Test across multiple Chromium implementations

## Related Documentation

- [File System Access API Specification](https://wicg.github.io/file-system-access/)
- [MDN Web Docs - File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
- [Chrome Platform Status](https://www.chromestatus.com/feature/6284708426022912)
