import { transform } from "esbuild";
import { TraceMap, decodedMap, encodedMap } from "@jridgewell/trace-mapping";
import type { ResolvedConfig } from "../config";
import { escapeRegex, getHash } from "../utils";

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

export async function replaceDefine(
  code: string,
  id: string,
  define: Record<string, string>,
  config: ResolvedConfig
): Promise<{ code: string; map: string | null }> {
  // Because esbuild only allows JSON-serializable values, and `import.meta.env`
  // may contain values with raw identifiers, making it non-JSON-serializable,
  // we replace it with a temporary marker and then replace it back after to
  // workaround it. This means that esbuild is unable to optimize the `import.meta.env`
  // access, but that's a tradeoff for now.
  const replacementMarkers: Record<string, string> = {};
  const env = define["import.meta.env"];
  if (env && !canJsonParse(env)) {
    const marker = `_${getHash(env, env.length - 2)}_`;
    replacementMarkers[marker] = env;
    define = { ...define, "import.meta.env": marker };
  }

  const esbuildOptions = config.esbuild || {};

  const result = await transform(code, {
    loader: "js",
    charset: esbuildOptions.charset ?? "utf8",
    platform: "neutral",
    define,
    sourcefile: id,
    sourcemap: config.command === "build" ? !!config.build.sourcemap : true,
  });

  // remove esbuild's <define:...> source entries
  // since they would confuse source map remapping/collapsing which expects a single source
  if (result.map.includes("<define:")) {
    const originalMap = new TraceMap(result.map);
    if (originalMap.sources.length >= 2) {
      const sourceIndex = originalMap.sources.indexOf(id);
      const decoded = decodedMap(originalMap);
      decoded.sources = [id];
      decoded.mappings = decoded.mappings.map((segments) =>
        segments.filter((segment) => {
          // modify and filter
          const index = segment[1];
          segment[1] = 0;
          return index === sourceIndex;
        })
      );
      result.map = JSON.stringify(encodedMap(new TraceMap(decoded as any)));
    }
  }

  for (const marker in replacementMarkers) {
    result.code = result.code.replaceAll(marker, replacementMarkers[marker]);
  }

  return {
    code: result.code,
    map: result.map || null,
  };
}

function canJsonParse(value: any): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
