/**
 * OpenAI's strict structured outputs take a narrower JSON schema than
 * the parsers write: every property required (an optional one becomes
 * nullable), no extra properties anywhere. The answer then carries
 * `null` where the model had nothing to say, which the normalizers read
 * as "omitted" once the nulls are gone. Pure, for the tests.
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The schema with `null` as one more allowed value. */
const nullable = (schema: Record<string, unknown>): Record<string, unknown> => {
  if (typeof schema['type'] === 'string' && schema['type'] !== 'object') {
    return {
      ...schema,
      ...(Array.isArray(schema['enum']) ? { enum: [...schema['enum'], null] } : {}),
      type: [schema['type'], 'null'],
    };
  }
  return { anyOf: [schema, { type: 'null' }] };
};

export const strictSchema = (schema: unknown): unknown => {
  if (!isObject(schema)) {
    return schema;
  }
  if (schema['type'] === 'array' && isObject(schema['items'])) {
    return { ...schema, items: strictSchema(schema['items']) };
  }
  if (schema['type'] !== 'object' || !isObject(schema['properties'])) {
    return schema;
  }
  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as Array<string>) : [],
  );
  const properties = Object.fromEntries(
    Object.entries(schema['properties']).map(([key, property]) => {
      const strict = strictSchema(property);
      return [key, required.has(key) || !isObject(strict) ? strict : nullable(strict)];
    }),
  );
  return {
    ...schema,
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
};

/** The answer without its nulls: a nullable property the model left null was omitted. */
export const withoutNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null).map(withoutNulls);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null)
        .map(([key, item]) => [key, withoutNulls(item)]),
    );
  }
  return value;
};
