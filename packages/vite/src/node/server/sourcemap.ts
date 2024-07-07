import path from "node:path";
import fsp from "node:fs/promises";
import type { ExistingRawSourceMap, SourceMap } from "rollup";
import type { Logger } from "../logger";
import { cleanUrl } from "../../shared/utils";
import { createDebugger } from "../utils";

const debug = createDebugger("vite:sourcemap", {
  onlyWhenFocused: true,
});

interface SourceMapLike {
  sources: string[];
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
}

// Virtual modules should be prefixed with a null byte to avoid a
// false positive "missing source" warning. We also check for certain
// prefixes used for special handling in esbuildDepPlugin.
const virtualSourceRE = /^(?:dep:|browser-external:|virtual:)|\0/;

async function computeSourceRoute(map: SourceMapLike, file: string) {
  let sourceRoot: string | undefined;
  try {
    // The source root is undefined for virtual modules and permission errors.
    sourceRoot = await fsp.realpath(
      path.resolve(path.dirname(file), map.sourceRoot || "")
    );
  } catch {}
  return sourceRoot;
}

export async function injectSourcesContent(
  map: SourceMapLike,
  file: string,
  logger: Logger
): Promise<void> {
  let sourceRootPromise: Promise<string | undefined>;

  const missingSources: string[] = [];
  const sourcesContent = map.sourcesContent || [];
  const sourcesContentPromises: Promise<void>[] = [];
  for (let index = 0; index < map.sources.length; index++) {
    const sourcePath = map.sources[index];
    if (
      sourcesContent[index] == null &&
      sourcePath &&
      !virtualSourceRE.test(sourcePath)
    ) {
      sourcesContentPromises.push(
        (async () => {
          // inject content from source file when sourcesContent is null
          sourceRootPromise ??= computeSourceRoute(map, file);
          const sourceRoot = await sourceRootPromise;
          let resolvedSourcePath = cleanUrl(decodeURI(sourcePath));
          if (sourceRoot) {
            resolvedSourcePath = path.resolve(sourceRoot, resolvedSourcePath);
          }

          sourcesContent[index] = await fsp
            .readFile(resolvedSourcePath, "utf-8")
            .catch(() => {
              missingSources.push(resolvedSourcePath);
              return null;
            });
        })()
      );
    }
  }

  await Promise.all(sourcesContentPromises);

  map.sourcesContent = sourcesContent;

  // Use this command…
  //    DEBUG="vite:sourcemap" vite build
  // …to log the missing sources.
  if (missingSources.length) {
    logger.warnOnce(`Sourcemap for "${file}" points to missing source files`);
    debug?.(`Missing sources:\n  ` + missingSources.join(`\n  `));
  }
}

export function getCodeWithSourcemap(
  type: "js" | "css",
  code: string,
  map: SourceMap
): string {
  if (debug) {
    code += `\n/*${JSON.stringify(map, null, 2).replace(/\*\//g, "*\\/")}*/\n`;
  }

  if (type === "js") {
    code += `\n//# sourceMappingURL=${genSourceMapUrl(map)}`;
  } else if (type === "css") {
    code += `\n/*# sourceMappingURL=${genSourceMapUrl(map)} */`;
  }

  return code;
}

export function genSourceMapUrl(map: SourceMap | string): string {
  if (typeof map !== "string") {
    map = JSON.stringify(map);
  }
  return `data:application/json;base64,${Buffer.from(map).toString("base64")}`;
}
