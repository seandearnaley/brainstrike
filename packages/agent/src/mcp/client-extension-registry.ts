import type { ClientCapabilities, JSONObject } from '@modelcontextprotocol/client';

const EXTENSION_ID_PATTERN =
  /^(?:[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

export interface McpClientExtensionContract<
  Version extends string,
  Settings extends JSONObject,
  Implementation,
> {
  readonly id: string;
  readonly isCompleteImplementation: (value: unknown) => value is Implementation;
  readonly parseSettings: (value: unknown) => Settings;
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

/** Host-owned registry for extensions whose complete implementation is installed. */
export class McpClientExtensionRegistry {
  private readonly extensions = new Map<string, () => JSONObject>();

  register<Version extends string, Settings extends JSONObject, Implementation>(
    contract: McpClientExtensionContract<Version, Settings, Implementation>,
    registration: McpClientExtensionRegistration<Version, Settings, Implementation>
  ): void {
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
    this.extensions.set(contract.id, project);
  }

  toClientExtensionCapabilities(): McpClientExtensionCapabilities | undefined {
    if (this.extensions.size === 0) {
      return;
    }
    return Object.fromEntries(Array.from(this.extensions, ([id, project]) => [id, project()]));
  }
}
