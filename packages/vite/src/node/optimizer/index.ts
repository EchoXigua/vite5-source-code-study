import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import colors from "picocolors";
import type {
  BuildContext,
  BuildOptions as EsbuildBuildOptions,
} from "esbuild";
import esbuild, { build } from "esbuild";
import { init, parse } from "es-module-lexer";
import glob from "fast-glob";

import type { ResolvedConfig } from "../config";
import { getDepOptimizationConfig } from "../config";
import {
  createDebugger,
  flattenId,
  getHash,
  isOptimizable,
  lookupFile,
  normalizeId,
  normalizePath,
  removeLeadingSlash,
  tryStatSync,
  unique,
} from "../utils";
import {
  defaultEsbuildSupported,
  transformWithEsbuild,
} from "../plugins/esbuild";
import { ESBUILD_MODULES_TARGET, METADATA_FILENAME } from "../constants";
import { createOptimizeDepsIncludeResolver, expandGlobIds } from "./resolve";
import { scanImports } from "./scan";
import { isWindows } from "../../shared/utils";
import { esbuildCjsExternalPlugin, esbuildDepPlugin } from "./esbuildDepPlugin";

const debug = createDebugger("vite:deps");

const jsExtensionRE = /\.js$/i;
const jsMapExtensionRE = /\.js\.map$/i;

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

export interface DepOptimizationResult {
  metadata: DepOptimizationMetadata;
  /**
   * When doing a re-run, if there are newly discovered dependencies
   * the page reload will be delayed until the next rerun so we need
   * to be able to discard the result
   */
  commit: () => Promise<void>;
  cancel: () => void;
}

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

export function createIsOptimizedDepFile(
  config: ResolvedConfig
): (id: string) => boolean {
  const depsCacheDirPrefix = getDepsCacheDirPrefix(config);
  return (id) => id.startsWith(depsCacheDirPrefix);
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

/**
 * 用于初始化依赖优化的元数据
 * 在 Vite 中，依赖优化是一个重要的过程，可以显著提升开发时的构建速度和运行性能
 * @param config 已解析配置
 * @param ssr
 * @param timestamp 用于生成浏览器缓存哈希
 * @returns
 */
export function initDepsOptimizerMetadata(
  config: ResolvedConfig,
  ssr: boolean,
  timestamp?: string
): DepOptimizationMetadata {
  // 生成依赖哈希
  /**
   * lockfileHash：依赖锁文件的哈希
   * configHash：Vite 配置的哈希
   * hash：综合的依赖哈希
   */
  const { lockfileHash, configHash, hash } = getDepHash(config, ssr);

  // 返回元数据对象
  return {
    // 综合依赖哈希，用于确定依赖是否发生变化
    hash,
    // 锁文件哈希，用于检测依赖版本是否发生变化
    lockfileHash,
    // 配置文件哈希，用于检测配置是否发生变化
    configHash,
    browserHash: getOptimizedBrowserHash(hash, {}, timestamp),
    // 已优化的依赖信息，初始为空对象
    optimized: {},
    // 已优化的代码块信息，初始为空对象
    chunks: {},
    // 发现的依赖信息，初始为空对象
    discovered: {},
    // 依赖信息列表，初始为空数组
    depInfoList: [],
  };
}

let firstLoadCachedDepOptimizationMetadata = true;

/**
 * 创建初始的依赖优化元数据，从依赖缓存中加载（如果存在的话），并且没有强制预打包的情况
 * 否则，会根据需要重新优化依赖
 *
 * @param config 解析后的配置对象
 * @param ssr
 * @param force 是否强制重新优化
 * @param asCommand 是否作为命令执行
 * @returns
 */
export async function loadCachedDepOptimizationMetadata(
  config: ResolvedConfig,
  ssr: boolean,
  force = config.optimizeDeps.force,
  asCommand = false
): Promise<DepOptimizationMetadata | undefined> {
  const log = asCommand ? config.logger.info : debug;

  // 首次加载处理
  if (firstLoadCachedDepOptimizationMetadata) {
    firstLoadCachedDepOptimizationMetadata = false;
    // 如果是第一次加载缓存元数据，
    // 会启动一个定时器来清理陈旧的依赖缓存目录，防止之前的进程异常退出导致的遗留问题。
    setTimeout(() => cleanupDepsCacheStaleDirs(config), 0);
  }

  // 获取依赖缓存目录
  const depsCacheDir = getDepsCacheDir(config, ssr);

  // 如果没有强制重新打包
  if (!force) {
    // 如果没有强制重新优化，尝试从缓存文件中读取并解析元数据
    let cachedMetadata: DepOptimizationMetadata | undefined;
    try {
      const cachedMetadataPath = path.join(depsCacheDir, METADATA_FILENAME);
      // 从缓存文件中解析元数据
      cachedMetadata = parseDepsOptimizerMetadata(
        await fsp.readFile(cachedMetadataPath, "utf-8"),
        depsCacheDir
      );
      // 忽略错误
    } catch (e) {}
    // hash is consistent, no need to re-bundle
    // 哈希值（锁文件哈希和配置哈希）一致时，不需要重新打包优化依赖
    /**
     * 在依赖优化过程中，Vite 使用哈希值来确保缓存的有效性和一致性。
     *
     * 如果缓存的依赖元数据中的哈希值与当前项目的哈希值匹配，就意味着依赖项和配置没有发生变化，
     * 此时可以使用缓存的优化结果，而不需要重新执行优化过程。
     */

    // 如果缓存的元数据存在
    if (cachedMetadata) {
      // 检查其锁文件哈希和配置哈希是否与当前的一致
      if (cachedMetadata.lockfileHash !== getLockfileHash(config, ssr)) {
        config.logger.info(
          "Re-optimizing dependencies because lockfile has changed"
        );

        // 检查缓存的配置哈希是否与当前的配置哈希一致
      } else if (cachedMetadata.configHash !== getConfigHash(config, ssr)) {
        config.logger.info(
          "Re-optimizing dependencies because vite config has changed"
        );
      } else {
        // 如果哈希一致，跳过重新优化，并提示可以使用 --force 参数来覆盖
        log?.("Hash is consistent. Skipping. Use --force to override.");
        // Nothing to commit or cancel as we are using the cache, we only
        // need to resolve the processing promise so requests can move on

        // 直接返回缓存的元数据
        return cachedMetadata;
      }
    }
  } else {
    config.logger.info("Forced re-optimization of dependencies");
  }

  // 如果强制重新优化，删除旧的缓存目录
  debug?.(colors.green(`removing old cache dir ${depsCacheDir}`));
  await fsp.rm(depsCacheDir, { recursive: true, force: true });
}

export function depsLogString(qualifiedIds: string[]): string {
  return colors.yellow(qualifiedIds.join(`, `));
}

/**定义临时目录的最大存活时间 */
const MAX_TEMP_DIR_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * 这个函数的作用是清理依赖缓存目录中陈旧的临时目录
 * 它会删除超过指定时间阈值的临时目录，防止磁盘空间被不必要的文件占用
 * @param config
 */
export async function cleanupDepsCacheStaleDirs(
  config: ResolvedConfig
): Promise<void> {
  try {
    // 获取缓存目录的绝对路径
    const cacheDir = path.resolve(config.cacheDir);
    if (fs.existsSync(cacheDir)) {
      // 如果文件存在的话，执行以下操作

      // 读取缓存目录中的所有文件和目录
      const dirents = await fsp.readdir(cacheDir, { withFileTypes: true });

      // 遍历每个文件和目录
      for (const dirent of dirents) {
        // 筛选出名称包含“temp”的目录
        if (dirent.isDirectory() && dirent.name.includes("_temp_")) {
          // 获取临时目录的路径并获取其文件状态（fsp.stat）
          const tempDirPath = path.resolve(config.cacheDir, dirent.name);
          const stats = await fsp.stat(tempDirPath).catch((_) => null);

          // 检查临时目录的修改时间是否超过最大存活时间
          if (
            stats?.mtime &&
            Date.now() - stats.mtime.getTime() > MAX_TEMP_DIR_AGE_MS
          ) {
            // 删除超过存活时间的临时目录
            debug?.(`removing stale cache temp dir ${tempDirPath}`);
            await fsp.rm(tempDirPath, { recursive: true, force: true });
          }
        }
      }
    }
  } catch (err) {
    config.logger.error(err);
  }
}

function getDepsCacheSuffix(ssr: boolean): string {
  return ssr ? "_ssr" : "";
}

export function getDepsCacheDir(config: ResolvedConfig, ssr: boolean): string {
  return getDepsCacheDirPrefix(config) + getDepsCacheSuffix(ssr);
}

function getProcessingDepsCacheDir(config: ResolvedConfig, ssr: boolean) {
  return (
    getDepsCacheDirPrefix(config) + getDepsCacheSuffix(ssr) + getTempSuffix()
  );
}

function getTempSuffix() {
  return (
    "_temp_" +
    getHash(
      `${process.pid}:${Date.now().toString()}:${Math.random()
        .toString(16)
        .slice(2)}`
    )
  );
}

function parseDepsOptimizerMetadata(
  jsonMetadata: string,
  depsCacheDir: string
): DepOptimizationMetadata | undefined {
  const { hash, lockfileHash, configHash, browserHash, optimized, chunks } =
    JSON.parse(jsonMetadata, (key: string, value: string) => {
      // Paths can be absolute or relative to the deps cache dir where
      // the _metadata.json is located
      if (key === "file" || key === "src") {
        return normalizePath(path.resolve(depsCacheDir, value));
      }
      return value;
    });
  if (
    !chunks ||
    Object.values(optimized).some((depInfo: any) => !depInfo.fileHash)
  ) {
    // outdated _metadata.json version, ignore
    return;
  }
  const metadata = {
    hash,
    lockfileHash,
    configHash,
    browserHash,
    optimized: {},
    discovered: {},
    chunks: {},
    depInfoList: [],
  };
  for (const id of Object.keys(optimized)) {
    addOptimizedDepInfo(metadata, "optimized", {
      ...optimized[id],
      id,
      browserHash,
    });
  }
  for (const id of Object.keys(chunks)) {
    addOptimizedDepInfo(metadata, "chunks", {
      ...chunks[id],
      id,
      browserHash,
      needsInterop: false,
    });
  }
  return metadata;
}

const lockfileFormats = [
  { name: "package-lock.json", checkPatches: true, manager: "npm" },
  { name: "yarn.lock", checkPatches: true, manager: "yarn" }, // Included in lockfile for v2+
  { name: "pnpm-lock.yaml", checkPatches: false, manager: "pnpm" }, // Included in lockfile
  { name: "bun.lockb", checkPatches: true, manager: "bun" },
].sort((_, { manager }) => {
  return process.env.npm_config_user_agent?.startsWith(manager) ? 1 : -1;
});

const lockfileNames = lockfileFormats.map((l) => l.name);

/**
 * 这个函数用于生成锁文件的哈希值
 * @param config 已解析配置
 * @param ssr
 * @returns
 */
function getLockfileHash(config: ResolvedConfig, ssr: boolean): string {
  // 在项目根目录中查找锁文件（如 package-lock.json 或 yarn.lock）的路径
  const lockfilePath = lookupFile(config.root, lockfileNames);

  // 如果锁文件路径存在，读取锁文件内容：
  let content = lockfilePath ? fs.readFileSync(lockfilePath, "utf-8") : "";
  if (lockfilePath) {
    // 获取锁文件的文件名
    const lockfileName = path.basename(lockfilePath);

    // 在 lockfileFormats 数组中查找与锁文件名匹配的格式对象，并解构出 checkPatches 属性
    const { checkPatches } = lockfileFormats.find(
      (f) => f.name === lockfileName
    )!;

    // 如果 checkPatches 为 true，则检查补丁目录
    // checkPatches 是一个布尔值，指示是否需要检查补丁目录
    if (checkPatches) {
      // Default of https://github.com/ds300/patch-package
      // 补丁目录的默认路径为锁文件所在目录下的 "patches" 目录
      const fullPath = path.join(path.dirname(lockfilePath), "patches");

      // 获取补丁目录的状态信息
      const stat = tryStatSync(fullPath);

      // 如果补丁目录存在且为目录类型，将其修改时间的毫秒数追加到 content 中
      if (stat?.isDirectory()) {
        content += stat.mtimeMs.toString();
      }
    }
    /**
     * 这段代码的目的是确保在生成锁文件哈希值时，不仅考虑锁文件的内容，还要考虑补丁目录的修改时间。
     * 如果补丁目录存在且已被修改，这个变化也会反映在哈希值中，从而保证依赖优化过程能够检测到这些变化并重新进行优化
     */
  }
  return getHash(content);
}

/**
 * 这个函数用于生成配置文件的哈希值
 * @param config
 * @param ssr
 * @returns
 */
function getConfigHash(config: ResolvedConfig, ssr: boolean): string {
  // 只考虑可能影响深度优化的配置选项的子集
  // 获取依赖优化配置：
  const optimizeDeps = getDepOptimizationConfig(config, ssr);

  // 构建需要哈希的配置内容
  const content = JSON.stringify(
    {
      // 用于表示当前的运行模式
      mode: process.env.NODE_ENV || config.mode,
      root: config.root, //项目的根目录
      // 解析配置，包含了路径别名等配置信息
      resolve: config.resolve,
      // 资产包含规则，用于指定哪些文件类型应该被视为静态资源
      assetsInclude: config.assetsInclude,
      // 插件名称列表，通过 map 方法提取每个插件的名称
      plugins: config.plugins.map((p) => p.name),
      // 依赖优化配置
      optimizeDeps: {
        // include 和 exclude 字段，确保它们是唯一且排序的
        include: optimizeDeps?.include
          ? unique(optimizeDeps.include).sort()
          : undefined,
        exclude: optimizeDeps?.exclude
          ? unique(optimizeDeps.exclude).sort()
          : undefined,
        esbuildOptions: {
          ...optimizeDeps?.esbuildOptions,
          plugins: optimizeDeps?.esbuildOptions?.plugins?.map((p) => p.name),
        },
      },
    },
    // 自定义序列化行为
    (_, value) => {
      // 这个替换函数会将函数和正则表达式对象转换为字符串，以便它们能够被正确地序列化为 JSON
      if (typeof value === "function" || value instanceof RegExp) {
        return value.toString();
      }
      // 对于其他类型的值，保持原样
      return value;
    }
  );
  return getHash(content);
}

/**
 * 这个函数用于生成依赖的哈希值，包括锁文件哈希、配置文件哈希和综合哈希
 * @param config
 * @param ssr
 * @returns
 */
function getDepHash(
  config: ResolvedConfig,
  ssr: boolean
): { lockfileHash: string; configHash: string; hash: string } {
  const lockfileHash = getLockfileHash(config, ssr);
  const configHash = getConfigHash(config, ssr);
  const hash = getHash(lockfileHash + configHash);
  return {
    hash,
    lockfileHash,
    configHash,
  };
}

/**
 * 这个函数用于生成优化后的浏览器缓存哈希值
 * @param hash 综合依赖哈希值
 * @param deps 记录依赖信息的对象
 * @param timestamp 时间戳
 * @returns
 */
function getOptimizedBrowserHash(
  hash: string,
  deps: Record<string, string>,
  timestamp = ""
) {
  return getHash(hash + JSON.stringify(deps) + timestamp);
}

/**
 * 用于将手动包含在 optimizeDeps.include 中的依赖添加到依赖项记录中
 * @param deps
 * @param config
 * @param ssr
 */
export async function addManuallyIncludedOptimizeDeps(
  deps: Record<string, string>,
  config: ResolvedConfig,
  ssr: boolean
): Promise<void> {
  const { logger } = config;
  // 获取依赖项优化配置
  const optimizeDeps = getDepOptimizationConfig(config, ssr);
  // 获取 optimizeDeps.include 数组，如果未定义则默认为空数组。
  const optimizeDepsInclude = optimizeDeps?.include ?? [];

  if (optimizeDepsInclude.length) {
    /**
     * 用于记录无法优化的依赖项
     * @param id
     * @param msg
     */
    const unableToOptimize = (id: string, msg: string) => {
      if (optimizeDepsInclude.includes(id)) {
        logger.warn(
          `${msg}: ${colors.cyan(id)}, present in '${
            ssr ? "ssr." : ""
          }optimizeDeps.include'`
        );
      }
    };

    // 浅拷贝一份 include
    const includes = [...optimizeDepsInclude];

    /**
     * 这一块代码的主要功能是处理动态模式（如通配符）并将其扩展为具体的依赖项 ID
     * 这是为了确保 includes 数组中的每个元素都是具体的依赖项 ID，而不是动态模式
     */
    for (let i = 0; i < includes.length; i++) {
      const id = includes[i];
      // 如果发现动态模式，则扩展为具体的依赖项 ID 并插入到 includes 数组中

      // 检查当前的 id 是否为动态模式（如通配符）
      if (glob.isDynamicPattern(id)) {
        // 将动态模式 id 扩展为具体的依赖项 ID 数组 globIds
        const globIds = expandGlobIds(id, config);

        // 将当前的动态模式 id 替换为扩展后的具体依赖项 ID 数组 globIds
        includes.splice(i, 1, ...globIds);

        // 调整索引,由于新插入的 ID 数组长度为 globIds.length，
        // 因此需要增加 globIds.length - 1 来跳过这些新元素
        // 这样可以确保在下一次循环时不会重复处理这些新插入的具体依赖项 ID
        i += globIds.length - 1;
      }
    }

    // 创建一个依赖项解析器
    const resolve = createOptimizeDepsIncludeResolver(config, ssr);

    // 遍历 includes 数组中的每个 ID。
    for (const id of includes) {
      // 规范化 ID（处理嵌套关系符号）以确保唯一性和可读性
      //  'foo   >bar` as 'foo > bar'
      const normalizedId = normalizeId(id);

      // 如果 deps 对象中尚不存在该依赖项，则尝试解析该依赖项
      if (!deps[normalizedId]) {
        const entry = await resolve(id);
        if (entry) {
          // 如果解析成功且该依赖项可优化且未被标记为跳过优化，则将其添加到 deps 对象中
          if (isOptimizable(entry, optimizeDeps)) {
            if (!entry.endsWith("?__vite_skip_optimization")) {
              deps[normalizedId] = entry;
            }
          } else {
            // 不可优化，则记录警告信息
            unableToOptimize(id, "Cannot optimize dependency");
          }
        } else {
          // 解析失败,记录警告信息
          unableToOptimize(id, "Failed to resolve dependency");
        }
      }
    }
  }
}

/**
 * 这个函数将一个优化后的依赖信息添加到优化元数据中
 * @param metadata
 * @param type
 * @param depInfo
 * @returns
 */
export function addOptimizedDepInfo(
  metadata: DepOptimizationMetadata,
  type: "optimized" | "discovered" | "chunks",
  depInfo: OptimizedDepInfo
): OptimizedDepInfo {
  metadata[type][depInfo.id] = depInfo;
  metadata.depInfoList.push(depInfo);
  return depInfo;
}

/**
 * 这个函数将一组依赖转换为 OptimizedDepInfo 格式的记录
 * @param config
 * @param deps
 * @param ssr
 * @param timestamp
 * @returns
 */
export function toDiscoveredDependencies(
  config: ResolvedConfig,
  deps: Record<string, string>,
  ssr: boolean,
  timestamp?: string
): Record<string, OptimizedDepInfo> {
  // 计算浏览器哈希，该哈希值结合了依赖哈希值和时间戳
  const browserHash = getOptimizedBrowserHash(
    getDepHash(config, ssr).hash,
    deps,
    timestamp
  );

  const discovered: Record<string, OptimizedDepInfo> = {};
  // 遍历 deps，对于每个依赖项，生成一个 OptimizedDepInfo 对象，并添加到 discovered 记录中
  for (const id in deps) {
    const src = deps[id];
    discovered[id] = {
      id, // 依赖项的标识符
      file: getOptimizedDepPath(id, config, ssr), //优化后的依赖文件路径
      src, //依赖项的源路径
      browserHash: browserHash,
      exportsData: extractExportsData(src, config, ssr),
    };
  }
  return discovered;
}

/**
 * 这个函数生成优化后的依赖文件路径
 * @param id
 * @param config
 * @param ssr
 * @returns
 */
export function getOptimizedDepPath(
  id: string,
  config: ResolvedConfig,
  ssr: boolean
): string {
  /**
   * 通过 getDepsCacheDir 函数获取依赖缓存目录
   * 通过 flattenId 将依赖项 id 转换为一个平坦的文件名
   * 将依赖缓存目录和平坦文件名拼接，生成完整路径
   * 通过 normalizePath 函数标准化路径
   */
  return normalizePath(
    path.resolve(getDepsCacheDir(config, ssr), flattenId(id) + ".js")
  );
}

/**
 * 这个函数的主要目的是从指定的文件中提取导出数据，
 * 判断该文件是否使用了模块语法，并根据需要进行代码转换
 * @param filePath 要提取导出数据的文件路径
 * @param config
 * @param ssr
 * @returns
 */
export async function extractExportsData(
  filePath: string,
  config: ResolvedConfig,
  ssr: boolean
): Promise<ExportsData> {
  // 确保所有必要的初始化操作已完成
  await init;

  // 获取依赖优化配置
  const optimizeDeps = getDepOptimizationConfig(config, ssr);

  // 获取 esbuild 的配置选项
  const esbuildOptions = optimizeDeps?.esbuildOptions ?? {};

  // 处理自定义扩展名的文件
  if (optimizeDeps.extensions?.some((ext) => filePath.endsWith(ext))) {
    // 检查 filePath 是否匹配配置的自定义扩展名

    // For custom supported extensions, build the entry file to transform it into JS,
    // and then parse with es-module-lexer. Note that the `bundle` option is not `true`,
    // so only the entry file is being transformed.
    /**
     * 对于自定义支持的扩展名，构建入口文件将其转换为 JavaScript
     * 然后使用 es-module-lexer 解析。注意，`bundle` 选项并未启用
     * 因此仅转换入口文件
     *
     * 在依赖优化的过程中，我们需要准确识别哪些模块在项目中被使用，以及它们导出了哪些内容。
     * 这对于确保在开发环境下快速加载和处理依赖项至关重要。
     *
     * 1.自定义扩展名: 在项目配置中，可以指定一些自定义的文件扩展名，这些扩展名的文件需要特殊处理
     * 例如，某些项目可能使用 .ts 或 .jsx 扩展名的文件
     *
     * 2. 构建入口文件: 使用 esbuild 构建这些入口文件，将它们转换为 JavaScript
     * 这一步是必要的，因为许多工具和解析器（如 es-module-lexer）期望处理的是标准的 JavaScript 文件
     *
     * 3. es-module-lexer 解析: 转换完成后，使用 es-module-lexer 解析生成的 JavaScript 文件，提取其中的导出信息
     *
     * 4. bundle 选项未启用: 在构建过程中，未启用 bundle 选项。
     * 这意味着 esbuild 只转换单个入口文件，而不是递归地将它的依赖项一起打包
     * 这种方法可以提高构建速度，并确保只处理必要的部分
     */

    // 如果匹配，则使用 esbuild 构建该文件，将其转换为 JavaScript
    const result = await build({
      ...esbuildOptions,
      entryPoints: [filePath],
      write: false,
      format: "esm",
    });

    // 解析生成的 JavaScript 文件，提取导出的符号和模块语法信息
    const [, exports, , hasModuleSyntax] = parse(result.outputFiles[0].text);
    return {
      hasModuleSyntax,
      exports: exports.map((e) => e.n),
    };
  }

  // 处理常规文件

  /**用于存储解析结果 */
  let parseResult: ReturnType<typeof parse>;
  /**标志是否使用了 JSX 加载器进行转换 */
  let usedJsxLoader = false;

  // 读取文件内容
  const entryContent = await fsp.readFile(filePath, "utf-8");
  try {
    // 尝试使用 parse 函数直接解析文件内容
    parseResult = parse(entryContent);
  } catch {
    // 解析失败处理

    // 获取适当的加载器（如 JSX）用于转换文件内容
    const loader = esbuildOptions.loader?.[path.extname(filePath)] || "jsx";
    debug?.(
      `Unable to parse: ${filePath}.\n Trying again with a ${loader} transform.`
    );

    // 将文件内容转换为 JavaScript
    const transformed = await transformWithEsbuild(entryContent, filePath, {
      loader,
    });

    // 转换后的代码再次使用 parse 函数进行解析
    parseResult = parse(transformed.code);
    // 设置为 true，表示使用了 JSX 加载器
    usedJsxLoader = true;
  }

  // 构建 exportsData 对象
  const [, exports, , hasModuleSyntax] = parseResult;
  const exportsData: ExportsData = {
    hasModuleSyntax,
    exports: exports.map((e) => e.n),
    jsxLoader: usedJsxLoader,
  };
  return exportsData;
}

/**
 * 这个函数的目的是执行初始的依赖扫描，以发现需要预构建的依赖项，并包括用户手动指定的依赖项
 * 它使用 esbuild 来进行快速扫描，目的是尽早找到需要打包的依赖项
 * @param config
 * @returns
 */
export function discoverProjectDependencies(config: ResolvedConfig): {
  cancel: () => Promise<void>;
  result: Promise<Record<string, string>>;
} {
  /**
   * cancel: 一个函数，调用后会取消扫描任务
   * result: 一个 Promise，其解析结果是一个对象，包含两个属性：
   * deps: 发现的依赖项，格式为 { [id: string]: string }
   * missing: 未能解析的依赖项，格式为 { [id: string]: string }，其中 id 是依赖项的标识符，值是其导入来源
   */
  const { cancel, result } = scanImports(config);

  return {
    cancel,
    result: result.then(({ deps, missing }) => {
      const missingIds = Object.keys(missing);
      if (missingIds.length) {
        throw new Error(
          `The following dependencies are imported but could not be resolved:\n\n  ${missingIds
            .map(
              (id) =>
                `${colors.cyan(id)} ${colors.white(
                  colors.dim(`(imported by ${missing[id]})`)
                )}`
            )
            .join(`\n  `)}\n\nAre they installed?`
        );
      }

      return deps;
    }),
  };
}

/**
 * 它在 Vite 启动时准备运行 optimizeDeps，并且在不需要等待 optimizeDeps 处理完成的情况下启动服务器
 * 核心是通过esbuild 来处理结果
 *
 * @param resolvedConfig Vite 解析后的配置
 * @param depsInfo 依赖信息的记录
 * @param ssr
 * @returns
 */
export function runOptimizeDeps(
  resolvedConfig: ResolvedConfig,
  depsInfo: Record<string, OptimizedDepInfo>,
  ssr: boolean
): {
  cancel: () => Promise<void>;
  result: Promise<DepOptimizationResult>;
} {
  // 初始化优化器上下文和配置
  const optimizerContext = { cancelled: false };

  // 将其命令设置为 "build"
  const config: ResolvedConfig = {
    ...resolvedConfig,
    command: "build",
  };

  /**依赖缓存目录 */
  const depsCacheDir = getDepsCacheDir(resolvedConfig, ssr);
  /**处理缓存目录，这是一个临时目录 */
  const processingCacheDir = getProcessingDepsCacheDir(resolvedConfig, ssr);

  /**
   * 这里解释为什么创建一个临时目录是有必要的
   *
   * 1. 创建一个临时目录的主要目的是为了在优化依赖（optimized deps）被处理完之前不需要删除它们
   * 临时目录的存在可以确保在整个优化过程结束之前，所有的依赖文件都安全地保存在一个隔离的地方
   * 2. 如果在处理依赖过程中出现错误，临时目录的使用可以避免将依赖缓存目录（deps cache directory）
   * 留在一个损坏的状态。这意味着，即使过程中出现问题，原本的依赖缓存目录仍然保持完整和未受影响。
   */

  //  确保所有嵌套的子目录也会被创建
  fs.mkdirSync(processingCacheDir, { recursive: true });

  debug?.(colors.green(`creating package.json in ${processingCacheDir}`));
  // 在 processingCacheDir 目录中创建并写入一个 package.json 文件
  // 这个 package.json 文件的内容是 {"type": "module"}，这会提示 Node.js 将目录中的所有文件识别为 ES 模块
  fs.writeFileSync(
    path.resolve(processingCacheDir, "package.json"),
    `{\n  "type": "module"\n}\n`
  );

  // 初始化依赖优化器的元数据
  const metadata = initDepsOptimizerMetadata(config, ssr);

  // 算浏览器哈希值：用于标识优化后的依赖在浏览器中的唯一性
  metadata.browserHash = getOptimizedBrowserHash(
    metadata.hash,
    depsFromOptimizedDepInfo(depsInfo)
  );

  // We prebundle dependencies with esbuild and cache them, but there is no need
  // to wait here. Code that needs to access the cached deps needs to await
  // the optimizedDepInfo.processing promise for each dep
  /**
   * 这段注释解释了依赖项的预打包和缓存机制，以及代码如何访问这些缓存的依赖项
   *
   * 1. 预打包依赖项并缓存：依赖项会通过 esbuild 进行预打包，并且结果会被缓存起来。
   * 预打包的目的是为了提高依赖项加载的性能和效率。
   * 预打包和缓存的过程可以在后台进行，代码不需要等待预打包和缓存完成就可以继续执行
   * 这种非阻塞的方式可以提高代码执行效率
   *
   * 2. 访问缓存的依赖项：如果代码需要访问已经缓存的依赖项，需要等待每个依赖项的 optimizedDepInfo.processing 这个Promise
   * 这是因为依赖项的预打包和缓存是异步操作，代码需要等待这些操作完成才能确保依赖项已经被正确缓存
   */

  /**存储 depsInfo 对象的所有键（即依赖项的 ID） */
  const qualifiedIds = Object.keys(depsInfo);
  // 用于跟踪是否已经执行了清理或提交操作
  let cleaned = false;
  let committed = false;

  /**清理函数 */
  const cleanUp = () => {
    // 如果提交操作已经执行，即使请求取消也会忽略清理操作。
    // 这样做的目的是为了减少依赖缓存目录（deps cache）处于损坏状态的风险
    if (!cleaned && !committed) {
      cleaned = true;

      // 清理可以在后台进行，因为临时文件夹是每次运行唯一的。无需等待清理完成，清理可以异步进行
      debug?.(colors.green(`removing cache dir ${processingCacheDir}`));
      try {
        // 使用 fs.rmSync 同步地删除 processingCacheDir 目录，因为在进程退出时，异步的 fsp.rm 可能不会生效
        fs.rmSync(processingCacheDir, { recursive: true, force: true });
      } catch (error) {
        // Ignore errors
      }
    }
  };

  const successfulResult: DepOptimizationResult = {
    metadata,
    cancel: cleanUp,
    commit: async () => {
      if (cleaned) {
        throw new Error(
          "Can not commit a Deps Optimization run as it was cancelled"
        );
      }
      // 在这个步骤之后，不再处理清理请求，以确保在完成新依赖缓存文件提交之前，临时文件夹不会被删除
      // 一旦 committed 被设置为 true，cleanUp 函数的逻辑将不再执行删除操作
      // 这是为了避免在提交过程中临时文件夹被意外删除，从而导致依赖缓存目录不一致或损坏
      committed = true;

      // 下面代码的主要作用就是：写入元数据文件,将处理文件夹提交到全局依赖缓存,
      // 将临时处理目录的文件路径重定向到最终依赖缓存目录

      // 获取元数据路径
      const dataPath = path.join(processingCacheDir, METADATA_FILENAME);
      debug?.(
        colors.green(`creating ${METADATA_FILENAME} in ${processingCacheDir}`)
      );

      // 写入元数据文件：确保处理目录中包含最新的依赖优化元数据
      fs.writeFileSync(
        dataPath,
        stringifyDepsOptimizerMetadata(metadata, depsCacheDir)
      );

      /**
       * 源码中这段注释解释了在重命名和删除依赖缓存目录时采取的步骤和原因：
       *
       * 1. 通过在重命名过程中采取一些措施，尽量减少依赖缓存目录不一致的时间
       *
       * 2. 先将旧的依赖缓存目录重命名到一个临时路径，再将新的处理缓存目录重命名为最终的依赖缓存目录，
       * 可以确保在整个过程中，依赖缓存目录始终处于一致状态
       *
       * 3. 在那些可以安全同步完成重命名操作的系统中，执行原子操作（至少对于当前线程而言），以确保操作的一致性
       *
       * 4. 在 Windows 系统中，重命名操作有时会提前结束，但实际上并未完成
       * 因此，需要进行优雅的重命名操作，确保文件夹已经正确重命名
       *
       * 5. 通过先重命名旧文件夹再重命名新文件夹（然后在后台删除旧文件夹）的方式，
       * 比直接删除旧文件夹再重命名新文件夹更加安全
       *
       */

      /**旧的依赖缓存目录加上一个临时后缀，用于生成临时路径 */
      const temporaryPath = depsCacheDir + getTempSuffix();

      /**检查 depsCacheDir 目录是否存在 */
      const depsCacheDirPresent = fs.existsSync(depsCacheDir);
      if (isWindows) {
        // Windows 系统的重命名操作
        if (depsCacheDirPresent) {
          // 缓存目录存在
          debug?.(colors.green(`renaming ${depsCacheDir} to ${temporaryPath}`));

          // 将 depsCacheDir 重命名为 temporaryPath safeRename 是异步函数
          await safeRename(depsCacheDir, temporaryPath);
        }
        debug?.(
          colors.green(`renaming ${processingCacheDir} to ${depsCacheDir}`)
        );

        // 将 processingCacheDir 重命名为 depsCacheDir
        await safeRename(processingCacheDir, depsCacheDir);
      } else {
        // 非 Windows 系统的重命名操作
        if (depsCacheDirPresent) {
          debug?.(colors.green(`renaming ${depsCacheDir} to ${temporaryPath}`));
          // 将 depsCacheDir 重命名为 temporaryPath，renameSync 是同步函数
          fs.renameSync(depsCacheDir, temporaryPath);
        }
        debug?.(
          colors.green(`renaming ${processingCacheDir} to ${depsCacheDir}`)
        );
        // 将 processingCacheDir 重命名为 depsCacheDir
        fs.renameSync(processingCacheDir, depsCacheDir);
      }

      // Delete temporary path in the background
      if (depsCacheDirPresent) {
        debug?.(colors.green(`removing cache temp dir ${temporaryPath}`));
        // 台删除临时目录 temporaryPath
        fsp.rm(temporaryPath, { recursive: true, force: true });
      }
    },
  };

  // 检查是否有依赖项需要优化
  if (!qualifiedIds.length) {
    // No deps to optimize, we still commit the processing cache dir to remove
    // the previous optimized deps if they exist, and let the next server start
    // skip the scanner step if the lockfile hasn't changed

    /**
     * 这段注释解释了在没有需要优化的依赖项时，为什么依然需要处理临时缓存目录
     *
     * 1. 即使没有需要优化的依赖项，仍然需要提交处理缓存目录（processingCacheDir），以确保删除之前可能存在的优化依赖项。
     * 这有助于清理过时的缓存数据，并保持依赖缓存目录的整洁。
     *
     * 2. 为下一次优化或服务器启动做好准备
     *
     * 3. 如果 lockfile（如 package-lock.json 或 yarn.lock）没有发生变化，则跳过扫描步骤
     * 这是因为锁文件的变化通常表示依赖项的变更，而锁文件没有变化通常表示依赖项没有变化，因此可以省略不必要的扫描
     */

    // 如果没有依赖项需要优化，直接返回成功的结果并处理清理操作
    return {
      cancel: async () => cleanUp(),
      result: Promise.resolve(successfulResult),
    };
  }

  /** 用于处理优化被取消的情况 */
  const cancelledResult: DepOptimizationResult = {
    metadata,
    commit: async () => cleanUp(),
    cancel: cleanUp,
  };

  const start = performance.now();

  // 用于准备 esbuild 优化器的运行
  const preparedRun = prepareEsbuildOptimizerRun(
    resolvedConfig, // 已解析的配置
    depsInfo, // 依赖项的信息
    ssr,
    processingCacheDir, // 处理缓存目录
    optimizerContext // 优化器上下文
  );

  /**
   * 这里是处理 esbuild 的优化结果，并处理优化过程中可能出现的各种情况
   */
  const runResult = preparedRun.then(({ context, idToExports }) => {
    // context 是 esbuild 的构建上下文，idToExports 是模块的导出信息映射

    /**
     * 用于处理 esbuild 上下文的清理。即使在处理过程中发生错误，也会尝试记录错误日志。
     * @returns
     */
    function disposeContext() {
      return context?.dispose().catch((e) => {
        config.logger.error("Failed to dispose esbuild context", { error: e });
      });
    }

    // context 不存在或者优化器上下文已被取消
    if (!context || optimizerContext.cancelled) {
      // 这处理了优化过程被取消的情况，避免了不必要的操作
      disposeContext();
      return cancelledResult;
    }

    // 调用 rebuild 方法重新构建。该方法会返回一个包含构建结果的 Promise
    return context
      .rebuild()
      .then((result) => {
        const meta = result.metafile!;

        // 缓存输出路径
        const processingCacheDirOutputPath = path.relative(
          process.cwd(),
          processingCacheDir
        );

        // 遍历 depsInfo
        for (const id in depsInfo) {
          // 从 meta.outputs 中提取每个依赖项的输出。
          const output = esbuildOutputFromId(
            meta.outputs,
            id,
            processingCacheDir
          );

          // 提取 exportsData 和其他属性，exportsData 是关于模块导出的数据
          const { exportsData, ...info } = depsInfo[id];
          // 将优化后的依赖项信息添加到 metadata 对象中
          addOptimizedDepInfo(metadata, "optimized", {
            ...info,
            // 生成一个唯一的文件哈希值，用于标识优化后的依赖项
            // 这个哈希值用于检查依赖项的稳定性，确保依赖项在不同优化运行中的一致性
            fileHash: getHash(
              metadata.hash + depsInfo[id].file + JSON.stringify(output.imports)
            ),
            browserHash: metadata.browserHash,
            // After bundling we have more information and can warn the user about legacy packages
            // that require manual configuration
            // 计算是否需要额外的兼容性处理，如 esm 和cjs 混用
            needsInterop: needsInterop(
              config,
              ssr,
              id,
              idToExports[id],
              output
            ),
          });
        }

        // 处理输出文件，并将其中的 JavaScript 文件路径转换为优化后的依赖项信息
        for (const o of Object.keys(meta.outputs)) {
          // 检查文件路径是否匹配.js.map 结尾，过滤到sourcemap 文件的处理
          if (!jsMapExtensionRE.test(o)) {
            // 处理不匹配的情况

            // 计算文件的相对路径并去掉文件扩展名（.js）
            const id = path
              .relative(processingCacheDirOutputPath, o)
              .replace(jsExtensionRE, "");

            // 获取优化后的依赖文件路径
            const file = getOptimizedDepPath(id, resolvedConfig, ssr);
            if (
              // 检查 metadata.optimized 中是否已存在该文件的优化依赖项信息
              !findOptimizedDepInfoInRecord(
                metadata.optimized,
                (depInfo) => depInfo.file === file
              )
            ) {
              // 如果没有找到相应的优化依赖项信息，将新的优化信息添加到 metadata 的 "chunks" 部分
              addOptimizedDepInfo(metadata, "chunks", {
                id,
                file,
                needsInterop: false,
                browserHash: metadata.browserHash,
              });
            }
          }
        }

        debug?.(
          `Dependencies bundled in ${(performance.now() - start).toFixed(2)}ms`
        );

        return successfulResult;
      })

      .catch((e) => {
        if (e.errors && e.message.includes("The build was canceled")) {
          // esbuild logs an error when cancelling, but this is expected so
          // return an empty result instead
          return cancelledResult;
        }
        throw e;
      })
      .finally(() => {
        return disposeContext();
      });
  });

  runResult.catch(() => {
    cleanUp();
  });

  return {
    async cancel() {
      optimizerContext.cancelled = true;
      const { context } = await preparedRun;
      await context?.cancel();
      cleanUp();
    },
    result: runResult,
  };
}

// Convert to { id: src }
export function depsFromOptimizedDepInfo(
  depsInfo: Record<string, OptimizedDepInfo>
): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const key in depsInfo) {
    obj[key] = depsInfo[key].src!;
  }
  return obj;
}

/**
 * Stringify metadata for deps cache. Remove processing promises
 * and individual dep info browserHash. Once the cache is reload
 * the next time the server start we need to use the global
 * browserHash to allow long term caching
 */

/**
 * 用于将优化器的元数据（metadata）序列化为 JSON 格式，以便存储到缓存中
 * 它将处理过的元数据转化为 JSON 字符串，同时去除处理中的 Promise 和每个依赖项的 browserHash，以确保缓存的持久性
 *
 * @param metadata
 * @param depsCacheDir 依赖缓存目录的路径
 * @returns
 */
function stringifyDepsOptimizerMetadata(
  metadata: DepOptimizationMetadata,
  depsCacheDir: string
) {
  // 从元数据中提取一些信息
  const { hash, configHash, lockfileHash, browserHash, optimized, chunks } =
    metadata;

  // 序列化处理
  return JSON.stringify(
    {
      hash,
      configHash,
      lockfileHash,
      browserHash,
      //  将 optimized 对象的每个条目转换为 id 和一个包含 src、file、fileHash 和 needsInterop 的新对象
      /**
       * 说一下这个的 map、fromEntries 为什么要这样处理
       *
       * 最终想要转化的类型是一个对象，{ id:{src,file,fileHash,needsInterop} }
       *
       * 1. 从optimized 中提取所有的value
       * 2. 遍历这个arr，返回 [ [id,{src,file,fileHash,needsIntero}]... ]
       * 3. 通过Object.fromEntries 可以将一个键值对数组，转化为一个新的对象
       * 键值对数组的每个元素（子数组）的第一个元素作为键，第二个元素作为值。
       *
       * 这样就得到了想要的结构
       */
      optimized: Object.fromEntries(
        Object.values(optimized).map(
          ({ id, src, file, fileHash, needsInterop }) => [
            id,
            {
              src,
              file,
              fileHash,
              needsInterop,
            },
          ]
        )
      ),
      // 将 chunks 对象的每个条目转换为 id 和一个包含 file 的新对象
      chunks: Object.fromEntries(
        Object.values(chunks).map(({ id, file }) => [id, { file }])
      ),
    },
    (key: string, value: string) => {
      // Paths can be absolute or relative to the deps cache dir where
      // the _metadata.json is located
      if (key === "file" || key === "src") {
        // 将路径从绝对路径转换为相对于 depsCacheDir 的相对路径，并规范化路径
        return normalizePath(path.relative(depsCacheDir, value));
      }
      // 其他值保持不变
      return value;
    },
    // 第三个参数，以便在输出 JSON 时进行格式化，使其更具可读性（即缩进为 2 个空格）
    2
  );
}

/**
 * 这个函数是一个用于准备 esbuild 优化器运行的异步函数
 * 主要作用是配置和启动 esbuild 构建过程，用于预打包依赖项并生成优化的依赖项信息
 * @param resolvedConfig
 * @param depsInfo 包含了所有需要优化的依赖项的信息
 * @param ssr
 * @param processingCacheDir 用于存储临时处理文件的目录路径
 * @param optimizerContext 包含了取消标志，用于指示优化过程是否已被取消
 * @returns
 *  context  esbuild 的构建上下文，用于管理和控制构建过程
 *  idToExports 记录了每个依赖项的导出数据
 */
async function prepareEsbuildOptimizerRun(
  resolvedConfig: ResolvedConfig,
  depsInfo: Record<string, OptimizedDepInfo>,
  ssr: boolean,
  processingCacheDir: string,
  optimizerContext: { cancelled: boolean }
): Promise<{
  context?: BuildContext;
  idToExports: Record<string, ExportsData>;
}> {
  // 拷贝一份配置，并且设置命令为 build
  const config: ResolvedConfig = {
    ...resolvedConfig,
    command: "build",
  };

  /**
   * 这段注释解释了 esbuild 生成嵌套目录输出的行为及其处理方式
   *
   * 1. 嵌套目录输出：
   * esbuild在生成输出文件时，会根据输入文件的路径创建嵌套的目录结构
   * 这种方式的一个问题是，它可能会根据输入文件的共同祖先路径创建目录，从而使得输入/输出映射变得难以预测和分析
   *
   * 2. 解决方案：
   * a. 扁平化所有ID：通过消除路径中的斜杠来扁平化所有ID.
   *    这意味着将类似a/b/c.js的路径转换成一个扁平化的ID，比如a-b-c.js
   *    这样可以避免生成嵌套的目录结构，从而简化了输入/输出映射。
   *
   * b. 在插件中读取入口文件作为虚拟文件: 在插件中自行读取入口文件，以保留路径信息
   *    虽然ID被扁平化了，但通过插件读取入口文件可以保留其原始路径信息
   *    这样做的好处是，在保留路径信息的同时，可以避免嵌套目录输出的问题
   */

  /**存储扁平化后的依赖ID和其对应的源路径 */
  const flatIdDeps: Record<string, string> = {};
  /**存储依赖ID和其对应的导出数据 */
  const idToExports: Record<string, ExportsData> = {};

  /** 从config里面 获取依赖优化配置 */
  const optimizeDeps = getDepOptimizationConfig(config, ssr);

  // 从优化配置中结构出 esbuild的插件以及其他 esbuild配置
  const { plugins: pluginsFromConfig = [], ...esbuildOptions } =
    optimizeDeps?.esbuildOptions ?? {};

  // 并行处理每个依赖项
  await Promise.all(
    // depsInfo：包含所有依赖项的信息
    Object.keys(depsInfo).map(async (id) => {
      // 对每个依赖项ID进行异步处理

      // 获取依赖项的源路径
      const src = depsInfo[id].src!;

      // 获取或提取依赖项的导出数据
      const exportsData = await (depsInfo[id].exportsData ??
        extractExportsData(src, config, ssr));

      // 检查导出数据中是否包含JSX加载器标记，如果这个标记为true，表示该依赖项包含JSX语法
      // 检查esbuild选项中是否已经指定了.js文件的加载器
      if (exportsData.jsxLoader && !esbuildOptions.loader?.[".js"]) {
        // 将.js文件的加载器设置为jsx，以确保优化过程中不会失败，这对像Gatsby这样的包很有用
        // 确保了所有.js文件在优化过程中都会使用JSX加载器进行处理，从而避免语法错误。

        // JSX是一种语法扩展，通常用于React项目中，后缀名可以为.js 也可以为.jsx，
        // 因此需要通过特定的编译器或加载器（如Babel或esbuild的JSX加载器）来处理。
        esbuildOptions.loader = {
          ".js": "jsx",
          ...esbuildOptions.loader,
        };
      }

      // 将依赖ID扁平化，消除路径中的斜杠
      const flatId = flattenId(id);
      // 存储扁平化后的依赖ID和其源路径的映射关系
      flatIdDeps[flatId] = src;
      // 存储依赖ID和其导出数据的映射关系
      idToExports[id] = exportsData;
    })
  );

  // 如果被取消，则直接返回，避免不必要的构建工作
  if (optimizerContext.cancelled) return { context: undefined, idToExports };

  // 定义全局变量，用于替换构建过程中process.env.NODE_ENV的值
  const define = {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || config.mode),
  };

  // 设置平台
  const platform =
    ssr && config.ssr?.target !== "webworker" ? "node" : "browser";

  // 获取需要排除的依赖列表，这些依赖不会被打包进最终的构建中
  const external = [...(optimizeDeps?.exclude ?? [])];

  // 将配置中的插件复制到plugins数组中
  const plugins = [...pluginsFromConfig];

  if (external.length) {
    // 如果有需要排除的依赖，添加esbuildCjsExternalPlugin插件
    plugins.push(esbuildCjsExternalPlugin(external, platform));
  }

  // 添加自定义的esbuildDepPlugin插件用于处理依赖优化逻辑
  plugins.push(esbuildDepPlugin(flatIdDeps, external, config, ssr));

  // 调用esbuild.context创建构建上下文
  const context = await esbuild.context({
    // 设置当前工作目录为进程的当前工作目录
    absWorkingDir: process.cwd(),
    //  指定构建入口点，这里是flatIdDeps的键数组
    entryPoints: Object.keys(flatIdDeps),
    bundle: true, //  启用打包
    /**
     * neutral：
     * 在esbuild中，平台设置为neutral表示构建的代码既不专门为浏览器也不专门为Node.js环境设计
     * 这种设置在某些场景下可能很有用，但在这里并不适用
     *
     * node：
     * 针对Node.js环境的构建，esbuild会有一些特定的处理，如支持require等Node.js特有的语法
     *
     * browser：
     * 针对浏览器环境的构建，esbuild会处理浏览器特有的语法和特性
     *
     * 由于esbuild对node和browser平台有特定的处理方式（如根据mainFields和条件处理模块入口），
     * 这些处理方式在'neutral'平台中无法模拟
     */
    platform, //设置构建平台，值为"node"或"browser"
    define, //定义全局变量，将process.env.NODE_ENV替换为构建模式
    format: "esm", //输出格式为"esm"
    // See https://github.com/evanw/esbuild/issues/1921#issuecomment-1152991694

    //  如果平台是node，则添加一个banner，用于支持import语法
    banner:
      platform === "node"
        ? {
            js: `import { createRequire } from 'module';const require = createRequire(import.meta.url);`,
          }
        : undefined,
    target: ESBUILD_MODULES_TARGET, // 设置构建目标环境
    external, //指定排除的依赖
    logLevel: "error", //设置日志级别为"error"
    splitting: true, // 启用代码拆分
    sourcemap: true, //启用源映射
    outdir: processingCacheDir, //设置输出目录为processingCacheDir
    ignoreAnnotations: true, //忽略注解
    metafile: true, //启用元文件生成
    plugins, //使用前面定义的插件数组
    charset: "utf8", //设置字符集为"utf8"
    ...esbuildOptions, // 合并用户自定义的esbuild选项

    //  合并默认支持的esbuild功能和用户自定义的支持功能
    supported: {
      ...defaultEsbuildSupported,
      ...esbuildOptions.supported,
    },
  });
  return { context, idToExports };
}

/**
 * 这个函数的作用是从 esbuild 的输出结果中找到特定 ID 对应的输出文件信息
 * @param outputs  一个包含 esbuild 输出结果的对象，键是输出文件的路径，值是输出文件的信息
 * @param id 要查找的依赖项的 ID
 * @param cacheDirOutputPath 缓存目录的输出路径
 * @returns
 */
function esbuildOutputFromId(
  outputs: Record<string, any>,
  id: string,
  cacheDirOutputPath: string
): any {
  // 获取当前工作目录的路径
  const cwd = process.cwd();
  // 将 ID 扁平化，去除可能存在的路径分隔符
  const flatId = flattenId(id) + ".js";
  // 生成标准化的输出路径
  const normalizedOutputPath = normalizePath(
    path.relative(cwd, path.join(cacheDirOutputPath, flatId))
  );

  // 尝试直接从 outputs 中查找标准化后的输出路径对应的输出信息
  const output = outputs[normalizedOutputPath];
  if (output) {
    return output;
  }

  // 如果根目录被符号链接了，esbuild 返回的输出键可能包含类似 ../cwd/ 的路径
  // 规范化键来支持这种情况

  // 遍历 outputs 对象的所有键值对，对每个键进行标准化处理
  for (const [key, value] of Object.entries(outputs)) {
    if (normalizePath(path.relative(cwd, key)) === normalizedOutputPath) {
      // 如果找到了匹配的路径，返回对应的输出信息
      return value;
    }
  }
}

/**
 * 这个函数的作用是在 dependenciesInfo 对象中找到满足 callbackFn 条件的第一个 OptimizedDepInfo 对象
 * @param dependenciesInfo
 * @param callbackFn
 * @returns
 */
function findOptimizedDepInfoInRecord(
  dependenciesInfo: Record<string, OptimizedDepInfo>,
  callbackFn: (depInfo: OptimizedDepInfo, id: string) => any
): OptimizedDepInfo | undefined {
  for (const o of Object.keys(dependenciesInfo)) {
    const info = dependenciesInfo[o];
    if (callbackFn(info, o)) {
      return info;
    }
  }
}

/**
 * 这个函数用于判断是否需要在构建过程中强制使用 interop，主要用于处理依赖项的优化和模块化问题
 * @param config
 * @param ssr
 * @param id
 * @param exportsData 依赖项导出的元数据，包括是否具有模块语法 (hasModuleSyntax) 和导出数组 (exports)。
 * @param output
 * @returns
 */
function needsInterop(
  config: ResolvedConfig,
  ssr: boolean,
  id: string,
  exportsData: ExportsData,
  output?: { exports: string[] }
): boolean {
  // 检查配置中是否明确指定了需要 interop 的依赖项
  if (getDepOptimizationConfig(config, ssr)?.needsInterop?.includes(id)) {
    return true;
  }

  const { hasModuleSyntax, exports } = exportsData;
  // 检查依赖项是否使用了非 ES 模块语法 (!hasModuleSyntax),如 CJS,UMD
  if (!hasModuleSyntax) {
    return true;
  }

  // 如果提供了输出信息,则进一步检查
  if (output) {
    // if a peer dependency used require() on an ESM dependency, esbuild turns the
    // ESM dependency's entry chunk into a single default export... detect
    // such cases by checking exports mismatch, and force interop.
    // 进一步检查生成的导出数组
    const generatedExports: string[] = output.exports;

    if (
      // 导出数组是否存在
      !generatedExports ||
      // 是否与实际导出数组 (exports) 存在差异
      (isSingleDefaultExport(generatedExports) &&
        !isSingleDefaultExport(exports))
    ) {
      return true;
    }
  }

  // 返回 false，表示不需要强制 interop
  return false;
}

/**
 * 检查 exports 数组是否只包含一个元素且该元素为 "default"。
 * @param exports
 * @returns
 */
function isSingleDefaultExport(exports: readonly string[]) {
  return exports.length === 1 && exports[0] === "default";
}

// We found issues with renaming folders in some systems. This is a custom
// implementation for the optimizer. It isn't intended to be a general utility

// Based on node-graceful-fs

// The ISC License
// Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors
// https://github.com/isaacs/node-graceful-fs/blob/main/LICENSE

// On Windows, A/V software can lock the directory, causing this
// to fail with an EACCES or EPERM if the directory contains newly
// created files. The original tried for up to 60 seconds, we only
// wait for 5 seconds, as a longer time would be seen as an error

const GRACEFUL_RENAME_TIMEOUT = 5000;
const safeRename = promisify(function gracefulRename(
  from: string,
  to: string,
  cb: (error: NodeJS.ErrnoException | null) => void
) {
  const start = Date.now();
  let backoff = 0;
  fs.rename(from, to, function CB(er) {
    if (
      er &&
      (er.code === "EACCES" || er.code === "EPERM") &&
      Date.now() - start < GRACEFUL_RENAME_TIMEOUT
    ) {
      setTimeout(function () {
        fs.stat(to, function (stater, st) {
          if (stater && stater.code === "ENOENT") fs.rename(from, to, CB);
          else CB(er);
        });
      }, backoff);
      if (backoff < 100) backoff += 10;
      return;
    }
    if (cb) cb(er);
  });
});

export async function optimizedDepNeedsInterop(
  metadata: DepOptimizationMetadata,
  file: string,
  config: ResolvedConfig,
  ssr: boolean
): Promise<boolean | undefined> {
  const depInfo = optimizedDepInfoFromFile(metadata, file);
  if (depInfo?.src && depInfo.needsInterop === undefined) {
    depInfo.exportsData ??= extractExportsData(depInfo.src, config, ssr);
    depInfo.needsInterop = needsInterop(
      config,
      ssr,
      depInfo.id,
      await depInfo.exportsData
    );
  }
  return depInfo?.needsInterop;
}
