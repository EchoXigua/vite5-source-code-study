/**
 * Like `JSON.stringify` but keeps raw string values as a literal
 * in the generated code. For example: `"window"` would refer to
 * the global `window` object directly.
 */
export function serializeDefine(define: Record<string, any>): string {
  let res = `{`;
  const keys = Object.keys(define);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const val = define[key];
    res += `${JSON.stringify(key)}: ${handleDefineValue(val)}`;
    if (i !== keys.length - 1) {
      res += `, `;
    }
  }
  return res + `}`;
}

function handleDefineValue(value: any): string {
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
