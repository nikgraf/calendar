import { isToolName, TOOL_NAMES, toolInputJsonSchema, type ToolName, TOOLS } from '@calendar/agent';
import type { ToolCaller } from './mcp.ts';
import type { AgentCliReply } from './protocol.ts';

/**
 * The CLI face of the gateway: the same tools as MCP, as
 * `solunivo-cli <tool> [--flag value …]`, JSON out. It runs in the main
 * process (the relay only forwards argv and prints the reply), so the
 * flags are derived from the tools' own schemas and cannot drift.
 */

const USAGE = `Usage:
  solunivo-cli mcp                      Serve MCP over stdio (for an agent's MCP config)
  solunivo-cli tools                    List the tools and their input schemas (JSON)
  solunivo-cli <tool> [--flag value …]  Call one tool; the result is printed as JSON
  solunivo-cli <tool> --args '<json>'   Same, with the whole input as one JSON object

Flags are the tool's input fields (--from-date and --fromDate both work). Lists
repeat the flag or take a JSON array. The agent token is read from the
SOLUNIVO_AGENT_TOKEN environment variable.

Tools:
${TOOL_NAMES.map((name) => `  ${name.padEnd(18)} ${TOOLS[name].title}`).join('\n')}
`;

const ok = (value: unknown): AgentCliReply => ({
  exitCode: 0,
  stderr: '',
  stdout: `${JSON.stringify(value, null, 2)}\n`,
});

const usageError = (message: string): AgentCliReply => ({
  exitCode: 2,
  stderr: `${message}\nRun "solunivo-cli --help" for usage.\n`,
  stdout: '',
});

type PropertySchema = { readonly [key: string]: unknown };

/** The value type a flag takes, seen through a "T or null" wrapper. */
const kindOf = (schema: PropertySchema): { readonly nullable: boolean; readonly type: string } => {
  const variants = Array.isArray(schema['anyOf']) ? (schema['anyOf'] as Array<PropertySchema>) : [];
  if (variants.length > 0) {
    const concrete = variants.find((variant) => variant['type'] !== 'null');
    return {
      nullable: variants.some((variant) => variant['type'] === 'null'),
      type: concrete ? kindOf(concrete).type : 'string',
    };
  }
  return { nullable: false, type: typeof schema['type'] === 'string' ? schema['type'] : 'string' };
};

const camel = (flag: string): string =>
  flag.replaceAll(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());

class UsageError extends Error {}

const parseJson = (flag: string, text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UsageError(`--${flag} expects JSON, got: ${text}`);
  }
};

/** Turns `--flag value` pairs into the tool's input object, typed by its schema. */
export const parseToolArgs = (name: ToolName, args: ReadonlyArray<string>): unknown => {
  const properties = (toolInputJsonSchema(name)['properties'] ?? {}) as Record<
    string,
    PropertySchema
  >;
  const input: Record<string, unknown> = {};
  const queue = [...args];
  while (queue.length > 0) {
    const token = queue.shift()!;
    if (!token.startsWith('--')) {
      throw new UsageError(`Unexpected argument "${token}"; inputs are passed as --flag value.`);
    }
    const equals = token.indexOf('=');
    const rawFlag = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    if (rawFlag === 'args') {
      const value = parseJson('args', inline ?? queue.shift() ?? '');
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new UsageError('--args expects a JSON object.');
      }
      Object.assign(input, value);
      continue;
    }
    const key = camel(rawFlag);
    const schema = properties[key];
    if (!schema) {
      const known = Object.keys(properties);
      throw new UsageError(
        `${name} has no input "${rawFlag}". ${
          known.length > 0 ? `It takes: ${known.join(', ')}.` : 'It takes no inputs.'
        }`,
      );
    }
    const { nullable, type } = kindOf(schema);
    // A boolean flag may stand alone; everything else needs a value.
    const next = queue[0];
    const standsAlone = type === 'boolean' && (next === undefined || next.startsWith('--'));
    const text = inline ?? (standsAlone ? 'true' : queue.shift());
    if (text === undefined) {
      throw new UsageError(`--${rawFlag} needs a value.`);
    }
    if (nullable && text === 'null') {
      input[key] = null;
      continue;
    }
    switch (type) {
      case 'boolean': {
        if (text !== 'true' && text !== 'false') {
          throw new UsageError(`--${rawFlag} expects true or false.`);
        }
        input[key] = text === 'true';
        break;
      }
      case 'number':
      case 'integer': {
        const value = Number(text);
        if (text.trim() === '' || !Number.isFinite(value)) {
          throw new UsageError(`--${rawFlag} expects a number.`);
        }
        input[key] = value;
        break;
      }
      case 'array': {
        const items = schema['items'] as PropertySchema | undefined;
        const wantsStrings = items === undefined || kindOf(items).type === 'string';
        const values =
          text.trimStart().startsWith('[') || !wantsStrings ? parseJson(rawFlag, text) : [text];
        const list = Array.isArray(values) ? values : [values];
        input[key] = [
          ...(Array.isArray(input[key]) ? (input[key] as Array<unknown>) : []),
          ...list,
        ];
        break;
      }
      case 'object': {
        input[key] = parseJson(rawFlag, text);
        break;
      }
      default: {
        input[key] = text;
      }
    }
  }
  return input;
};

export const runCli = async (
  argv: ReadonlyArray<string>,
  call: ToolCaller,
): Promise<AgentCliReply> => {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { exitCode: 0, stderr: '', stdout: USAGE };
  }
  if (command === 'tools') {
    return ok(
      TOOL_NAMES.map((name) => ({
        description: TOOLS[name].description,
        inputSchema: toolInputJsonSchema(name),
        kind: TOOLS[name].kind,
        name,
      })),
    );
  }
  const name = command.replaceAll('-', '_');
  if (!isToolName(name)) {
    return usageError(`Unknown command "${command}".`);
  }
  let input: unknown;
  try {
    input = parseToolArgs(name, rest);
  } catch (error) {
    if (error instanceof UsageError) {
      return usageError(error.message);
    }
    throw error;
  }
  const outcome = await call(name, input);
  return outcome.ok
    ? ok(outcome.result)
    : {
        exitCode: outcome.error.code === 'InvalidInput' ? 2 : 1,
        stderr: `${JSON.stringify({ error: outcome.error }, null, 2)}\n`,
        stdout: '',
      };
};
