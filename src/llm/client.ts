import type { Source, TokenUsage } from '../types.js';

/**
 * Provider-agnostic LLM contract. Agents only depend on this interface, which lets
 * the whole pipeline run in tests with a scripted fake (spec §9 testability).
 */
export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
  /** What the provider can do natively; agents adapt (e.g. add a local web search tool). */
  readonly capabilities: LLMCapabilities;
}

export interface LLMCapabilities {
  /** Provider runs web searches server-side (Anthropic `web_search` tool). */
  serverWebSearch: boolean;
  /** Provider honours `forceTool` natively (tool_choice). */
  forcedToolChoice: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  inputSchema: Record<string, unknown>;
}

export type LLMMessage =
  | { role: 'user'; content: string | ToolResultContent[] }
  /** `content` is the provider's raw assistant content, echoed back verbatim in tool loops. */
  | { role: 'assistant'; content: unknown[] | string };

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface LLMRequest {
  model: string;
  system: string;
  messages: LLMMessage[];
  tools?: ToolSpec[];
  /** Enables the provider's server-side web search tool. */
  webSearch?: { maxUses: number };
  /** Force a specific tool (used for structured output). */
  forceTool?: string;
  /** 'none' = the model must answer in text (tools stay declared for history replay). */
  toolChoice?: 'none';
  maxTokens?: number;
  temperature?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  /** Pages returned by server-side web search (deduplicated). */
  webSources: Source[];
  stopReason: string;
  usage: TokenUsage;
  /** Raw assistant content to append to the conversation when continuing a tool loop. */
  assistantContent: unknown[];
}
