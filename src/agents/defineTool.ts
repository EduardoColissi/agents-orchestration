import { z } from 'zod';
import type { AgentTool, ToolExecutionOptions, ToolExecutionResult } from './toolLoop.js';

/**
 * Builds an {@link AgentTool} from a zod schema: the same schema produces the JSON Schema
 * shown to the model and validates what the model sends back.
 */
export function defineTool<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  handler: (input: z.infer<S>, options: ToolExecutionOptions) => Promise<ToolExecutionResult>,
  flags: { requiresApproval?: boolean } = {},
): AgentTool {
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return {
    spec: { name, description, inputSchema },
    ...(flags.requiresApproval ? { requiresApproval: true } : {}),
    async execute(raw, options = {}) {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) {
        return { content: `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`, isError: true };
      }
      return handler(parsed.data, options);
    },
  };
}

export const json = (value: unknown): string => JSON.stringify(value, null, 1);
