import fs from "node:fs";
import path from "node:path";
import colors from "picocolors";
import type { Logger } from "./logger";
import {
  DEFAULT_ASSETS_INLINE_LIMIT,
  ESBUILD_MODULES_TARGET,
  VERSION,
} from "./constants";
import { mergeConfig } from "./publicUtils";
import { requireResolveFromRootWithFallback } from "./utils";

export function resolveBuildOptions(
  raw: any | undefined,
  logger: Logger,
  root: string
): any {
  const deprecatedPolyfillModulePreload = raw?.polyfillModulePreload;
  if (raw) {
    const { polyfillModulePreload, ...rest } = raw;
    raw = rest;
    if (deprecatedPolyfillModulePreload !== undefined) {
      logger.warn(
        "polyfillModulePreload is deprecated. Use modulePreload.polyfill instead."
      );
    }
    if (
      deprecatedPolyfillModulePreload === false &&
      raw.modulePreload === undefined
    ) {
      raw.modulePreload = { polyfill: false };
    }
  }

  const modulePreload = raw?.modulePreload;
  const defaultModulePreload = {
    polyfill: true,
  };

  const defaultBuildOptions: any = {
    outDir: "dist",
    assetsDir: "assets",
    assetsInlineLimit: DEFAULT_ASSETS_INLINE_LIMIT,
    cssCodeSplit: !raw?.lib,
    sourcemap: false,
    rollupOptions: {},
    minify: raw?.ssr ? false : "esbuild",
    terserOptions: {},
    write: true,
    emptyOutDir: null,
    copyPublicDir: true,
    manifest: false,
    lib: false,
    ssr: false,
    ssrManifest: false,
    ssrEmitAssets: false,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 500,
    watch: null,
  };

  const userBuildOptions = raw
    ? mergeConfig(defaultBuildOptions, raw)
    : defaultBuildOptions;

  // @ts-expect-error Fallback options instead of merging
  const resolved: ResolvedBuildOptions = {
    target: "modules",
    cssTarget: false,
    ...userBuildOptions,
    commonjsOptions: {
      include: [/node_modules/],
      extensions: [".js", ".cjs"],
      ...userBuildOptions.commonjsOptions,
    },
    dynamicImportVarsOptions: {
      warnOnError: true,
      exclude: [/node_modules/],
      ...userBuildOptions.dynamicImportVarsOptions,
    },
    // Resolve to false | object
    modulePreload:
      modulePreload === false
        ? false
        : typeof modulePreload === "object"
        ? {
            ...defaultModulePreload,
            ...modulePreload,
          }
        : defaultModulePreload,
  };

  // handle special build targets
  if (resolved.target === "modules") {
    resolved.target = ESBUILD_MODULES_TARGET;
  } else if (resolved.target === "esnext" && resolved.minify === "terser") {
    try {
      const terserPackageJsonPath = requireResolveFromRootWithFallback(
        root,
        "terser/package.json"
      );
      const terserPackageJson = JSON.parse(
        fs.readFileSync(terserPackageJsonPath, "utf-8")
      );
      const v = terserPackageJson.version.split(".");
      if (v[0] === "5" && v[1] < 16) {
        // esnext + terser 5.16<: limit to es2021 so it can be minified by terser
        resolved.target = "es2021";
      }
    } catch {}
  }

  if (!resolved.cssTarget) {
    resolved.cssTarget = resolved.target;
  }

  // normalize false string into actual false
  if ((resolved.minify as string) === "false") {
    resolved.minify = false;
  } else if (resolved.minify === true) {
    resolved.minify = "esbuild";
  }

  if (resolved.cssMinify == null) {
    resolved.cssMinify = !!resolved.minify;
  }

  return resolved;
}
