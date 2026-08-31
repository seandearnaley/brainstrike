import type {
  ClientCapabilities,
  JSONObject,
  JSONRPCMessage,
  JSONRPCRequest,
  StandardSchemaV1,
} from '@modelcontextprotocol/client';

const EXTENSION_ID_PATTERN =
  /^(?:[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const EXTENSION_METHOD_PATTERN = /^(?!rpc\.)(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+$/u;
const INTERNAL_EXTENSION_METHOD_PREFIX = 'io.brainstrike/registered-extension/';
const RESERVED_METHOD_NAMESPACE =
  /^(?:completion|elicitation|logging|notifications|prompts|resources|roots|sampling|server|subscriptions|tools)\//u;

export interface McpClientExtensionRequestContract<
  Params extends JSONObject = JSONObject,
  Result = unknown,
> {
  readonly mcpNameParam?: keyof Params & string;
  readonly method: string;
  readonly paramsSchema: StandardSchemaV1<unknown, Params>;
  readonly protocol: '2026-07-28';
  readonly resultSchema: StandardSchemaV1<unknown, Result>;
}

export interface McpClientExtensionContract<
  Version extends string,
  Settings extends JSONObject,
  Implementation,
> {
  readonly id: string;
  readonly isCompleteImplementation: (value: unknown) => value is Implementation;
  readonly isServerSettingsCompatible?: (client: Settings, server: Settings) => boolean;
  readonly parseServerSettings?: (value: unknown) => Settings;
  readonly parseSettings: (value: unknown) => Settings;
  readonly requests?: readonly McpClientExtensionRequestContract[];
  readonly version: Version;
}

export interface McpClientExtensionRegistration<
  Version extends string,
  Settings extends JSONObject,
  Implementation,
> {
  readonly implementation: Implementation;
  readonly settings: Settings;
  readonly version: Version;
}

export type McpClientExtensionCapabilities = NonNullable<ClientCapabilities['extensions']>;

interface RegisteredExtensionRequest<Params extends JSONObject = JSONObject, Result = unknown> {
  readonly assertServerSettingsCompatible?: (
    clientSettings: JSONObject,
    serverSettings: unknown
  ) => void;
  readonly contractIdentity: object;
  readonly extensionId: string;
  readonly internalMethod: string;
  readonly mcpNameParam?: keyof Params & string;
  readonly paramsSchema: StandardSchemaV1<unknown, Params>;
  readonly protocol: '2026-07-28';
  readonly resultSchema: StandardSchemaV1<unknown, Result>;
  readonly wireMethod: string;
}

export interface PreparedMcpClientExtensionRequest<Result> {
  readonly internalMethod: string;
  readonly params: JSONObject;
  readonly resultSchema: StandardSchemaV1<unknown, Result>;
}

function assertMcpClientExtensionProtocol(
  contract: Pick<McpClientExtensionRequestContract, 'method' | 'protocol'>,
  negotiatedProtocol: string | undefined
): void {
  if (negotiatedProtocol !== contract.protocol) {
    throw new Error(
      `MCP extension request "${contract.method}" requires protocol ${contract.protocol}; negotiated ${String(negotiatedProtocol)}`
    );
  }
}

function isJsonRpcRequest(message: JSONRPCMessage): message is JSONRPCRequest {
  return 'method' in message && 'id' in message;
}

function assertStandardSchema(value: unknown, label: string): asserts value is StandardSchemaV1 {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('~standard' in value) ||
    typeof value['~standard'] !== 'object' ||
    value['~standard'] === null ||
    !('validate' in value['~standard']) ||
    typeof value['~standard'].validate !== 'function'
  ) {
    throw new Error(`${label} must implement Standard Schema V1`);
  }
}

async function parseWithSchema<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
  label: string
): Promise<Output> {
  const parsed = await schema['~standard'].validate(value);
  if (parsed.issues) {
    throw new Error(`${label} failed schema validation`);
  }
  return parsed.value;
}

function internalMethod(extensionId: string, method: string): string {
  return `${INTERNAL_EXTENSION_METHOD_PREFIX}${extensionId}/${method}`;
}

function assertRequestMethod(method: string, protocol: unknown, extensionId: string): void {
  if (protocol !== '2026-07-28') {
    throw new Error(
      `MCP extension request "${method}" requires unsupported protocol "${String(protocol)}"`
    );
  }
  if (!EXTENSION_METHOD_PATTERN.test(method)) {
    throw new Error(`Invalid MCP extension request method "${method}" for "${extensionId}"`);
  }
  if (
    method.startsWith(INTERNAL_EXTENSION_METHOD_PREFIX) ||
    RESERVED_METHOD_NAMESPACE.test(method)
  ) {
    throw new Error(
      `MCP extension request method "${method}" uses a reserved MCP method namespace`
    );
  }
}

function cloneFrozenJsonValue(value: unknown, label: string, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must contain only finite JSON numbers`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error(`${label} must contain only JSON values`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} must be an acyclic JSON object`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((child, index) => cloneFrozenJsonValue(child, `${label}[${index}]`, ancestors))
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain JSON objects`);
    }
    const cloned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      cloned[key] = cloneFrozenJsonValue(child, `${label}.${key}`, ancestors);
    }
    return Object.freeze(cloned);
  } finally {
    ancestors.delete(value);
  }
}

function freezeJsonObject(value: JSONObject, extensionId: string): JSONObject {
  const cloned = cloneFrozenJsonValue(
    value,
    `MCP client extension "${extensionId}" settings`,
    new WeakSet()
  );
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) {
    throw new Error(`MCP client extension "${extensionId}" settings must be a JSON object`);
  }
  return cloned as JSONObject;
}

/** Host-owned registry for extensions whose complete implementation is installed. */
export class McpClientExtensionRegistry {
  private readonly extensions = new Map<string, () => JSONObject>();
  private readonly requestsByContract = new Map<object, RegisteredExtensionRequest>();
  private readonly requestsByInternalMethod = new Map<string, RegisteredExtensionRequest>();
  private readonly requestsByWireMethod = new Map<string, RegisteredExtensionRequest>();
  private sealed = false;
  private sealedCapabilities: McpClientExtensionCapabilities | undefined;
  private sealedSettings: ReadonlyMap<string, JSONObject> = new Map();

  register<Version extends string, Settings extends JSONObject, Implementation>(
    contract: McpClientExtensionContract<Version, Settings, Implementation>,
    registration: McpClientExtensionRegistration<Version, Settings, Implementation>
  ): void {
    if (this.sealed) {
      throw new Error('MCP client extension registry is sealed for an active connection');
    }
    if (!EXTENSION_ID_PATTERN.test(contract.id)) {
      throw new Error(`Invalid MCP client extension identifier "${contract.id}"`);
    }
    if (this.extensions.has(contract.id)) {
      throw new Error(`MCP client extension "${contract.id}" is already registered`);
    }
    const project = (): JSONObject => {
      if (registration.version !== contract.version) {
        throw new Error(
          `MCP client extension "${contract.id}" requires version "${contract.version}"`
        );
      }
      const settings = contract.parseSettings(registration.settings);
      if (!contract.isCompleteImplementation(registration.implementation)) {
        throw new Error(
          `MCP client extension "${contract.id}" does not have a complete host implementation`
        );
      }
      return settings;
    };
    project();

    const requests = contract.requests ?? [];
    const parseServerSettings = contract.parseServerSettings;
    const isServerSettingsCompatible = contract.isServerSettingsCompatible;
    if (requests.length > 0 && parseServerSettings === undefined) {
      throw new Error(
        `MCP client extension "${contract.id}" must validate server settings before registering requests`
      );
    }
    if (requests.length > 0 && isServerSettingsCompatible === undefined) {
      throw new Error(
        `MCP client extension "${contract.id}" must define server settings compatibility before registering requests`
      );
    }
    const assertServerSettingsCompatible =
      parseServerSettings === undefined || isServerSettingsCompatible === undefined
        ? undefined
        : (clientSettings: JSONObject, serverSettings: unknown): void => {
            const parsedServerSettings = parseServerSettings(serverSettings);
            if (!isServerSettingsCompatible(clientSettings as Settings, parsedServerSettings)) {
              throw new Error(
                `MCP client extension "${contract.id}" has incompatible server settings`
              );
            }
          };
    const pendingContractIdentities = new Set<object>();
    const pendingRequests = requests.map((request): RegisteredExtensionRequest => {
      if (this.requestsByContract.has(request) || pendingContractIdentities.has(request)) {
        throw new Error('MCP extension request contract is already registered');
      }
      pendingContractIdentities.add(request);
      const wireMethod = request.method;
      const mcpNameParam = request.mcpNameParam;
      const paramsSchema = request.paramsSchema;
      const protocol = request.protocol;
      const resultSchema = request.resultSchema;
      assertRequestMethod(wireMethod, protocol, contract.id);
      assertStandardSchema(paramsSchema, `MCP extension request "${wireMethod}" params schema`);
      assertStandardSchema(resultSchema, `MCP extension request "${wireMethod}" result schema`);
      if (mcpNameParam !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(mcpNameParam)) {
        throw new Error(`MCP extension request "${wireMethod}" has an invalid Mcp-Name parameter`);
      }
      if (this.requestsByWireMethod.has(wireMethod)) {
        throw new Error(`MCP extension request method "${wireMethod}" is already registered`);
      }
      const sdkMethod = internalMethod(contract.id, wireMethod);
      if (this.requestsByInternalMethod.has(sdkMethod)) {
        throw new Error(`MCP extension SDK dispatch method "${sdkMethod}" is already registered`);
      }
      return {
        contractIdentity: request,
        extensionId: contract.id,
        internalMethod: sdkMethod,
        ...(mcpNameParam === undefined ? {} : { mcpNameParam }),
        paramsSchema,
        protocol,
        ...(assertServerSettingsCompatible === undefined ? {} : { assertServerSettingsCompatible }),
        resultSchema,
        wireMethod,
      };
    });
    const pendingWireMethods = new Set<string>();
    for (const request of pendingRequests) {
      if (pendingWireMethods.has(request.wireMethod)) {
        throw new Error(
          `MCP extension request method "${request.wireMethod}" is duplicated in "${contract.id}"`
        );
      }
      pendingWireMethods.add(request.wireMethod);
    }

    this.extensions.set(contract.id, project);
    for (const request of pendingRequests) {
      this.requestsByContract.set(request.contractIdentity, request);
      this.requestsByInternalMethod.set(request.internalMethod, request);
      this.requestsByWireMethod.set(request.wireMethod, request);
    }
  }

  async prepareRequest<Params extends JSONObject, Result>(
    contract: McpClientExtensionRequestContract<Params, Result>,
    params: unknown,
    serverExtensions: Readonly<Record<string, JSONObject>> | undefined,
    negotiatedProtocol: string | undefined
  ): Promise<PreparedMcpClientExtensionRequest<Result>> {
    const registered = this.requestsByContract.get(contract) as
      | RegisteredExtensionRequest<Params, Result>
      | undefined;
    if (registered === undefined) {
      throw new Error(`MCP extension request "${contract.method}" is not registered`);
    }
    assertMcpClientExtensionProtocol(
      { method: registered.wireMethod, protocol: registered.protocol },
      negotiatedProtocol
    );
    this.ensureSealed();
    const clientSettings = this.sealedSettings.get(registered.extensionId);
    if (clientSettings === undefined) {
      throw new Error(
        `MCP extension registry lost sealed settings for "${registered.extensionId}"`
      );
    }
    const serverSettings = serverExtensions?.[registered.extensionId];
    if (serverSettings === undefined) {
      throw new Error(
        `MCP server does not advertise extension "${registered.extensionId}" required by "${registered.wireMethod}"`
      );
    }
    if (registered.assertServerSettingsCompatible === undefined) {
      throw new Error(
        `MCP client extension "${registered.extensionId}" has no server settings compatibility check`
      );
    }
    registered.assertServerSettingsCompatible(clientSettings, serverSettings);
    const parsedParams = await parseWithSchema(
      registered.paramsSchema,
      params,
      `MCP extension request "${registered.wireMethod}" params`
    );
    return {
      internalMethod: registered.internalMethod,
      params: parsedParams,
      resultSchema: registered.resultSchema,
    };
  }

  rewriteOutgoingMessage(message: JSONRPCMessage): JSONRPCMessage {
    this.ensureSealed();
    if (!isJsonRpcRequest(message)) {
      return message;
    }
    const registered = this.requestsByInternalMethod.get(message.method);
    if (registered === undefined) {
      return message;
    }
    return { ...message, method: registered.wireMethod };
  }

  resolveMcpName(method: string, params: unknown): string | undefined {
    this.ensureSealed();
    const registered = this.requestsByWireMethod.get(method);
    const param = registered?.mcpNameParam;
    if (param === undefined) {
      return;
    }
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new Error(`MCP extension request "${method}" params must be an object`);
    }
    const value = Reflect.get(params, param);
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `MCP extension request "${method}" requires a non-empty string params.${param}`
      );
    }
    return value;
  }

  hasWireRequestMethod(method: string): boolean {
    this.ensureSealed();
    return this.requestsByWireMethod.has(method);
  }

  toClientExtensionCapabilities(): McpClientExtensionCapabilities | undefined {
    this.ensureSealed();
    return this.sealedCapabilities;
  }

  private ensureSealed(): void {
    if (this.sealed) {
      return;
    }
    const settings = new Map<string, JSONObject>();
    const capabilities: McpClientExtensionCapabilities = {};
    for (const [id, project] of this.extensions) {
      const snapshot = freezeJsonObject(project(), id);
      settings.set(id, snapshot);
      capabilities[id] = snapshot;
    }
    this.sealedSettings = settings;
    this.sealedCapabilities =
      settings.size === 0
        ? undefined
        : (Object.freeze(capabilities) as McpClientExtensionCapabilities);
    this.sealed = true;
  }
}
