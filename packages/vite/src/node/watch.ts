import type { OutputOptions } from "rollup";
import { EventEmitter } from "node:events";
import path from "node:path";
import glob from "fast-glob";
import * as colors from "picocolors";
import type { FSWatcher, WatchOptions } from "dep-types/chokidar";
import { withTrailingSlash } from "../shared/utils";
import { arraify, normalizePath } from "./utils";
import type { ResolvedConfig } from "./config";
import type { Logger } from "./logger";

/**
 * 用于解析输出目录
 * @param root 项目的根目录
 * @param outDir 构建输出目录
 * @param outputOptions Rollup 的输出选项
 * @returns 返回解析后的输出目录
 */
export function getResolvedOutDirs(
  root: string,
  outDir: string,
  outputOptions: OutputOptions[] | OutputOptions | undefined
): Set<string> {
  //得到输出目录的绝对路径
  const resolvedOutDir = path.resolve(root, outDir);
  if (!outputOptions) return new Set([resolvedOutDir]);

  return new Set(
    arraify(outputOptions).map(({ dir }) =>
      //如果 dir 存在，使用 path.resolve 将 root 和 dir 组合成一个绝对路径
      dir ? path.resolve(root, dir) : resolvedOutDir
    )
  );
}

/**
 * 用于确定构建输出目录是否应该在构建之前被清空
 * @param emptyOutDir 指示是否应清空输出目录
 * @param root 项目的根目录
 * @param outDirs 一个包含所有输出目录的集合
 * @param logger 日志记录器
 * @returns
 */
export function resolveEmptyOutDir(
  emptyOutDir: boolean | null,
  root: string,
  outDirs: Set<string>,
  logger?: Logger
): boolean {
  if (emptyOutDir != null) return emptyOutDir;

  //遍历 outDirs 集合中的每个输出目录 outDir。
  for (const outDir of outDirs) {
    //使用 normalizePath 将 outDir 标准化，然后检查其是否以项目根目录（添加了尾随斜杠）开头：
    if (!normalizePath(outDir).startsWith(withTrailingSlash(root))) {
      //如果 outDir 不在项目根目录内，记录一个警告信息，提示用户该目录不会被清空，并返回 false。
      logger?.warn(
        colors.yellow(
          `\n${colors.bold(`(!)`)} outDir ${colors.white(
            colors.dim(outDir)
          )} is not inside project root and will not be emptied.\n` +
            `Use --emptyOutDir to override.\n`
        )
      );
      return false;
    }
  }
  return true;
}

/**
 * 用于解析 Chokidar（一个文件系统监视库）的选项，生成用于文件系统监视的配置对象
 * 通过这个函数，开发者可以灵活地配置 Chokidar 的监视选项，并确保一些特定的目录和文件不被监视。
 * @param config 已解析的配置对象
 * @param options 用户传入的监视选项，可能为空
 * @param resolvedOutDirs 已解析的输出目录集合
 * @param emptyOutDir 是否清空输出目录的标志
 * @returns
 */
export function resolveChokidarOptions(
  config: ResolvedConfig,
  options: WatchOptions | undefined,
  resolvedOutDirs: Set<string>,
  emptyOutDir: boolean
): WatchOptions {
  const { ignored: ignoredList, ...otherOptions } = options ?? {};

  //初始化 ignored 列表，默认忽略以下目录：
  const ignored: WatchOptions["ignored"] = [
    "**/.git/**",
    "**/node_modules/**",
    "**/test-results/**", // Playwright
    glob.escapePath(config.cacheDir) + "/**",
    //将用户自定义的忽略列表（ignoredList）追加到 ignored 列表中
    ...arraify(ignoredList || []),
  ];

  if (emptyOutDir) {
    //将所有输出目录添加到忽略列表中
    ignored.push(
      ...[...resolvedOutDirs].map((outDir) => glob.escapePath(outDir) + "/**")
    );
  }

  //将 ignored 列表和一些默认的 Chokidar 选项与 otherOptions 合并
  const resolvedWatchOptions: WatchOptions = {
    ignored,
    ignoreInitial: true, //忽略初始扫描
    ignorePermissionErrors: true, //忽略权限错误
    ...otherOptions,
  };

  return resolvedWatchOptions;
}

class NoopWatcher extends EventEmitter implements FSWatcher {
  constructor(public options: WatchOptions) {
    super();
  }

  add() {
    return this;
  }

  unwatch() {
    return this;
  }

  getWatched() {
    return {};
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }

  async close() {
    // noop
  }
}

export function createNoopWatcher(options: WatchOptions): FSWatcher {
  return new NoopWatcher(options);
}
