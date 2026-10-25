import { z } from 'zod';
import type { AgentTool, ToolExecutionResult } from './toolLoop.js';

/**
 * Builds an {@link AgentTool} from a zod schema: the same schema produces the JSON Schema
 * shown to the model and validates what the model sends back.
 */
export function defineTool<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  handler: (input: z.infer<S>) => Promise<ToolExecutionResult>,
): AgentTool {
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return {
    spec: { name, description, inputSchema },
    async execute(raw) {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) {
        return { content: `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`, isError: true };
      }
      return handler(parsed.data);
    },
  };
}

export const json = (value: unknown): string => JSON.stringify(value, null, 1);
