import type { NativeToolId } from './native-tool-catalog.js';

/** Parameter type for display purposes. */
export type ParameterType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum';

/** Single parameter definition for UI display. */
export interface ToolParameterDisplay {
  arrayItemType?: ParameterType;
  default?: unknown;
  description: string;
  enumValues?: string[];
  max?: number;
  maxLength?: number;
  min?: number;
  minLength?: number;
  name: string;
  required: boolean;
  type: ParameterType;
}

/** Complete schema display info for a tool. */
export interface ToolSchemaDisplay {
  description: string;
  parameters: ToolParameterDisplay[];
  returns: string;
  toolId: NativeToolId;
}
