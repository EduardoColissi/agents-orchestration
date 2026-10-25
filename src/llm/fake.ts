import type { LLMClient, LLMRequest, LLMResponse, ToolCall } from './client.js';
import type { Source } from '../types.js';

export interface FakeReply {
  text?: string;
  toolCalls?: Array<Omit<ToolCall, 'id'> & { id?: string }>;
  webSources?: Source[];
  webSearches?: number;
}

export type FakeHandler = (request: LLMRequest, callIndex: number) => FakeReply | Promise<FakeReply>;

/**
 * Scripted LLM for tests. Either a list of replies consumed in order, or a handler that
 * decides the reply from the request (e.g. by inspecting the system prompt).
 */
export class FakeLLM implements LLMClient {
  readonly calls: LLMRequest[] = [];
  private readonly handler: FakeHandler;
  private idCounter = 0;

  constructor(script: FakeReply[] | FakeHandler) {
    if (Array.isArray(script)) {
      const queue = [...script];
      this.handler = () => {
        const next = queue.shift();
        if (!next) throw new Error('FakeLLM: script exhausted');
        return next;
      };
    } else {
      this.handler = script;
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const callIndex = this.calls.length;
    this.calls.push(structuredClone(request));
    const reply = await this.handler(request, callIndex);
    const toolCalls = (reply.toolCalls ?? []).map((c) => ({ ...c, id: c.id ?? `toolu_fake_${++this.idCounter}` }));
    const assistantContent: unknown[] = [
      ...(reply.text ? [{ type: 'text', text: reply.text }] : []),
      ...toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
    ];
    return {
      text: reply.text ?? '',
      toolCalls,
      webSources: reply.webSources ?? [],
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, webSearches: reply.webSearches ?? 0 },
      assistantContent,
    };
  }
}
