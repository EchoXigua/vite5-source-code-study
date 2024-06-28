import fs from "node:fs";
import path from "node:path";
import colors from "picocolors";
import type {
  InputOption,
  ModuleFormat,
  RollupOptions,
  WatcherOptions,
} from "rollup";
import commonjsPlugin from "@rollup/plugin-commonjs";
import type { RollupCommonJSOptions } from "dep-types/commonjs";
import type { RollupDynamicImportVarsOptions } from "dep-types/dynamicImportVars";

import type { TransformOptions } from "esbuild";

import type { Logger } from "./logger";
import {
  DEFAULT_ASSETS_INLINE_LIMIT,
  ESBUILD_MODULES_TARGET,
  VERSION,
} from "./constants";
import { mergeConfig } from "./publicUtils";
import { requireResolveFromRootWithFallback } from "./utils";
import { type TerserOptions } from "./plugins/terser";

export interface BuildOptions {
  /**
   * 兼容性转换目标。转换由 esbuild 执行，最低支持的目标是 es2015/es6
   * 注意，此选项仅处理语法转换，不包括 polyfill（除了动态 import）
   *
   * 默认值：'modules' - 类似于 `@babel/preset-env` 的 `targets.esmodules`，
   * 用于编译目标浏览器原生支持动态 ES 模块导入的语法。
   * https://caniuse.com/es6-module-dynamic-import
   *
   * 另一个特殊值是 'esnext' - 仅执行最小的转换（用于兼容压缩），并假设原生支持动态导入。
   *
   * 对于自定义目标，请参见 https://esbuild.github.io/api/#target 和
   * https://esbuild.github.io/content-types/#javascript 了解更多详情。
   * @default 'modules'
   */
  target?: "modules" | TransformOptions["target"] | false;
  /**
   * 是否注入模块预加载 polyfill。
   * 注意：不适用于库模式。
   *
   * 已经弃用
   * @default true
   * @deprecated 使用 `modulePreload.polyfill` 替代
   */
  polyfillModulePreload?: boolean;
  /**
   * 配置模块预加载
   * 注意：不适用于库模式。
   * @default true
   */
  modulePreload?: boolean | ModulePreloadOptions;
  /**
   * 输出目录相对于 `root` 的路径，在构建输出之前会删除该目录。
   * @default 'dist'
   */
  outDir?: string;
  /**
   * 输出目录下内置 js/css/image 资源的存放目录。
   * @default 'assets'
   */
  assetsDir?: string;
  /**
   * 静态资源文件大小小于此值（以字节为单位）将以 base64 字符串形式内联。
   * 默认限制为 `4096`（4 KiB）。设置为 `0` 禁用此功能。
   * @default 4096
   */
  assetsInlineLimit?:
    | number
    | ((filePath: string, content: Buffer) => boolean | undefined);
  /**
   * 是否对 CSS 进行代码分割。启用时，异步块中的 CSS 将以字符串形式内联到块中，
   * 并在加载块时通过动态创建的样式标签插入。
   * @default true
   */
  cssCodeSplit?: boolean;
  /**
   * CSS 最小化的可选单独目标。
   * 由于 esbuild 仅支持配置到主流浏览器的目标，当用户针对兼容性较差的浏览器
   * （如 Android 微信 WebView）时，可能需要此选项。
   * @default target
   */
  cssTarget?: TransformOptions["target"] | false;
  /**
   * 特定配置 CSS 最小化，而不是默认 `build.minify`，这样可以分别为 JS 和 CSS 配置最小化。
   * @default 'esbuild'
   */
  cssMinify?: boolean | "esbuild" | "lightningcss";
  /**
   * 如果 `true`，将创建单独的源映射文件。如果是 'inline'，源映射将作为数据 URI 添加到生成的输出文件中。
   * 'hidden' 的行为类似于 `true`，但会抑制捆绑文件中相应的源映射注释。
   * @default false
   */
  sourcemap?: boolean | "inline" | "hidden";
  /**
   * 设置为 `false` 禁用代码压缩，或指定要使用的压缩器。
   * 可用选项为 'terser' 或 'esbuild'。
   * @default 'esbuild'
   */
  minify?: boolean | "terser" | "esbuild";
  /**
   * terser 的选项
   * https://terser.org/docs/api-reference#minify-options
   *
   * 另外，您还可以传递一个 `maxWorkers: number` 选项来指定最大工作进程数。默认为 CPU 数减 1。
   */
  terserOptions?: TerserOptions;
  /**
   * 将与内部 rollup 选项合并
   * https://rollupjs.org/configuration-options/
   */
  rollupOptions?: RollupOptions;
  /**
   *  传递给 `@rollup/plugin-commonjs` 的选项
   */
  commonjsOptions?: RollupCommonJSOptions;
  /**
   * 传递给 `@rollup/plugin-dynamic-import-vars` 的选项
   */
  dynamicImportVarsOptions?: RollupDynamicImportVarsOptions;
  /**
   * 是否将捆绑包写入磁盘
   * @default true
   */
  write?: boolean;
  /**
   *  在写入时是否清空 outDir
   * @default true 当 outDir 是项目根目录的子目录时
   */
  emptyOutDir?: boolean | null;
  /**
   * 将公共目录复制到写入时的 outDir
   * @default true
   */
  copyPublicDir?: boolean;
  /**
   * 是否生成 .vite/manifest.json 文件，用于将无哈希文件名映射到其哈希版本
   * 当需要生成自己的 HTML 而不使用 Vite 生成的 HTML 时，这很有用
   *
   * Example:
   *
   * ```json
   * {
   *   "main.js": {
   *     "file": "main.68fe3fad.js",
   *     "css": "main.e6b63442.css",
   *     "imports": [...],
   *     "dynamicImports": [...]
   *   }
   * }
   * ```
   * @default false
   */
  manifest?: boolean | string;
  /**
   * 以库模式构建。值应为 UMD 模式下库的全局名称。
   * 这将生成适用于分发库的 esm + cjs + umd 包格式的默认配置。
   * @default false
   */
  lib?: LibraryOptions | false;
  /**
   * 生成面向 SSR 的构建。注意，这需要通过 `rollupOptions.input` 指定 SSR 入口。
   * @default false
   */
  ssr?: boolean | string;
  /**
   * 生成 SSR manifest，用于在生产中确定样式链接和资产预加载指令。
   * @default false
   */
  ssrManifest?: boolean | string;
  /**
   *  在 SSR 过程中生成资产(assets)。
   * @default false
   */
  ssrEmitAssets?: boolean;
  /**
   * 设置为 false 以禁用报告压缩后的块大小。
   * 可稍微提高构建速度。
   * @default true
   */
  reportCompressedSize?: boolean;
  /**
   * 调整块大小警告限制（以 kB 为单位）。
   * @default 500
   */
  chunkSizeWarningLimit?: number;
  /**
   * Rollup 监视选项
   * https://rollupjs.org/configuration-options/#watch
   * @default null
   */
  watch?: WatcherOptions | null;
}

//用于配置以库模式构建时的选项
export interface LibraryOptions {
  /**
   * 库入口的路径
   */
  entry: InputOption;
  /**
   * 暴露的全局变量名称。在 `formats` 选项包含 `umd` 或 `iife` 时是必需的。
   */
  name?: string;
  /**
   * 输出的包格式
   * @default ['es', 'umd']
   */
  formats?: LibraryFormats[];
  /**
   * 输出的包文件名。默认文件名是项目 `package.json` 的 `name` 选项。
   * 也可以定义为一个函数，接受格式参数作为输入，返回文件名。
   */
  fileName?: string | ((format: ModuleFormat, entryName: string) => string);
}

export type LibraryFormats = "es" | "cjs" | "umd" | "iife";

export interface ModulePreloadOptions {
  /**
   * Whether to inject a module preload polyfill.
   * Note: does not apply to library mode.
   * @default true
   */
  polyfill?: boolean;
  /**
   * Resolve the list of dependencies to preload for a given dynamic import
   * @experimental
   */
  resolveDependencies?: ResolveModulePreloadDependenciesFn;
}
export interface ResolvedModulePreloadOptions {
  polyfill: boolean;
  resolveDependencies?: ResolveModulePreloadDependenciesFn;
}

export type ResolveModulePreloadDependenciesFn = (
  filename: string,
  deps: string[],
  context: {
    hostId: string;
    hostType: "html" | "js";
  }
) => string[];

export interface ResolvedBuildOptions
  extends Required<Omit<BuildOptions, "polyfillModulePreload">> {
  modulePreload: false | ResolvedModulePreloadOptions;
}

/**
 * 用来解析和处理构建选项的函数。
 * 在 Vite 构建过程中非常重要的一个环节，它负责将用户提供的配置与默认配置合并，
 * 并根据特定的规则和条件进行调整和处理，确保了构建过程中的配置选项是完整和有效的
 *
 * @param raw 未经处理的用户配置的构建选项
 * @param logger
 * @param root 项目的根目录路径
 * @returns 经过解析和处理后的构建选项对象
 */
export function resolveBuildOptions(
  raw: BuildOptions | undefined,
  logger: Logger,
  root: string
): ResolvedBuildOptions {
  const deprecatedPolyfillModulePreload = raw?.polyfillModulePreload;
  //处理和移除已废弃的 polyfillModulePreload 选项，同时向日志记录器输出警告
  if (raw) {
    const { polyfillModulePreload, ...rest } = raw;
    raw = rest;
    //上面两部相当于移除了 废弃的polyfillModulePreload
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

  //获取用户配置中的 modulePreload，并定义默认的 modulePreload 对象，默认开启了模块预加载
  const modulePreload = raw?.modulePreload;
  const defaultModulePreload = {
    polyfill: true,
  };

  const defaultBuildOptions: BuildOptions = {
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

  //使用 mergeConfig 函数将用户提供的 raw 配置与默认配置 defaultBuildOptions 进行合并，
  //生成 userBuildOptions，以确保用户配置的优先级和完整性
  const userBuildOptions = raw
    ? mergeConfig(defaultBuildOptions, raw)
    : defaultBuildOptions;

  // @ts-expect-error Fallback options instead of merging
  //构建最终的 resolved 对象
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

  //检查特殊的构建目标设置，例如将 resolved.target 设置为 ESBUILD_MODULES_TARGET，
  //或者根据 Terser 版本限制将 resolved.target 调整为 es2021
  if (resolved.target === "modules") {
    //如果 resolved.target 的值等于 "modules"，则将其替换为 ESBUILD_MODULES_TARGET。
    //确保了在使用 ESM 模块构建目标时，会使用 Vite 内部定义的目标常量 ESBUILD_MODULES_TARGET。
    resolved.target = ESBUILD_MODULES_TARGET;
  } else if (resolved.target === "esnext" && resolved.minify === "terser") {
    try {
      //首先尝试解析 Terser 的包路径，然后读取其 package.json 文件以获取版本信息
      const terserPackageJsonPath = requireResolveFromRootWithFallback(
        root,
        "terser/package.json"
      );
      const terserPackageJson = JSON.parse(
        fs.readFileSync(terserPackageJsonPath, "utf-8")
      );
      const v = terserPackageJson.version.split(".");

      //如果 Terser 版本的主版本号为 "5"，并且次版本号小于 "16"，则将 resolved.target 设置为 "es2021"。
      //这个处理确保了在特定 Terser 版本下，使用 "esnext" 构建目标时限制为 "es2021"，以便 Terser 可以正确地进行代码压缩。
      if (v[0] === "5" && v[1] < 16) {
        // esnext + terser 5.16<: limit to es2021 so it can be minified by terser
        resolved.target = "es2021";
      }
    } catch {}
  }

  //对 resolved 中的 cssTarget、minify 和 cssMinify 进行最后的校验和调整，确保它们符合预期的类型和值。
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
