import path from "node:path";

import type {
  BuildContext,
  BuildOptions as EsbuildBuildOptions,
} from "esbuild";
import type { ResolvedConfig } from "../config";
import {
  // createDebugger,
  // flattenId,
  // getHash,
  // isOptimizable,
  // lookupFile,
  // normalizeId,
  normalizePath,
  removeLeadingSlash,
  tryStatSync,
  unique,
} from "../utils";

export {
  initDepsOptimizer,
  // initDevSsrDepsOptimizer,
  getDepsOptimizer,
} from "./optimizer";

export type ExportsData = {
  hasModuleSyntax: boolean;
  // exported names (for `export { a as b }`, `b` is exported name)
  exports: readonly string[];
  // hint if the dep requires loading as jsx
  jsxLoader?: boolean;
};

export interface DepsOptimizer {
  metadata: DepOptimizationMetadata;
  scanProcessing?: Promise<void>;
  registerMissingImport: (id: string, resolved: string) => OptimizedDepInfo;
  run: () => void;

  isOptimizedDepFile: (id: string) => boolean;
  isOptimizedDepUrl: (url: string) => boolean;
  getOptimizedDepId: (depInfo: OptimizedDepInfo) => string;

  close: () => Promise<void>;

  options: DepOptimizationOptions;
}

export interface DepOptimizationConfig {
  /**
   * Force optimize listed dependencies (must be resolvable import paths,
   * cannot be globs).
   */
  include?: string[];
  /**
   * Do not optimize these dependencies (must be resolvable import paths,
   * cannot be globs).
   */
  exclude?: string[];
  /**
   * Forces ESM interop when importing these dependencies. Some legacy
   * packages advertise themselves as ESM but use `require` internally
   * @experimental
   */
  needsInterop?: string[];
  /**
   * Options to pass to esbuild during the dep scanning and optimization
   *
   * Certain options are omitted since changing them would not be compatible
   * with Vite's dep optimization.
   *
   * - `external` is also omitted, use Vite's `optimizeDeps.exclude` option
   * - `plugins` are merged with Vite's dep plugin
   *
   * https://esbuild.github.io/api
   */
  esbuildOptions?: Omit<
    EsbuildBuildOptions,
    | "bundle"
    | "entryPoints"
    | "external"
    | "write"
    | "watch"
    | "outdir"
    | "outfile"
    | "outbase"
    | "outExtension"
    | "metafile"
  >;
  /**
   * List of file extensions that can be optimized. A corresponding esbuild
   * plugin must exist to handle the specific extension.
   *
   * By default, Vite can optimize `.mjs`, `.js`, `.ts`, and `.mts` files. This option
   * allows specifying additional extensions.
   *
   * @experimental
   */
  extensions?: string[];
  /**
   * Deps optimization during build was removed in Vite 5.1. This option is
   * now redundant and will be removed in a future version. Switch to using
   * `optimizeDeps.noDiscovery` and an empty or undefined `optimizeDeps.include`.
   * true or 'dev' disables the optimizer, false or 'build' leaves it enabled.
   * @default 'build'
   * @deprecated
   * @experimental
   */
  disabled?: boolean | "build" | "dev";
  /**
   * Automatic dependency discovery. When `noDiscovery` is true, only dependencies
   * listed in `include` will be optimized. The scanner isn't run for cold start
   * in this case. CJS-only dependencies must be present in `include` during dev.
   * @default false
   * @experimental
   */
  noDiscovery?: boolean;
  /**
   * When enabled, it will hold the first optimized deps results until all static
   * imports are crawled on cold start. This avoids the need for full-page reloads
   * when new dependencies are discovered and they trigger the generation of new
   * common chunks. If all dependencies are found by the scanner plus the explicitely
   * defined ones in `include`, it is better to disable this option to let the
   * browser process more requests in parallel.
   * @default true
   * @experimental
   */
  holdUntilCrawlEnd?: boolean;
}

export interface OptimizedDepInfo {
  id: string;
  file: string;
  src?: string;
  needsInterop?: boolean;
  browserHash?: string;
  fileHash?: string;
  /**
   * During optimization, ids can still be resolved to their final location
   * but the bundles may not yet be saved to disk
   */
  processing?: Promise<void>;
  /**
   * ExportData cache, discovered deps will parse the src entry to get exports
   * data used both to define if interop is needed and when pre-bundling
   */
  exportsData?: Promise<ExportsData>;
}

export interface DepOptimizationMetadata {
  /**
   * The main hash is determined by user config and dependency lockfiles.
   * This is checked on server startup to avoid unnecessary re-bundles.
   */
  hash: string;
  /**
   * This hash is determined by dependency lockfiles.
   * This is checked on server startup to avoid unnecessary re-bundles.
   */
  lockfileHash: string;
  /**
   * This hash is determined by user config.
   * This is checked on server startup to avoid unnecessary re-bundles.
   */
  configHash: string;
  /**
   * The browser hash is determined by the main hash plus additional dependencies
   * discovered at runtime. This is used to invalidate browser requests to
   * optimized deps.
   */
  browserHash: string;
  /**
   * Metadata for each already optimized dependency
   */
  optimized: Record<string, OptimizedDepInfo>;
  /**
   * Metadata for non-entry optimized chunks and dynamic imports
   */
  chunks: Record<string, OptimizedDepInfo>;
  /**
   * Metadata for each newly discovered dependency after processing
   */
  discovered: Record<string, OptimizedDepInfo>;
  /**
   * OptimizedDepInfo list
   */
  depInfoList: OptimizedDepInfo[];
}

export type DepOptimizationOptions = DepOptimizationConfig & {
  /**
   * By default, Vite will crawl your `index.html` to detect dependencies that
   * need to be pre-bundled. If `build.rollupOptions.input` is specified, Vite
   * will crawl those entry points instead.
   *
   * If neither of these fit your needs, you can specify custom entries using
   * this option - the value should be a fast-glob pattern or array of patterns
   * (https://github.com/mrmlnc/fast-glob#basic-syntax) that are relative from
   * vite project root. This will overwrite default entries inference.
   */
  entries?: string | string[];
  /**
   * Force dep pre-optimization regardless of whether deps have changed.
   * @experimental
   */
  force?: boolean;
};

/**
 * 根据依赖的 ID 从 DepOptimizationMetadata 对象中获取优化过的依赖信息
 * @param metadata
 * @param id
 * @returns
 */
export function optimizedDepInfoFromId(
  metadata: DepOptimizationMetadata,
  id: string
): OptimizedDepInfo | undefined {
  return (
    metadata.optimized[id] || metadata.discovered[id] || metadata.chunks[id]
  );
}

/**
 * 根据文件路径从 DepOptimizationMetadata 对象中获取优化过的依赖信息
 * @param metadata
 * @param file
 * @returns
 */
export function optimizedDepInfoFromFile(
  metadata: DepOptimizationMetadata,
  file: string
): OptimizedDepInfo | undefined {
  // metadata.depInfoList：一个包含所有依赖信息的列表
  return metadata.depInfoList.find((depInfo) => depInfo.file === file);
}

/**
 * 用于创建一个检查 URL 是否指向优化过的依赖的函数。这个函数是 Vite 的一部分，用于管理和处理优化过的依赖的缓存
 * @param config
 * @returns 这个函数接受一个 URL 字符串作为参数，并返回一个布尔值，表示该 URL 是否指向优化过的依赖
 */
export function createIsOptimizedDepUrl(
  config: ResolvedConfig
): (url: string) => boolean {
  /**项目的根目录 */
  const { root } = config;
  /**依赖缓存目录的绝对路径 */
  const depsCacheDir = getDepsCacheDirPrefix(config);

  // 确定缓存目录内文件的url前缀
  /**缓存目录相对于项目根目录的相对路径 */
  const depsCacheDirRelative = normalizePath(path.relative(root, depsCacheDir));

  /**
   * 根据缓存目录的位置，生成 URL 前缀
   * 如果缓存目录在根目录外面，则前缀以 /@fs/ 开头；如果在根目录内部，则前缀以 / 开头
   */
  const depsCacheDirPrefix = depsCacheDirRelative.startsWith("../")
    ? //  like '/@fs/absolute/path/to/node_modules/.vite'
      // 如果缓存目录在根目录之外，url前缀将是类似'/@fs/absolute/path/to/node_modules/.vite'
      `/@fs/${removeLeadingSlash(normalizePath(depsCacheDir))}`
    : // like '/node_modules/.vite'
      // 如果缓存目录在根目录中，url前缀将是类似于'/node_modules/.vite '的东西
      `/${depsCacheDirRelative}`;

  /**
   * 过检查 URL 是否以 depsCacheDirPrefix 开头来判断 URL 是否指向优化过的依赖。
   */
  return function isOptimizedDepUrl(url: string): boolean {
    return url.startsWith(depsCacheDirPrefix);
  };
}

function getDepsCacheDirPrefix(config: ResolvedConfig): string {
  // 默认的缓存目录为 /node_modules/.vite
  return normalizePath(path.resolve(config.cacheDir, "deps"));
}
