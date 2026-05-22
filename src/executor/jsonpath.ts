// Minimal JSONPath evaluator for simple paths: $.field or $.data.field or $.items[0].id
// For production, replace with jsonpath-plus or jsonpath library

export function evaluateJsonPath(obj: unknown, path: string): unknown {
  if (!path.startsWith("$")) throw new Error(`JSONPath must start with $: ${path}`);

  const parts = path
    .slice(1) // remove $
    .split(".")
    .filter(Boolean)
    .flatMap((part) => {
      // Handle array indexing: items[0]
      const match = part.match(/^([^[]+)(?:\[(\d+)\])?$/);
      if (!match) return [part];
      return match[2] !== undefined ? [match[1]!, parseInt(match[2], 10)] : [match[1]!];
    });

  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined;
      current = (current as unknown[])[part];
    } else {
      if (typeof current !== "object" || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}
