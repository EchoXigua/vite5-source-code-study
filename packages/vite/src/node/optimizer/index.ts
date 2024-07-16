import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
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
  // defaultEsbuildSupported,
  transformWithEsbuild,
} from "../plugins/esbuild";
import { ESBUILD_MODULES_TARGET, METADATA_FILENAME } from "../constants";
import { createOptimizeDepsIncludeResolver, expandGlobIds } from "./resolve";
import { scanImports } from "./scan";

const debug = createDebugger("vite:deps");

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
 * Internally, Vite uses this function to prepare a optimizeDeps run. When Vite starts, we can get
 * the metadata and start the server without waiting for the optimizeDeps processing to be completed
 */
export function runOptimizeDeps(
  resolvedConfig: ResolvedConfig,
  depsInfo: Record<string, OptimizedDepInfo>,
  ssr: boolean
): {
  cancel: () => Promise<void>;
  result: Promise<DepOptimizationResult>;
} {
  const optimizerContext = { cancelled: false };

  const config: ResolvedConfig = {
    ...resolvedConfig,
    command: "build",
  };

  const depsCacheDir = getDepsCacheDir(resolvedConfig, ssr);
  const processingCacheDir = getProcessingDepsCacheDir(resolvedConfig, ssr);

  // Create a temporary directory so we don't need to delete optimized deps
  // until they have been processed. This also avoids leaving the deps cache
  // directory in a corrupted state if there is an error
  fs.mkdirSync(processingCacheDir, { recursive: true });

  // a hint for Node.js
  // all files in the cache directory should be recognized as ES modules
  debug?.(colors.green(`creating package.json in ${processingCacheDir}`));
  fs.writeFileSync(
    path.resolve(processingCacheDir, "package.json"),
    `{\n  "type": "module"\n}\n`
  );

  const metadata = initDepsOptimizerMetadata(config, ssr);

  metadata.browserHash = getOptimizedBrowserHash(
    metadata.hash,
    depsFromOptimizedDepInfo(depsInfo)
  );

  // We prebundle dependencies with esbuild and cache them, but there is no need
  // to wait here. Code that needs to access the cached deps needs to await
  // the optimizedDepInfo.processing promise for each dep

  const qualifiedIds = Object.keys(depsInfo);
  let cleaned = false;
  let committed = false;
  const cleanUp = () => {
    // If commit was already called, ignore the clean up even if a cancel was requested
    // This minimizes the chances of leaving the deps cache in a corrupted state
    if (!cleaned && !committed) {
      cleaned = true;
      // No need to wait, we can clean up in the background because temp folders
      // are unique per run
      debug?.(colors.green(`removing cache dir ${processingCacheDir}`));
      try {
        // When exiting the process, `fsp.rm` may not take effect, so we use `fs.rmSync`
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
      // Ignore clean up requests after this point so the temp folder isn't deleted before
      // we finish commiting the new deps cache files to the deps folder
      committed = true;

      // Write metadata file, then commit the processing folder to the global deps cache
      // Rewire the file paths from the temporary processing dir to the final deps cache dir
      const dataPath = path.join(processingCacheDir, METADATA_FILENAME);
      debug?.(
        colors.green(`creating ${METADATA_FILENAME} in ${processingCacheDir}`)
      );
      fs.writeFileSync(
        dataPath,
        stringifyDepsOptimizerMetadata(metadata, depsCacheDir)
      );

      // In order to minimize the time where the deps folder isn't in a consistent state,
      // we first rename the old depsCacheDir to a temporary path, then we rename the
      // new processing cache dir to the depsCacheDir. In systems where doing so in sync
      // is safe, we do an atomic operation (at least for this thread). For Windows, we
      // found there are cases where the rename operation may finish before it's done
      // so we do a graceful rename checking that the folder has been properly renamed.
      // We found that the rename-rename (then delete the old folder in the background)
      // is safer than a delete-rename operation.
      const temporaryPath = depsCacheDir + getTempSuffix();
      const depsCacheDirPresent = fs.existsSync(depsCacheDir);
      if (isWindows) {
        if (depsCacheDirPresent) {
          debug?.(colors.green(`renaming ${depsCacheDir} to ${temporaryPath}`));
          await safeRename(depsCacheDir, temporaryPath);
        }
        debug?.(
          colors.green(`renaming ${processingCacheDir} to ${depsCacheDir}`)
        );
        await safeRename(processingCacheDir, depsCacheDir);
      } else {
        if (depsCacheDirPresent) {
          debug?.(colors.green(`renaming ${depsCacheDir} to ${temporaryPath}`));
          fs.renameSync(depsCacheDir, temporaryPath);
        }
        debug?.(
          colors.green(`renaming ${processingCacheDir} to ${depsCacheDir}`)
        );
        fs.renameSync(processingCacheDir, depsCacheDir);
      }

      // Delete temporary path in the background
      if (depsCacheDirPresent) {
        debug?.(colors.green(`removing cache temp dir ${temporaryPath}`));
        fsp.rm(temporaryPath, { recursive: true, force: true });
      }
    },
  };

  if (!qualifiedIds.length) {
    // No deps to optimize, we still commit the processing cache dir to remove
    // the previous optimized deps if they exist, and let the next server start
    // skip the scanner step if the lockfile hasn't changed
    return {
      cancel: async () => cleanUp(),
      result: Promise.resolve(successfulResult),
    };
  }

  const cancelledResult: DepOptimizationResult = {
    metadata,
    commit: async () => cleanUp(),
    cancel: cleanUp,
  };

  const start = performance.now();

  const preparedRun = prepareEsbuildOptimizerRun(
    resolvedConfig,
    depsInfo,
    ssr,
    processingCacheDir,
    optimizerContext
  );

  const runResult = preparedRun.then(({ context, idToExports }) => {
    function disposeContext() {
      return context?.dispose().catch((e) => {
        config.logger.error("Failed to dispose esbuild context", { error: e });
      });
    }
    if (!context || optimizerContext.cancelled) {
      disposeContext();
      return cancelledResult;
    }

    return context
      .rebuild()
      .then((result) => {
        const meta = result.metafile!;

        // the paths in `meta.outputs` are relative to `process.cwd()`
        const processingCacheDirOutputPath = path.relative(
          process.cwd(),
          processingCacheDir
        );

        for (const id in depsInfo) {
          const output = esbuildOutputFromId(
            meta.outputs,
            id,
            processingCacheDir
          );

          const { exportsData, ...info } = depsInfo[id];
          addOptimizedDepInfo(metadata, "optimized", {
            ...info,
            // We only need to hash the output.imports in to check for stability, but adding the hash
            // and file path gives us a unique hash that may be useful for other things in the future
            fileHash: getHash(
              metadata.hash + depsInfo[id].file + JSON.stringify(output.imports)
            ),
            browserHash: metadata.browserHash,
            // After bundling we have more information and can warn the user about legacy packages
            // that require manual configuration
            needsInterop: needsInterop(
              config,
              ssr,
              id,
              idToExports[id],
              output
            ),
          });
        }

        for (const o of Object.keys(meta.outputs)) {
          if (!jsMapExtensionRE.test(o)) {
            const id = path
              .relative(processingCacheDirOutputPath, o)
              .replace(jsExtensionRE, "");
            const file = getOptimizedDepPath(id, resolvedConfig, ssr);
            if (
              !findOptimizedDepInfoInRecord(
                metadata.optimized,
                (depInfo) => depInfo.file === file
              )
            ) {
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
