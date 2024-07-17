import path from "node:path";
import colors from "picocolors";
import type {
  Loader,
  Message,
  TransformOptions,
  TransformResult,
} from "esbuild";
import type { SourceMap } from "rollup";
import { transform } from "esbuild";
import type { RawSourceMap } from "@ampproject/remapping";
import { TSConfckCache, TSConfckParseError, parse } from "tsconfck";
import type { TSConfckParseResult } from "tsconfck";
import type { ViteDevServer } from "../server";

import {
  combineSourcemaps,
  createDebugger,
  // createFilter,
  ensureWatchedFile,
  // generateCodeFrame,
} from "../utils";
import { cleanUrl } from "../../shared/utils";

const debug = createDebugger("vite:esbuild");

const validExtensionRE = /\.\w+$/;
const jsxExtensionsRE = /\.(?:j|t)sx\b/;

// the final build should always support dynamic import and import.meta.
// if they need to be polyfilled, plugin-legacy should be used.
// plugin-legacy detects these two features when checking for modern code.
export const defaultEsbuildSupported = {
  "dynamic-import": true,
  "import-meta": true,
};

let server: ViteDevServer;

export interface ESBuildOptions extends TransformOptions {
  include?: string | RegExp | string[] | RegExp[];
  exclude?: string | RegExp | string[] | RegExp[];
  jsxInject?: string;
  /**
   * This option is not respected. Use `build.minify` instead.
   */
  minify?: never;
}

export type ESBuildTransformResult = Omit<TransformResult, "map"> & {
  map: SourceMap;
};

type TSConfigJSON = {
  extends?: string;
  compilerOptions?: {
    alwaysStrict?: boolean;
    experimentalDecorators?: boolean;
    importsNotUsedAsValues?: "remove" | "preserve" | "error";
    jsx?: "preserve" | "react" | "react-jsx" | "react-jsxdev";
    jsxFactory?: string;
    jsxFragmentFactory?: string;
    jsxImportSource?: string;
    preserveValueImports?: boolean;
    target?: string;
    useDefineForClassFields?: boolean;
    verbatimModuleSyntax?: boolean;
  };
  [key: string]: any;
};

type TSCompilerOptions = NonNullable<TSConfigJSON["compilerOptions"]>;

export async function transformWithEsbuild(
  code: string,
  filename: string,
  options?: TransformOptions,
  inMap?: object
): Promise<ESBuildTransformResult> {
  let loader = options?.loader;

  if (!loader) {
    // if the id ends with a valid ext, use it (e.g. vue blocks)
    // otherwise, cleanup the query before checking the ext
    const ext = path
      .extname(validExtensionRE.test(filename) ? filename : cleanUrl(filename))
      .slice(1);

    if (ext === "cjs" || ext === "mjs") {
      loader = "js";
    } else if (ext === "cts" || ext === "mts") {
      loader = "ts";
    } else {
      loader = ext as Loader;
    }
  }

  let tsconfigRaw = options?.tsconfigRaw;

  // if options provide tsconfigRaw in string, it takes highest precedence
  if (typeof tsconfigRaw !== "string") {
    // these fields would affect the compilation result
    // https://esbuild.github.io/content-types/#tsconfig-json
    const meaningfulFields: Array<keyof TSCompilerOptions> = [
      "alwaysStrict",
      "experimentalDecorators",
      "importsNotUsedAsValues",
      "jsx",
      "jsxFactory",
      "jsxFragmentFactory",
      "jsxImportSource",
      "preserveValueImports",
      "target",
      "useDefineForClassFields",
      "verbatimModuleSyntax",
    ];
    const compilerOptionsForFile: TSCompilerOptions = {};
    if (loader === "ts" || loader === "tsx") {
      const loadedTsconfig = await loadTsconfigJsonForFile(filename);
      const loadedCompilerOptions = loadedTsconfig.compilerOptions ?? {};

      for (const field of meaningfulFields) {
        if (field in loadedCompilerOptions) {
          // @ts-expect-error TypeScript can't tell they are of the same type
          compilerOptionsForFile[field] = loadedCompilerOptions[field];
        }
      }
    }

    const compilerOptions = {
      ...compilerOptionsForFile,
      ...tsconfigRaw?.compilerOptions,
    };

    // esbuild uses `useDefineForClassFields: true` when `tsconfig.compilerOptions.target` isn't declared
    // but we want `useDefineForClassFields: false` when `tsconfig.compilerOptions.target` isn't declared
    // to align with the TypeScript's behavior
    if (
      compilerOptions.useDefineForClassFields === undefined &&
      compilerOptions.target === undefined
    ) {
      compilerOptions.useDefineForClassFields = false;
    }

    // esbuild uses tsconfig fields when both the normal options and tsconfig was set
    // but we want to prioritize the normal options
    if (options) {
      options.jsx && (compilerOptions.jsx = undefined);
      options.jsxFactory && (compilerOptions.jsxFactory = undefined);
      options.jsxFragment && (compilerOptions.jsxFragmentFactory = undefined);
      options.jsxImportSource && (compilerOptions.jsxImportSource = undefined);
    }

    tsconfigRaw = {
      ...tsconfigRaw,
      compilerOptions,
    };
  }

  const resolvedOptions: TransformOptions = {
    sourcemap: true,
    // ensure source file name contains full query
    sourcefile: filename,
    ...options,
    loader,
    tsconfigRaw,
  };

  // Some projects in the ecosystem are calling this function with an ESBuildOptions
  // object and esbuild throws an error for extra fields
  // @ts-expect-error include exists in ESBuildOptions
  delete resolvedOptions.include;
  // @ts-expect-error exclude exists in ESBuildOptions
  delete resolvedOptions.exclude;
  // @ts-expect-error jsxInject exists in ESBuildOptions
  delete resolvedOptions.jsxInject;

  try {
    const result = await transform(code, resolvedOptions);
    let map: SourceMap;
    if (inMap && resolvedOptions.sourcemap) {
      const nextMap = JSON.parse(result.map);
      nextMap.sourcesContent = [];
      map = combineSourcemaps(filename, [
        nextMap as RawSourceMap,
        inMap as RawSourceMap,
      ]) as SourceMap;
    } else {
      map =
        resolvedOptions.sourcemap && resolvedOptions.sourcemap !== "inline"
          ? JSON.parse(result.map)
          : { mappings: "" };
    }
    return {
      ...result,
      map,
    };
  } catch (e: any) {
    debug?.(`esbuild error with options used: `, resolvedOptions);
    // patch error information
    if (e.errors) {
      e.frame = "";
      e.errors.forEach((m: Message) => {
        if (
          m.text === "Experimental decorators are not currently enabled" ||
          m.text ===
            "Parameter decorators only work when experimental decorators are enabled"
        ) {
          m.text +=
            '. Vite 5 now uses esbuild 0.18 and you need to enable them by adding "experimentalDecorators": true in your "tsconfig.json" file.';
        }
        e.frame += `\n` + prettifyMessage(m, code);
      });
      e.loc = e.errors[0].location;
    }
    throw e;
  }
}

let tsconfckCache: TSConfckCache<TSConfckParseResult> | undefined;

export async function loadTsconfigJsonForFile(
  filename: string
): Promise<TSConfigJSON> {
  try {
    if (!tsconfckCache) {
      tsconfckCache = new TSConfckCache<TSConfckParseResult>();
    }
    const result = await parse(filename, {
      cache: tsconfckCache,
      ignoreNodeModules: true,
    });
    // tsconfig could be out of root, make sure it is watched on dev
    if (server && result.tsconfigFile) {
      ensureWatchedFile(
        server.watcher,
        result.tsconfigFile,
        server.config.root
      );
    }
    return result.tsconfig;
  } catch (e) {
    if (e instanceof TSConfckParseError) {
      // tsconfig could be out of root, make sure it is watched on dev
      if (server && e.tsconfigFile) {
        ensureWatchedFile(server.watcher, e.tsconfigFile, server.config.root);
      }
    }
    throw e;
  }
}

function prettifyMessage(m: Message, code: string): string {
  let res = colors.yellow(m.text);
  if (m.location) {
    // res += `\n` + generateCodeFrame(code, m.location);
  }
  return res + `\n`;
}
