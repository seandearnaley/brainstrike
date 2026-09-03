import {
  type AuthProvider,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';

const MAX_STEP_UP_RETRIES = 3;
const DEFAULT_AUTHORIZATION_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_AUTHORIZATION_CALLBACK_TIMEOUT_MS = 30 * 60 * 1000;
const AUTHORIZATION_CANCELLED_MESSAGE = 'MCP OAuth authorization callback was cancelled';
const AUTHORIZATION_LIMIT_MESSAGE = 'MCP OAuth authorization request limit reached';
const AUTHORIZATION_SETUP_MESSAGE = 'MCP OAuth authorization setup failed';
const AUTHORIZATION_STATE_MESSAGE = 'MCP OAuth authorization callback state did not match';
const AUTHORIZATION_TIMEOUT_MESSAGE = 'MCP OAuth authorization callback timed out';

export interface ExplicitHttpMcpAuthorizationCallbackSource {
  takePendingAuthorizationCallback: (signal: AbortSignal) => Promise<URLSearchParams> | undefined;
}

export function assertOAuthHeaderCompatibility(
  clientName: string,
  authProvider: AuthProvider | OAuthClientProvider | undefined,
  headers: Readonly<Record<string, string>> | undefined
): void {
  if (
    authProvider &&
    Object.keys(headers ?? {}).some((name) => name.toLowerCase() === 'authorization')
  ) {
    throw new Error(
      `MCP client "${clientName}" must not combine configured Authorization headers with authProvider`
    );
  }
}

export interface InteractiveOAuthCompletion {
  readonly authProvider: OAuthClientProvider;
  close: () => void;
  completeRequestAuthorization: (
    primaryError: unknown,
    transport: StreamableHTTPClientTransport,
    signal: AbortSignal | undefined,
    operation: InteractiveOAuthOperation,
    invalidate: () => void,
    cleanup: () => Promise<void>
  ) => Promise<boolean>;
  getAuthorizationSignal: () => AbortSignal | undefined;
  handleOpeningFailure: <T>(
    options: InteractiveOAuthOpeningFailureOptions<T>,
    operation: InteractiveOAuthOperation
  ) => Promise<T>;
  runOperation: <T>(operation: (context: InteractiveOAuthOperation) => Promise<T>) => Promise<T>;
}

export interface InteractiveOAuthOperation {
  authorizationRequests: number;
}

export async function tryCompleteInteractiveOAuthRequestAuthorization(options: {
  readonly cleanup: () => Promise<void>;
  readonly completion: InteractiveOAuthCompletion | undefined;
  readonly invalidate: () => void;
  readonly operation: InteractiveOAuthOperation | undefined;
  readonly primaryError: unknown;
  readonly signal: AbortSignal | undefined;
  readonly transport: unknown;
}): Promise<boolean> {
  if (!options.completion) {
    return false;
  }
  if (!options.operation) {
    throw new Error('Interactive OAuth request lost its operation context');
  }
  if (!(options.transport instanceof StreamableHTTPClientTransport)) {
    throw new AggregateError(
      [options.primaryError, new Error('Interactive OAuth requires a Streamable HTTP transport')],
      'MCP request failed with an invalid interactive OAuth transport'
    );
  }
  return options.completion.completeRequestAuthorization(
    options.primaryError,
    options.transport,
    options.signal,
    options.operation,
    options.invalidate,
    options.cleanup
  );
}

interface InteractiveOAuthOpeningFailureOptions<T> {
  readonly cleanup: () => Promise<void>;
  readonly closedError: () => Error;
  readonly isClosed: () => boolean;
  readonly primaryError: unknown;
  readonly reconnect: () => Promise<T>;
  readonly signal?: AbortSignal;
  readonly terminalCleanup: () => Promise<void> | undefined;
  readonly transport: StreamableHTTPClientTransport;
}

export function normalizeOAuthStepUpOptions(options: {
  readonly maxStepUpRetries?: number;
  readonly onInsufficientScope?: 'reauthorize' | 'throw';
  readonly transport: 'sse' | 'streamable-http';
}): {
  readonly maxStepUpRetries?: number;
  readonly onInsufficientScope?: 'reauthorize' | 'throw';
} {
  if (
    options.transport === 'sse' &&
    (options.maxStepUpRetries !== undefined || options.onInsufficientScope !== undefined)
  ) {
    throw new Error('MCP OAuth scope step-up options require Streamable HTTP transport');
  }
  const retries = options.maxStepUpRetries;
  if (
    retries !== undefined &&
    (!Number.isSafeInteger(retries) || retries < 0 || retries > MAX_STEP_UP_RETRIES)
  ) {
    throw new Error(
      `MCP OAuth step-up retries must be a safe integer from 0 to ${MAX_STEP_UP_RETRIES}`
    );
  }
  return {
    ...(retries === undefined ? {} : { maxStepUpRetries: retries }),
    ...(options.onInsufficientScope === undefined
      ? {}
      : { onInsufficientScope: options.onInsufficientScope }),
  };
}

function normalizeAuthorizationCallbackTimeoutMs(value: unknown): number {
  const timeoutMs = value ?? DEFAULT_AUTHORIZATION_CALLBACK_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_AUTHORIZATION_CALLBACK_TIMEOUT_MS
  ) {
    throw new Error(
      `MCP OAuth authorization callback timeout must be a positive safe integer at most ${MAX_AUTHORIZATION_CALLBACK_TIMEOUT_MS}`
    );
  }
  return timeoutMs;
}

function authorizationFailure(primary: unknown, message: string): AggregateError {
  return new AggregateError([primary, new Error(message)], `MCP connection failed and ${message}`);
}

interface AuthorizationFlight {
  readonly abortController: AbortController;
  cleanupPromise?: Promise<void>;
  readonly promise: Promise<void>;
  readonly setup: AuthorizationSetup;
  waiters: number;
}

interface AuthorizationSetup {
  codeVerifier?: string;
  codeVerifierSavePromise?: Promise<void>;
  readonly controller: AbortController;
  redirect?: URL;
  readonly redirectCaptured: Promise<void>;
  readonly rejectRedirectCaptured: (reason: unknown) => void;
  readonly resolveRedirectCaptured: () => void;
  readonly signal: AbortSignal;
  state?: string;
  statePromise?: Promise<string>;
  timedOut: boolean;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
}

type InteractiveOAuthProvider = OAuthClientProvider & {
  invalidateCredentials: NonNullable<OAuthClientProvider['invalidateCredentials']>;
};

class AuthorizationCallerFailure extends Error {
  constructor(readonly failure: AggregateError) {
    super('MCP OAuth authorization caller failed');
  }
}

class AuthorizationFlightFailure extends Error {
  constructor(
    readonly flight: AuthorizationFlight,
    readonly failure: AggregateError,
    readonly callerCancelled: boolean
  ) {
    super('MCP OAuth authorization flight failed');
  }
}

async function cleanupPreservingFailure(
  primary: unknown,
  cleanup: Promise<void> | undefined,
  message: string
): Promise<void> {
  try {
    await cleanup;
  } catch (cleanupError) {
    throw new AggregateError([primary, cleanupError], message);
  }
}

function isOAuthClientProvider(value: unknown): value is InteractiveOAuthProvider {
  const provider = value as Partial<OAuthClientProvider>;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof provider.clientInformation === 'function' &&
    typeof provider.invalidateCredentials === 'function' &&
    typeof provider.redirectToAuthorization === 'function' &&
    typeof provider.tokens === 'function'
  );
}

async function waitForAuthorizationValue<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let removeAbortListener = (): void => undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      value.then(resolve, reject);
    });
  } finally {
    removeAbortListener();
  }
}

function authorizationStepFailure(
  setup: AuthorizationSetup,
  signal: AbortSignal,
  fallback: string
): Error {
  if (setup.timedOut) {
    return new Error(AUTHORIZATION_TIMEOUT_MESSAGE);
  }
  if (signal.aborted) {
    return new Error(AUTHORIZATION_CANCELLED_MESSAGE);
  }
  return new Error(fallback);
}

async function waitForAuthorizationStep<T>(
  value: Promise<T>,
  setup: AuthorizationSetup,
  signal: AbortSignal,
  fallback: string
): Promise<T> {
  try {
    return await waitForAuthorizationValue(value, signal);
  } catch {
    throw authorizationStepFailure(setup, signal, fallback);
  }
}

class OwnedInteractiveOAuthCompletion implements InteractiveOAuthCompletion {
  private readonly abortController = new AbortController();
  private authorizationFlight: AuthorizationFlight | undefined;
  private authorizationSetup: AuthorizationSetup | undefined;
  private tokenExchangeSetup: AuthorizationSetup | undefined;
  readonly authProvider: OAuthClientProvider;

  constructor(
    private readonly provider: InteractiveOAuthProvider,
    private readonly callbackSource: ExplicitHttpMcpAuthorizationCallbackSource,
    private readonly callbackTimeoutMs: number,
    private readonly maxAuthorizationRequests: number
  ) {
    this.authProvider = new Proxy(provider, {
      get: (target, property) => {
        const state = target.state;
        if (property === 'state' && state) {
          return async (): Promise<string> => {
            const setup = this.getAuthorizationSetup();
            if (setup.statePromise) {
              return setup.statePromise;
            }
            let statePromise: Promise<string>;
            try {
              statePromise = waitForAuthorizationValue(
                Promise.resolve(state.call(target)),
                setup.signal
              );
            } catch {
              const failure = this.authorizationSetupFailure(setup);
              this.failAuthorizationSetup(setup, failure);
              throw failure;
            }
            setup.statePromise = statePromise;
            try {
              return await statePromise;
            } catch {
              const failure = this.authorizationSetupFailure(setup);
              this.failAuthorizationSetup(setup, failure);
              throw failure;
            }
          };
        }
        if (property === 'saveCodeVerifier') {
          return async (codeVerifier: string): Promise<void> => {
            const setup = this.getAuthorizationSetup();
            if (setup.codeVerifierSavePromise) {
              await setup.redirectCaptured;
              return;
            }
            setup.codeVerifier = codeVerifier;
            try {
              setup.signal.throwIfAborted();
              const savePromise = waitForAuthorizationValue(
                Promise.resolve(target.saveCodeVerifier(codeVerifier)),
                setup.signal
              );
              setup.codeVerifierSavePromise = savePromise;
              await savePromise;
            } catch {
              const failure = this.authorizationSetupFailure(setup);
              this.failAuthorizationSetup(setup, failure);
              throw failure;
            }
          };
        }
        const codeVerifier = this.authorizationSetup?.codeVerifier;
        if (property === 'codeVerifier' && codeVerifier !== undefined) {
          return async (): Promise<string> => codeVerifier;
        }
        if (property === 'redirectToAuthorization') {
          return async (authorizationUrl: URL): Promise<void> => {
            const currentSetup = this.getAuthorizationSetup();
            if (currentSetup.redirect) {
              return;
            }
            currentSetup.signal.throwIfAborted();
            currentSetup.redirect = authorizationUrl;
            const authorizationState = authorizationUrl.searchParams.get('state');
            if (authorizationState !== null) {
              currentSetup.state = authorizationState;
            }
            currentSetup.resolveRedirectCaptured();
          };
        }
        if (property === 'saveTokens') {
          return async (...args: Parameters<OAuthClientProvider['saveTokens']>): Promise<void> => {
            const currentSetup = this.tokenExchangeSetup;
            if (!currentSetup) {
              await target.saveTokens(...args);
              return;
            }
            currentSetup.signal.throwIfAborted();
            const savePromise = Promise.resolve(target.saveTokens(...args));
            try {
              await waitForAuthorizationValue(savePromise, currentSetup.signal);
            } catch (error) {
              if (currentSetup.signal.aborted) {
                this.invalidateLateTokenSave(currentSetup, savePromise);
              }
              throw error;
            }
            if (
              currentSetup.signal.aborted ||
              this.authorizationSetup !== currentSetup ||
              this.tokenExchangeSetup !== currentSetup
            ) {
              await target.invalidateCredentials('tokens');
              currentSetup.signal.throwIfAborted();
              throw new Error(AUTHORIZATION_CANCELLED_MESSAGE);
            }
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  close(): void {
    this.abortController.abort(new Error(AUTHORIZATION_CANCELLED_MESSAGE));
    const setup = this.authorizationSetup;
    if (setup) {
      this.failAuthorizationSetup(setup, new Error(AUTHORIZATION_CANCELLED_MESSAGE));
    }
  }

  getAuthorizationSignal(): AbortSignal | undefined {
    return this.tokenExchangeSetup?.signal ?? this.authorizationSetup?.signal;
  }

  async runOperation<T>(operation: (context: InteractiveOAuthOperation) => Promise<T>): Promise<T> {
    return operation({ authorizationRequests: 0 });
  }

  private getAuthorizationSetup(): AuthorizationSetup {
    const existing = this.authorizationSetup;
    if (existing) {
      return existing;
    }
    const controller = new AbortController();
    let rejectRedirectCaptured = (_reason: unknown): void => undefined;
    let resolveRedirectCaptured = (): void => undefined;
    const redirectCaptured = new Promise<void>((resolve, reject) => {
      rejectRedirectCaptured = reject;
      resolveRedirectCaptured = resolve;
    });
    void redirectCaptured.catch(() => undefined);
    const setup: AuthorizationSetup = {
      controller,
      redirectCaptured,
      rejectRedirectCaptured,
      resolveRedirectCaptured,
      signal: AbortSignal.any([controller.signal, this.abortController.signal]),
      timedOut: false,
      timeoutId: undefined,
    };
    setup.timeoutId = setTimeout(() => {
      setup.timedOut = true;
      controller.abort(new Error(AUTHORIZATION_TIMEOUT_MESSAGE));
    }, this.callbackTimeoutMs);
    this.authorizationSetup = setup;
    return setup;
  }

  private authorizationSetupFailure(setup: AuthorizationSetup): Error {
    if (setup.timedOut) {
      return new Error(AUTHORIZATION_TIMEOUT_MESSAGE);
    }
    if (this.abortController.signal.aborted) {
      return new Error(AUTHORIZATION_CANCELLED_MESSAGE);
    }
    return new Error(AUTHORIZATION_SETUP_MESSAGE);
  }

  private clearAuthorizationSetup(setup: AuthorizationSetup): void {
    if (setup.timeoutId) {
      clearTimeout(setup.timeoutId);
      setup.timeoutId = undefined;
    }
    if (this.authorizationSetup === setup) {
      this.authorizationSetup = undefined;
    }
    if (this.tokenExchangeSetup === setup) {
      this.tokenExchangeSetup = undefined;
    }
  }

  private failAuthorizationSetup(setup: AuthorizationSetup, error: unknown): void {
    setup.rejectRedirectCaptured(error);
    if (!setup.controller.signal.aborted) {
      setup.controller.abort(error);
    }
    this.clearAuthorizationSetup(setup);
  }

  private invalidateLateTokenSave(setup: AuthorizationSetup, savePromise: Promise<void>): void {
    void savePromise
      .then(async () => {
        if (setup.signal.aborted || this.authorizationSetup !== setup) {
          await this.provider.invalidateCredentials('tokens');
        }
      })
      .catch(() => undefined);
  }

  private async completePendingAuthorization(
    primaryError: unknown,
    transport: StreamableHTTPClientTransport,
    operation: InteractiveOAuthOperation,
    callerSignal?: AbortSignal
  ): Promise<boolean> {
    if (!(primaryError instanceof UnauthorizedError)) {
      const staleSetup = this.authorizationSetup;
      if (staleSetup && !this.authorizationFlight) {
        this.failAuthorizationSetup(staleSetup, primaryError);
      }
      return false;
    }
    if (callerSignal?.aborted) {
      throw new AuthorizationCallerFailure(
        authorizationFailure(primaryError, AUTHORIZATION_CANCELLED_MESSAGE)
      );
    }
    const existingFlight = this.authorizationFlight;
    const setup = existingFlight?.setup ?? this.authorizationSetup;
    if (!(existingFlight || setup?.redirect)) {
      if (setup) {
        this.failAuthorizationSetup(
          setup,
          new Error('MCP OAuth authorization setup ended before redirect')
        );
      }
      return false;
    }
    if (operation.authorizationRequests >= this.maxAuthorizationRequests) {
      if (existingFlight) {
        throw new AuthorizationCallerFailure(
          authorizationFailure(primaryError, AUTHORIZATION_LIMIT_MESSAGE)
        );
      }
      if (setup) {
        this.failAuthorizationSetup(setup, new Error(AUTHORIZATION_LIMIT_MESSAGE));
      }
      throw authorizationFailure(primaryError, AUTHORIZATION_LIMIT_MESSAGE);
    }
    operation.authorizationRequests += 1;
    if (existingFlight) {
      await this.awaitAuthorizationFlight(existingFlight, primaryError, callerSignal);
      return true;
    }
    if (!setup?.redirect) {
      return false;
    }
    setup.signal.throwIfAborted();
    const flightAbortController = new AbortController();
    const signal = AbortSignal.any([flightAbortController.signal, setup.signal]);
    if (signal.aborted) {
      throw authorizationFailure(
        primaryError,
        setup.timedOut ? AUTHORIZATION_TIMEOUT_MESSAGE : AUTHORIZATION_CANCELLED_MESSAGE
      );
    }

    const flight: AuthorizationFlight = {
      abortController: flightAbortController,
      promise: this.finishAuthorization(setup, transport, signal),
      setup,
      waiters: 0,
    };
    this.authorizationFlight = flight;
    void flight.promise.then(
      () => this.clearAuthorizationFlight(flight),
      () => this.clearAuthorizationFlight(flight)
    );
    await this.awaitAuthorizationFlight(flight, primaryError, callerSignal);
    return true;
  }

  private clearAuthorizationFlight(flight: AuthorizationFlight): void {
    if (this.authorizationFlight === flight) {
      this.authorizationFlight = undefined;
      this.clearAuthorizationSetup(flight.setup);
    }
  }

  private async finishAuthorization(
    setup: AuthorizationSetup,
    transport: StreamableHTTPClientTransport,
    signal: AbortSignal
  ): Promise<void> {
    const authorizationUrl = setup.redirect;
    if (!authorizationUrl) {
      throw new Error('MCP OAuth authorization redirect was not captured');
    }
    await waitForAuthorizationStep(
      Promise.resolve(this.provider.redirectToAuthorization(authorizationUrl)),
      setup,
      signal,
      'MCP OAuth authorization redirect failed'
    );
    let callbackPromise: Promise<URLSearchParams> | undefined;
    try {
      callbackPromise = this.callbackSource.takePendingAuthorizationCallback(signal);
    } catch {
      throw new Error('MCP OAuth authorization callback failed');
    }
    if (!callbackPromise) {
      throw new Error('MCP OAuth authorization callback was not available after redirect');
    }
    const callbackParams = await waitForAuthorizationStep(
      callbackPromise,
      setup,
      signal,
      'MCP OAuth authorization callback failed'
    );
    const expectedState = setup.state;
    if (expectedState !== undefined && callbackParams.get('state') !== expectedState) {
      throw new Error(AUTHORIZATION_STATE_MESSAGE);
    }
    try {
      this.tokenExchangeSetup = setup;
      await waitForAuthorizationStep(
        transport.finishAuth(callbackParams),
        setup,
        signal,
        'MCP OAuth authorization completion failed'
      );
    } finally {
      if (this.tokenExchangeSetup === setup) {
        this.tokenExchangeSetup = undefined;
      }
    }
    if (setup.timedOut) {
      throw new Error(AUTHORIZATION_TIMEOUT_MESSAGE);
    }
    if (signal.aborted) {
      throw new Error(AUTHORIZATION_CANCELLED_MESSAGE);
    }
  }

  private async awaitAuthorizationFlight(
    flight: AuthorizationFlight,
    primaryError: unknown,
    callerSignal?: AbortSignal
  ): Promise<void> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.abortController.signal])
      : this.abortController.signal;
    flight.waiters += 1;
    let caught = false;
    let caughtError: unknown;
    try {
      await waitForAuthorizationValue(flight.promise, signal);
    } catch (error) {
      caught = true;
      caughtError = error;
    } finally {
      flight.waiters -= 1;
      if (callerSignal?.aborted && flight.waiters === 0) {
        flight.abortController.abort(new Error(AUTHORIZATION_CANCELLED_MESSAGE));
      }
    }
    if (!caught) {
      return;
    }
    const callerCancelled = callerSignal?.aborted === true && !this.abortController.signal.aborted;
    const message = callerCancelled
      ? AUTHORIZATION_CANCELLED_MESSAGE
      : flight.setup.timedOut
        ? AUTHORIZATION_TIMEOUT_MESSAGE
        : this.abortController.signal.aborted
          ? AUTHORIZATION_CANCELLED_MESSAGE
          : caughtError instanceof Error
            ? caughtError.message
            : 'MCP OAuth authorization callback failed';
    throw new AuthorizationFlightFailure(
      flight,
      authorizationFailure(primaryError, message),
      callerCancelled
    );
  }

  async completeRequestAuthorization(
    primaryError: unknown,
    transport: StreamableHTTPClientTransport,
    signal: AbortSignal | undefined,
    operation: InteractiveOAuthOperation,
    invalidate: () => void,
    cleanup: () => Promise<void>
  ): Promise<boolean> {
    try {
      return await this.completePendingAuthorization(primaryError, transport, operation, signal);
    } catch (failure) {
      if (failure instanceof AuthorizationCallerFailure) {
        throw failure.failure;
      }
      if (failure instanceof AuthorizationFlightFailure) {
        if (failure.callerCancelled || this.abortController.signal.aborted) {
          throw failure.failure;
        }
        return this.cleanupFailedAuthorizationFlight(failure, invalidate, cleanup);
      }
      if (this.abortController.signal.aborted) {
        throw failure;
      }
      invalidate();
      await cleanupPreservingFailure(
        failure,
        cleanup(),
        'MCP OAuth authorization and owned connection cleanup both failed'
      );
      throw failure;
    }
  }

  private async cleanupFailedAuthorizationFlight(
    failure: AuthorizationFlightFailure,
    invalidate: () => void,
    cleanup: () => Promise<void>
  ): Promise<never> {
    const { flight } = failure;
    flight.cleanupPromise ??= (async () => {
      await flight.promise.catch(() => undefined);
      if (this.abortController.signal.aborted) {
        throw failure.failure;
      }
      invalidate();
      await cleanupPreservingFailure(
        failure.failure,
        cleanup(),
        'MCP OAuth authorization and owned connection cleanup both failed'
      );
    })();
    await flight.cleanupPromise;
    throw failure.failure;
  }

  async handleOpeningFailure<T>(
    options: InteractiveOAuthOpeningFailureOptions<T>,
    operation: InteractiveOAuthOperation
  ): Promise<T> {
    let failure = options.primaryError;
    let completed = false;
    try {
      completed = await this.completePendingAuthorization(
        options.primaryError,
        options.transport,
        operation,
        options.signal
      );
    } catch (interactiveFailure) {
      failure =
        interactiveFailure instanceof AuthorizationCallerFailure ||
        interactiveFailure instanceof AuthorizationFlightFailure
          ? interactiveFailure.failure
          : interactiveFailure;
    }
    if (options.signal?.aborted && failure === options.primaryError) {
      failure = authorizationFailure(options.primaryError, AUTHORIZATION_CANCELLED_MESSAGE);
    }
    if (options.isClosed()) {
      await cleanupPreservingFailure(
        failure,
        options.terminalCleanup(),
        'Opening and cleaning up an MCP HTTP connection both failed'
      );
      throw failure;
    }
    await cleanupPreservingFailure(
      failure,
      options.cleanup(),
      completed
        ? 'Opening and cleaning up an authorized MCP HTTP connection both failed'
        : 'Opening and cleaning up an MCP HTTP connection both failed'
    );
    if (failure !== options.primaryError) {
      throw failure;
    }
    if (!completed) {
      options.signal?.throwIfAborted();
      throw options.primaryError;
    }
    if (options.isClosed()) {
      throw options.closedError();
    }
    return options.reconnect();
  }
}

export function createInteractiveOAuthCompletion(
  clientName: string,
  options: {
    readonly authProvider?: AuthProvider | OAuthClientProvider;
    readonly authorizationCallbackTimeoutMs?: number;
    readonly authorizationCallbackSource?: ExplicitHttpMcpAuthorizationCallbackSource;
    readonly maxStepUpRetries?: number;
    readonly transport: 'sse' | 'streamable-http';
  }
): InteractiveOAuthCompletion | undefined {
  const { authProvider, authorizationCallbackSource: callbackSource, transport } = options;
  if (callbackSource === undefined) {
    // The timeout is only ever read below, so without a callback source it can
    // never take effect on any transport. Refuse it rather than accept an
    // option that silently does nothing.
    if (options.authorizationCallbackTimeoutMs !== undefined) {
      throw new Error(
        `MCP client "${clientName}": authorizationCallbackTimeoutMs requires authorizationCallbackSource`
      );
    }
    return;
  }
  if (transport !== 'streamable-http') {
    throw new Error(
      `MCP client "${clientName}": interactive OAuth completion requires Streamable HTTP transport`
    );
  }
  if (!isOAuthClientProvider(authProvider)) {
    throw new Error(
      `MCP client "${clientName}": interactive OAuth completion requires an OAuthClientProvider`
    );
  }
  return new OwnedInteractiveOAuthCompletion(
    authProvider,
    callbackSource,
    normalizeAuthorizationCallbackTimeoutMs(options.authorizationCallbackTimeoutMs),
    Math.max(1, options.maxStepUpRetries ?? 1)
  );
}
