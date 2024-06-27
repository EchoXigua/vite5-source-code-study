import fs from "node:fs";
//fsp 以promise 形式返回结果
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { build } from "esbuild";

import type { RollupOptions } from "rollup";
import type { Alias, AliasOptions } from "dep-types/alias";

import {
  asyncFlatten,
  createDebugger,
  isBuiltin,
  isExternalUrl,
  isFilePathESM,
  isNodeBuiltin,
  isObject,
  mergeAlias,
  mergeConfig,
  normalizeAlias,
  normalizePath,
} from "./utils";
import type { HookHandler, Plugin, PluginWithRequiredHook } from "./plugin";

import {
  CLIENT_ENTRY,
  DEFAULT_CONFIG_FILES,
  ENV_ENTRY,
  FS_PREFIX,
  DEFAULT_EXTENSIONS,
  DEFAULT_MAIN_FIELDS,
} from "./constants";
import { loadEnv, resolveEnvPrefix } from "./env";
import colors from "picocolors";
import { resolveBuildOptions } from "./build";

import type { LogLevel, Logger } from "./logger";
import { createLogger } from "./logger";

import { getHookHandler, getSortedPluginsByHook } from "./plugins";
import type { InternalResolveOptions, ResolveOptions } from "./plugins/resolve";
import { resolvePlugin, tryNodeResolve } from "./plugins/resolve";

import {
  type CSSOptions,
  type ResolvedCSSOptions,
  resolveCSSOptions,
} from "./plugins/css";
import type { JsonOptions } from "./plugins/json";
import type { ESBuildOptions } from "./plugins/esbuild";
import type { ResolvedServerOptions, ServerOptions } from "./server";
import type {
  BuildOptions,
  RenderBuiltAssetUrl,
  ResolvedBuildOptions,
} from "./build";
import type { PreviewOptions, ResolvedPreviewOptions } from "./preview";
import type {
  DepOptimizationConfig,
  DepOptimizationOptions,
} from "./optimizer";
import type { ResolvedSSROptions, SSROptions } from "./ssr";
import type { PackageCache } from "./packages";
import { findNearestPackageData } from "./packages";

const debug = createDebugger("vite:config");
const promisifiedRealpath = promisify(fs.realpath);

export interface ConfigEnv {
  /**
   * 'serve': during dev (`vite` command)
   * 'build': when building for production (`vite build` command)
   */
  command: "build" | "serve";
  mode: string;
  isSsrBuild?: boolean;
  isPreview?: boolean;
}

export type AppType = "spa" | "mpa" | "custom";

export type UserConfigFnObject = (env: ConfigEnv) => UserConfig;
export type UserConfigFnPromise = (env: ConfigEnv) => Promise<UserConfig>;
export type UserConfigFn = (env: ConfigEnv) => UserConfig | Promise<UserConfig>;

export type UserConfigExport =
  | UserConfig
  | Promise<UserConfig>
  | UserConfigFnObject
  | UserConfigFnPromise
  | UserConfigFn;

export type PluginOption =
  | Plugin
  | false
  | null
  | undefined
  | PluginOption[]
  | Promise<Plugin | false | null | undefined | PluginOption[]>;

export interface UserConfig {
  /**
   * 项目根目录。可以是绝对路径，也可以是相对于配置文件位置的路径。
   * @default process.cwd()
   */
  root?: string;

  /**
   *  在开发或生产环境中服务时的基础公共路径。
   */
  base?: string;

  /**
   * 作为纯静态资源服务的目录。该目录中的文件在构建时会被原样复制到 dist 目录中。
   * 值可以是绝对路径或相对于项目根目录的路径。
   * 设置为 `false` 或空字符串以禁用复制静态资源到构建目录。
   * @default 'public'
   */
  publicDir?: string | false;

  /**
   * 用于保存缓存文件的目录。这些文件包括预打包的依赖项或其他由 Vite 生成的缓存文件，
   * 这些文件可以提高性能。可以使用 `--force` 标志或手动删除该目录以重新生成缓存文件。
   * 值可以是绝对路径或相对于项目根目录的路径。
   * 如果未检测到 `package.json`，默认为 `.vite`。
   * @default 'node_modules/.vite'
   */
  cacheDir?: string;

  /**
   * 明确设置运行模式。这将覆盖每个命令的默认模式，可以通过命令行的 --mode 选项覆盖。
   */
  mode?: string;

  /**
   * 定义全局变量替换。在开发过程中，这些条目将在 `window` 上定义，并在构建过程中替换。
   */
  define?: Record<string, any>;

  /**
   * 要使用的 Vite 插件数组。
   */
  plugins?: PluginOption[];

  /**
   * 配置解析器。
   */
  resolve?: ResolveOptions & { alias?: AliasOptions };

  /**
   * 与 HTML 相关的选项。
   */
  html?: HTMLOptions;

  /**
   * 与 CSS 相关的选项（预处理器和 CSS 模块）。
   */
  css?: CSSOptions;

  /**
   * JSON 加载选项。
   */
  json?: JsonOptions;

  /**
   * 要传递给 esbuild 的转换选项。
   * 或设置为 `false` 以禁用 esbuild。
   */
  esbuild?: ESBuildOptions | false;

  /**
   * 指定要视为静态资源的其他 picomatch 模式。
   */
  assetsInclude?: string | RegExp | (string | RegExp)[];

  /**
   * 服务器特定选项，例如主机、端口、https 等。
   */
  server?: ServerOptions;

  /**
   * 构建特定选项。
   */
  build?: BuildOptions;

  /**
   * 预览特定选项，例如主机、端口、https 等。
   */
  preview?: PreviewOptions;

  /**
   * 依赖优化选项。
   */
  optimizeDeps?: DepOptimizationOptions;

  /**
   * SSR（服务器端渲染）特定选项。
   */
  ssr?: SSROptions;

  /**
   * 实验性功能。
   *
   * 此字段下的功能将来可能会改变，并且可能不会遵循语义版本控制。请小心使用，并在使用这些功能时始终锁定 Vite 的版本。
   * @experimental
   */
  experimental?: ExperimentalOptions;

  /**
   * 旧版选项。
   *
   * 此字段下的功能仅遵循补丁版本的语义版本控制，它们可能会在未来的小版本中被删除。请在使用这些功能时始终锁定 Vite 的小版本。
   */
  legacy?: LegacyOptions;

  /**
   * Log level.
   * @default 'info'
   */
  logLevel?: LogLevel;

  /**
   * 自定义日志记录器。
   */
  customLogger?: Logger;

  /**
   * @default true
   */
  clearScreen?: boolean;

  /**
   * 环境文件目录。可以是绝对路径，也可以是相对于根目录的路径。
   * @default root
   */
  envDir?: string;

  /**
   * 以 `envPrefix` 开头的环境变量将通过 import.meta.env 暴露给客户端源代码。
   * @default 'VITE_'
   */
  envPrefix?: string | string[];

  /**
   * Worker 打包选项。
   */
  worker?: {
    /**
     * Worker 打包的输出格式。
     * @default 'iife'
     */
    format?: "es" | "iife";

    /**
     * 适用于 Worker 打包的 Vite 插件。这些插件应该在每次调用时返回新的实例，因为它们用于每个 Rollup Worker 打包过程。
     */
    plugins?: () => PluginOption[];

    /**
     * 构建 Worker 包的 Rollup 选项。
     */
    rollupOptions?: Omit<
      RollupOptions,
      "plugins" | "input" | "onwarn" | "preserveEntrySignatures"
    >;

    /**
     * 指定应用程序是单页应用 (SPA)、多页应用 (MPA) 还是自定义应用 (SSR 和具有自定义 HTML 处理的框架)。
     * @default 'spa'
     */
    appType?: AppType;
  };
}

//用于定义与 HTML 相关的配置选项，具体用于 Vite 在生成 HTML 文件时的某些设置。
export interface HTMLOptions {
  /**
   *  用于生成 script/style 标签时的 nonce 值占位符。
   *
   * 确保服务器在处理每个请求时，用唯一的值替换此占位符
   *
   * 功能：在生成 HTML 文件时，Vite 会在 <script> 和 <style> 标签中添加这个 nonce 占位符。
   *
   * 注意：服务器需要在处理每个请求时，将这个占位符替换为一个唯一的值，以确保 CSP 的安全性。
   * 这有助于防止跨站脚本攻击（XSS），因为只允许具有特定 nonce 值的脚本和样式执行。
   */
  cspNonce?: string;
}

//定义了一些实验性功能的配置选项，这些功能可能在未来的版本中有所改进或调整
export interface ExperimentalOptions {
  /**
   * 当指定查询参数时，是否在文件名后添加虚拟的 &lang.(ext)，以保留文件扩展名，
   * 以便后续插件进行处理。这个功能用于处理特定的文件查询参数。
   *
   * @experimental
   * @default false
   */
  importGlobRestoreExtension?: boolean;
  /**
   * 允许对资产和公共文件路径进行细粒度控制。这个选项提供了更灵活的方式来管理生成的资源的URL路径。
   *
   * @experimental
   */
  renderBuiltUrl?: RenderBuiltAssetUrl;
  /**
   * 启用对 HMR（热模块替换）部分接受的支持，通过 import.meta.hot.acceptExports。
   * 这个功能可以增强模块热更新时的灵活性和控制。
   *
   * @experimental
   * @default false
   */
  hmrPartialAccept?: boolean;
  /**
   * 跳过 SSR（服务端渲染）转换，以便更容易地在 Node ESM 加载器中使用 Vite。
   * @warning 需要注意的是，启用此选项会在开发模式下破坏 Vite 的正常 SSR 操作，仅适用于特定情况下的使用。
   *
   * @experimental
   * @default false
   */
  skipSsrTransform?: boolean;
}

//定义了一些遗留的配置选项，这些选项在未来的版本中可能会被移除或改进
export interface LegacyOptions {
  /**
   * 在 Vite 4 中，SSR 外部化模块（即在运行时由 Node.js 加载而不是打包的模块）在开发环境中会隐式代理，
   * 以自动处理 default 和 __esModule 访问。然而，这种处理方式在 Node.js 运行时中并不准确，
   * 导致开发环境与生产环境之间存在不一致性
   *
   * 在 Vite 5 中，这种代理行为已被移除，以确保开发环境和生产环境的一致性。但是，
   * 如果你仍然需要旧版本的行为，可以通过设置 proxySsrExternalModules: true 来启用这个选项。
   * https://github.com/vitejs/vite/discussions/14697.
   */
  proxySsrExternalModules?: boolean;
}

export interface ResolvedWorkerOptions {
  format: "es" | "iife";
  plugins: (bundleChain: string[]) => Promise<Plugin[]>;
  rollupOptions: RollupOptions;
}

export interface InlineConfig extends UserConfig {
  configFile?: string | false;
  envFile?: false;
}

/**
 * 定义表示 Vite 配置文件在解析之后的最终结构。
 * 它包含了解析后的完整配置信息，并将某些属性类型进行了进一步的具体化。
 */
export type ResolvedConfig = Readonly<
  Omit<
    UserConfig,
    "plugins" | "css" | "assetsInclude" | "optimizeDeps" | "worker" | "build"
  > & {
    configFile: string | undefined; //配置文件的路径
    configFileDependencies: string[]; //配置文件的依赖路径数组
    inlineConfig: InlineConfig; //内联配置
    root: string; //项目根目录
    base: string; //基础公共路径
    /** @internal */
    rawBase: string; //原始基础路径（内部使用）
    publicDir: string; //静态资源目录
    cacheDir: string; //缓存目录
    command: "build" | "serve"; //当前运行的命令
    mode: string; //当前模式（如 development 或 production）。
    isWorker: boolean; //是否为 Worker
    // in nested worker bundle to find the main config
    /** @internal */
    mainConfig: ResolvedConfig | null; //主配置（用于嵌套 Worker bundle）。
    /** @internal list of bundle entry id. used to detect recursive worker bundle. */
    bundleChain: string[]; //bundle 入口 ID 列表，用于检测递归的 Worker bundle。
    isProduction: boolean; //是否为生产环境
    envDir: string; //环境变量文件目录
    env: Record<string, any>; //环境变量对象
    resolve: Required<ResolveOptions> & {
      alias: Alias[];
    }; //解析选项，包含必须的 ResolveOptions 以及别名数组
    plugins: readonly Plugin[]; //只读的插件数组
    css: ResolvedCSSOptions; //解析后的 CSS 选项
    esbuild: ESBuildOptions | false; //esbuild 选项或禁用标志
    server: ResolvedServerOptions; //解析后的服务器选项
    build: ResolvedBuildOptions; //解析后的构建选项
    preview: ResolvedPreviewOptions; //解析后的预览选项
    ssr: ResolvedSSROptions; //解析后的 SSR 选项
    assetsInclude: (file: string) => boolean; //函数，用于判断是否包含某文件为资产。
    logger: Logger; //日志记录器实例
    createResolver: (options?: Partial<InternalResolveOptions>) => ResolveFn; //创建解析器的函数
    optimizeDeps: DepOptimizationOptions; //依赖优化选项
    /** @internal */
    packageCache: PackageCache; //包缓存（内部使用）
    worker: ResolvedWorkerOptions; //解析后的 Worker 选项
    appType: AppType; //应用类型（SPA, MPA 或 Custom）
    experimental: ExperimentalOptions; //实验性选项
  } & PluginHookUtils
>;

export interface PluginHookUtils {
  getSortedPlugins: <K extends keyof Plugin>(
    hookName: K
  ) => PluginWithRequiredHook<K>[];
  getSortedPluginHooks: <K extends keyof Plugin>(
    hookName: K
  ) => NonNullable<HookHandler<Plugin[K]>>[];
}

export type ResolveFn = (
  id: string,
  importer?: string,
  aliasOnly?: boolean,
  ssr?: boolean
) => Promise<string | undefined>;

/**
 * 是检查给定的路径 path 中是否包含一些在使用 Vite 时可能会引发问题的特殊字符，比如 # 和 ?。
 * 如果发现这些字符，函数会使用提供的 logger 对象记录警告信息，
 * 建议用户考虑重命名目录以移除这些字符，以避免在 Vite 运行时出现问题。
 *
 * @param path
 * @param logger
 */
function checkBadCharactersInPath(path: string, logger: Logger): void {
  const badChars = [];

  if (path.includes("#")) {
    badChars.push("#");
  }
  if (path.includes("?")) {
    badChars.push("?");
  }

  if (badChars.length > 0) {
    const charString = badChars.map((c) => `"${c}"`).join(" and ");
    const inflectedChars = badChars.length > 1 ? "characters" : "character";

    logger.warn(
      colors.yellow(
        `The project root contains the ${charString} ${inflectedChars} (${colors.cyan(
          path
        )}), which may not work when running Vite. Consider renaming the directory to remove the characters.`
      )
    );
  }
}

/**
 * 主要目的是解析和生成 Vite 的配置
 * @param inlineConfig 用户传递的内联配置
 * @param command 命令类型，可以是 'build' 或 'serve'
 * @param defaultMode 默认模式，默认为 'development'
 * @param defaultNodeEnv 默认的 NODE_ENV，默认为 'development'
 * @param isPreview 是否是预览模式，默认为 false
 * @returns
 */
export async function resolveConfig(
  inlineConfig: InlineConfig,
  command: "build" | "serve",
  defaultMode = "development",
  defaultNodeEnv = "development",
  isPreview = false
): Promise<ResolvedConfig> {
  let config = inlineConfig;
  //初始化配置文件依赖数组
  let configFileDependencies: string[] = [];
  //确定模式
  let mode = inlineConfig.mode || defaultMode;
  //是否设置NODE_ENV
  const isNodeEnvSet = !!process.env.NODE_ENV;
  const packageCache: PackageCache = new Map();

  //一些依赖项，例如@vue/compiler-*依赖于NODE_ENV来获取特定于生产环境的行为，所以要尽早设置它
  if (!isNodeEnvSet) {
    process.env.NODE_ENV = defaultNodeEnv;
  }

  const configEnv: ConfigEnv = {
    mode,
    command,
    isSsrBuild: command === "build" && !!config.build?.ssr,
    isPreview,
  };

  let { configFile } = config;
  //如果 configFile 不为 false，尝试加载配置文件并合并到当前配置中
  if (configFile !== false) {
    const loadResult = await loadConfigFromFile(
      configEnv,
      configFile,
      config.root,
      config.logLevel,
      config.customLogger
    );
    //如果存在配置文件，则开始合并配置
    if (loadResult) {
      config = mergeConfig(loadResult.config, config);
      configFile = loadResult.path;
      configFileDependencies = loadResult.dependencies;
    }
  }

  // 更新模式 mode 和 configEnv
  mode = inlineConfig.mode || config.mode || mode;
  configEnv.mode = mode;

  //用于过滤插件
  const filterPlugin = (p: Plugin) => {
    if (!p) {
      //插件不存在，return false 表示不包括这个插件
      return false;
    } else if (!p.apply) {
      //如果插件 p 没有 apply 属性，返回 true，表示包括这个插件。
      return true;
    } else if (typeof p.apply === "function") {
      //如果apply 为函数，调用这个函数并传入 config
      //和 mode 的扩展对象及 configEnv，返回函数的执行结果。
      return p.apply({ ...config, mode }, configEnv);
    } else {
      //检查 apply 属性是否为特定值：
      return p.apply === command;
    }
  };

  // 主要目的是处理和过滤插件数组，首先展平并解析包含异步任务的插件数组，然后使用过滤函数过滤出有效的插件
  const rawUserPlugins = (
    (await asyncFlatten(config.plugins || [])) as any[]
  ).filter(filterPlugin);

  //插件排序，并将其按优先级分类（prePlugins, normalPlugins, postPlugins）。
  const [prePlugins, normalPlugins, postPlugins] =
    sortUserPlugins(rawUserPlugins);

  //运行配置钩子
  const userPlugins = [...prePlugins, ...normalPlugins, ...postPlugins];
  config = await runConfigHook(config, userPlugins, configEnv);

  // 定义日志记录器
  const logger = createLogger(config.logLevel, {
    allowClearScreen: config.clearScreen,
    customLogger: config.customLogger,
  });

  // 主要目的是解析并规范化项目的根目录路径
  const resolvedRoot = normalizePath(
    config.root ? path.resolve(config.root) : process.cwd()
  );

  checkBadCharactersInPath(resolvedRoot, logger);

  //定义客户端别名,用于在打包过程中将特定模块路径映射到替换路径
  //这样在 Vite 的打包过程中，当有模块路径匹配到 @vite/env 或 @vite/client 的正则表达式规则时，
  //会被替换为相应的路径，从而实现路径的别名映射
  const clientAlias = [
    {
      find: /^\/?@vite\/env/,
      replacement: path.posix.join(FS_PREFIX, normalizePath(ENV_ENTRY)),
    },
    {
      find: /^\/?@vite\/client/,
      replacement: path.posix.join(FS_PREFIX, normalizePath(CLIENT_ENTRY)),
    },
  ];

  //合并用户定义的别名与客户端别名，得到 resolvedAlias。
  const resolvedAlias = normalizeAlias(
    mergeAlias(clientAlias, config.resolve?.alias || [])
  );

  //结合用户配置和默认值，生成了一个统一的模块解析配置对象
  //这个对象可以用于模块打包工具，以确定如何解析模块导入路径，从而简化和优化模块解析过程。
  const resolveOptions: ResolvedConfig["resolve"] = {
    mainFields: config.resolve?.mainFields ?? DEFAULT_MAIN_FIELDS,
    conditions: config.resolve?.conditions ?? [],
    extensions: config.resolve?.extensions ?? DEFAULT_EXTENSIONS,
    dedupe: config.resolve?.dedupe ?? [],
    preserveSymlinks: config.resolve?.preserveSymlinks ?? false,
    alias: resolvedAlias,
  };

  //没有设置浏览器字段，但又包含浏览器入口，则给出警告
  if (
    // @ts-expect-error removed field
    config.resolve?.browserField === false &&
    resolveOptions.mainFields.includes("browser")
  ) {
    logger.warn(
      colors.yellow(
        `\`resolve.browserField\` is set to false, but the option is removed in favour of ` +
          `the 'browser' string in \`resolve.mainFields\`. You may want to update \`resolve.mainFields\` ` +
          `to remove the 'browser' string and preserve the previous browser behaviour.`
      )
    );
  }

  //解析环境变量文件 .env files
  /**
   * 主要是用于设置环境变量目录 (envDir) 并加载用户环境变量 (userEnv)
   * 通过解析用户配置和默认路径，将环境变量加载到配置中，以便在应用程序中使用这些变量
   * 
   *  config.envDir：用户在配置中指定的环境变量目录。
      resolvedRoot：解析后的项目根目录。
      path.resolve：将相对路径解析为绝对路径。
      normalizePath：标准化路径，确保跨平台兼容。
   */
  const envDir = config.envDir
    ? normalizePath(path.resolve(resolvedRoot, config.envDir))
    : resolvedRoot;

  //默认情况下，envFile 是启用的,如果行内配置没有设置envFile 为false，就加载env文件
  const userEnv =
    inlineConfig.envFile !== false &&
    //加载指定模式下的环境变量文件
    loadEnv(mode, envDir, resolveEnvPrefix(config));

  /**
   * 主要处理的是根据 .env 文件中配置的 NODE_ENV 设置来决定当前的 Node.js 环境变量 process.env.NODE_ENV
   * 它会根据用户配置的环境变量来决定是否将 process.env.NODE_ENV 设置为 development，并且会在特定情况下发出警告
   *
   * 为什么限制 NODE_ENV 为 "development"？
   * 在开发环境中，某些工具和框架（例如 Vue）依赖于 NODE_ENV 的值来决定是否启用开发特性，例如热模块替换（HMR）
   * 如果 NODE_ENV 被设置为 "production"，这些特性可能会被禁用，影响开发体验
   * 因此，这段代码在环境变量文件中只支持将 NODE_ENV 设置为 "development"，并建议在 Vite 配置中设置其他 NODE_ENV 值。
   */
  const userNodeEnv = process.env.VITE_USER_NODE_ENV;
  if (!isNodeEnvSet && userNodeEnv) {
    if (userNodeEnv === "development") {
      process.env.NODE_ENV = "development";
    } else {
      // NODE_ENV=production is not supported as it could break HMR in dev for frameworks like Vue
      logger.warn(
        `NODE_ENV=${userNodeEnv} is not supported in the .env file. ` +
          `Only NODE_ENV=development is supported to create a development build of your project. ` +
          `If you need to set process.env.NODE_ENV, you can set it in the Vite config instead.`
      );
    }
  }

  const isProduction = process.env.NODE_ENV === "production";

  //确定生产模式 isProduction 和构建模式 isBuild。
  const isBuild = command === "build";
  //判断base URL 是否为相对路径的简写
  const relativeBaseShortcut = config.base === "" || config.base === "./";

  /**
   * 在开发过程中，我们忽略相对基础，并退回到“/”。
   * 对于SSR构建，相对基础是不可能通过import.meta.url的方式实现的。
   */
  const resolvedBase = relativeBaseShortcut
    ? !isBuild || config.build?.ssr
      ? "/"
      : "./"
    : resolveBaseUrl(config.base, isBuild, logger) ?? "/";
  //如果 resolveBaseUrl 返回 null 或 undefined，则基准 URL 为 '/'

  //用于解析构建选项，确保构建配置（config.build）中包含所有必要的信息
  const resolvedBuildOptions = resolveBuildOptions(
    config.build,
    logger,
    resolvedRoot
  );

  // resolve cache directory
  const pkgDir = findNearestPackageData(resolvedRoot, packageCache)?.dir;
  const cacheDir = normalizePath(
    config.cacheDir
      ? path.resolve(resolvedRoot, config.cacheDir)
      : pkgDir
      ? path.join(pkgDir, `node_modules/.vite`)
      : path.join(resolvedRoot, `.vite`)
  );

  const assetsFilter =
    config.assetsInclude &&
    (!Array.isArray(config.assetsInclude) || config.assetsInclude.length)
      ? createFilter(config.assetsInclude)
      : () => false;

  // create an internal resolver to be used in special scenarios, e.g.
  // optimizer & handling css @imports
  const createResolver: ResolvedConfig["createResolver"] = (options) => {
    let aliasContainer: anyContainer | undefined;
    let resolverContainer: anyContainer | undefined;
    return async (id, importer, aliasOnly, ssr) => {
      let container: anyContainer;
      if (aliasOnly) {
        container =
          aliasContainer ||
          (aliasContainer = await createanyContainer({
            ...resolved,
            anys: [aliasany({ entries: resolved.resolve.alias })],
          }));
      } else {
        container =
          resolverContainer ||
          (resolverContainer = await createanyContainer({
            ...resolved,
            anys: [
              aliasany({ entries: resolved.resolve.alias }),
              resolveany({
                ...resolved.resolve,
                root: resolvedRoot,
                isProduction,
                isBuild: command === "build",
                ssrConfig: resolved.ssr,
                asSrc: true,
                preferRelative: false,
                tryIndex: true,
                ...options,
                idOnly: true,
                fsUtils: getFsUtils(resolved),
              }),
            ],
          }));
      }
      return (
        await container.resolveId(id, importer, {
          ssr,
          scan: options?.scan,
        })
      )?.id;
    };
  };

  const { publicDir } = config;
  const resolvedPublicDir =
    publicDir !== false && publicDir !== ""
      ? normalizePath(
          path.resolve(
            resolvedRoot,
            typeof publicDir === "string" ? publicDir : "public"
          )
        )
      : "";

  const server = resolveServerOptions(resolvedRoot, config.server, logger);
  const ssr = resolveSSROptions(config.ssr, resolveOptions.preserveSymlinks);

  const optimizeDeps = config.optimizeDeps || {};

  const BASE_URL = resolvedBase;

  let resolved: any;

  let createUserWorkeranys = config.worker?.anys;
  if (Array.isArray(createUserWorkeranys)) {
    // @ts-expect-error backward compatibility
    createUserWorkeranys = () => config.worker?.anys;

    logger.warn(
      colors.yellow(
        `worker.anys is now a function that returns an array of anys. ` +
          `Please update your Vite config accordingly.\n`
      )
    );
  }

  const createWorkeranys = async function (bundleChain: string[]) {
    // Some anys that aren't intended to work in the bundling of workers (doing post-processing at build time for example).
    // And anys may also have cached that could be corrupted by being used in these extra rollup calls.
    // So we need to separate the worker any from the any that vite needs to run.
    const rawWorkerUseranys = (
      (await asyncFlatten(createUserWorkeranys?.() || [])) as any[]
    ).filter(filterany);

    // resolve worker
    let workerConfig = mergeConfig({}, config);
    const [workerPreanys, workerNormalanys, workerPostanys] =
      sortUseranys(rawWorkerUseranys);

    // run config hooks
    const workerUseranys = [
      ...workerPreanys,
      ...workerNormalanys,
      ...workerPostanys,
    ];
    workerConfig = await runConfigHook(workerConfig, workerUseranys, configEnv);

    const workerResolved: ResolvedConfig = {
      ...workerConfig,
      ...resolved,
      isWorker: true,
      mainConfig: resolved,
      bundleChain,
    };
    const resolvedWorkeranys = await resolveanys(
      workerResolved,
      workerPreanys,
      workerNormalanys,
      workerPostanys
    );

    // run configResolved hooks
    await Promise.all(
      createanyHookUtils(resolvedWorkeranys)
        .getSortedanyHooks("configResolved")
        .map((hook) => hook(workerResolved))
    );

    return resolvedWorkeranys;
  };

  const resolvedWorkerOptions: ResolvedWorkerOptions = {
    format: config.worker?.format || "iife",
    anys: createWorkeranys,
    rollupOptions: config.worker?.rollupOptions || {},
  };

  resolved = {
    configFile: configFile ? normalizePath(configFile) : undefined,
    configFileDependencies: configFileDependencies.map((name) =>
      normalizePath(path.resolve(name))
    ),
    inlineConfig,
    root: resolvedRoot,
    base: withTrailingSlash(resolvedBase),
    rawBase: resolvedBase,
    resolve: resolveOptions,
    publicDir: resolvedPublicDir,
    cacheDir,
    command,
    mode,
    ssr,
    isWorker: false,
    mainConfig: null,
    bundleChain: [],
    isProduction,
    anys: useranys,
    css: resolveCSSOptions(config.css),
    esbuild:
      config.esbuild === false
        ? false
        : {
            jsxDev: !isProduction,
            ...config.esbuild,
          },
    server,
    build: resolvedBuildOptions,
    preview: resolvePreviewOptions(config.preview, server),
    envDir,
    env: {
      ...userEnv,
      BASE_URL,
      MODE: mode,
      DEV: !isProduction,
      PROD: isProduction,
    },
    assetsInclude(file: string) {
      return DEFAULT_ASSETS_RE.test(file) || assetsFilter(file);
    },
    logger,
    packageCache,
    createResolver,
    optimizeDeps: {
      holdUntilCrawlEnd: true,
      ...optimizeDeps,
      esbuildOptions: {
        preserveSymlinks: resolveOptions.preserveSymlinks,
        ...optimizeDeps.esbuildOptions,
      },
    },
    worker: resolvedWorkerOptions,
    appType: config.appType ?? "spa",
    experimental: {
      importGlobRestoreExtension: false,
      hmrPartialAccept: false,
      ...config.experimental,
    },
    getSortedanys: undefined!,
    getSortedanyHooks: undefined!,
  };
  resolved = {
    ...config,
    ...resolved,
  };
  (resolved.anys as any[]) = await resolveanys(
    resolved,
    preanys,
    normalanys,
    postanys
  );
  Object.assign(resolved, createanyHookUtils(resolved.anys));

  // call configResolved hooks
  await Promise.all(
    resolved.getSortedanyHooks("configResolved").map((hook) => hook(resolved))
  );

  optimizeDepsDisabledBackwardCompatibility(resolved, resolved.optimizeDeps);
  optimizeDepsDisabledBackwardCompatibility(
    resolved,
    resolved.ssr.optimizeDeps,
    "ssr."
  );

  debug?.(`using resolved config: %O`, {
    ...resolved,
    anys: resolved.anys.map((p) => p.name),
    worker: {
      ...resolved.worker,
      anys: `() => anys`,
    },
  });

  // validate config

  if (
    config.build?.terserOptions &&
    config.build.minify &&
    config.build.minify !== "terser"
  ) {
    logger.warn(
      colors.yellow(
        `build.terserOptions is specified but build.minify is not set to use Terser. ` +
          `Note Vite now defaults to use esbuild for minification. If you still ` +
          `prefer Terser, set build.minify to "terser".`
      )
    );
  }

  // Check if all assetFileNames have the same reference.
  // If not, display a warn for user.
  const outputOption = config.build?.rollupOptions?.output ?? [];
  // Use isArray to narrow its type to array
  if (Array.isArray(outputOption)) {
    const assetFileNamesList = outputOption.map(
      (output) => output.assetFileNames
    );
    if (assetFileNamesList.length > 1) {
      const firstAssetFileNames = assetFileNamesList[0];
      const hasDifferentReference = assetFileNamesList.some(
        (assetFileNames) => assetFileNames !== firstAssetFileNames
      );
      if (hasDifferentReference) {
        resolved.logger.warn(
          colors.yellow(`
  assetFileNames isn't equal for every build.rollupOptions.output. A single pattern across all outputs is supported by Vite.
  `)
        );
      }
    }
  }

  // Warn about removal of experimental features
  if (
    // @ts-expect-error Option removed
    config.legacy?.buildSsrCjsExternalHeuristics ||
    // @ts-expect-error Option removed
    config.ssr?.format === "cjs"
  ) {
    resolved.logger.warn(
      colors.yellow(`
  (!) Experimental legacy.buildSsrCjsExternalHeuristics and ssr.format were be removed in Vite 5.
      The only SSR Output format is ESM. Find more information at https://github.com/vitejs/vite/discussions/13816.
  `)
    );
  }

  const resolvedBuildOutDir = normalizePath(
    path.resolve(resolved.root, resolved.build.outDir)
  );
  if (
    isParentDirectory(resolvedBuildOutDir, resolved.root) ||
    resolvedBuildOutDir === resolved.root
  ) {
    resolved.logger.warn(
      colors.yellow(`
  (!) build.outDir must not be the same directory of root or a parent directory of root as this could cause Vite to overwriting source files with build outputs.
  `)
    );
  }

  return resolved;
}

/**
 * 主要用于从文件中加载用户配置。它处理了不同路径的配置文件查找和加载逻辑，
 * 并通过打包和执行配置文件来解析配置。
 *
 * @param configEnv
 * @param configFile 配置文件的路径。如果没有提供，函数会在默认配置文件列表中查找。
 * @param configRoot 配置文件的根目录，默认为当前工作目录 (process.cwd()）
 * @param logLevel 日志级别
 * @param customLogger 自定义日志记录器
 * @returns 返回一个包含配置文件路径、配置对象以及配置文件依赖项的对象，或者在没有找到配置文件时返回 null。
 */
export async function loadConfigFromFile(
  configEnv: ConfigEnv,
  configFile?: string,
  configRoot: string = process.cwd(),
  logLevel?: LogLevel,
  customLogger?: Logger
): Promise<{
  path: string;
  config: UserConfig;
  dependencies: string[];
} | null> {
  //用于计算加载配置文件所花费的时间。
  const start = performance.now();
  const getTime = () => `${(performance.now() - start).toFixed(2)}ms`;

  let resolvedPath: string | undefined;

  //解析配置文件路径
  if (configFile) {
    //如果提供了 configFile 参数，解析该路径。
    resolvedPath = path.resolve(configFile);
  } else {
    //在默认配置文件列表（DEFAULT_CONFIG_FILES）中查找第一个存在的文件。
    for (const filename of DEFAULT_CONFIG_FILES) {
      const filePath = path.resolve(configRoot, filename);
      //如果文件不存在，继续往后查找，找到后退出，existsSync是同步方法
      if (!fs.existsSync(filePath)) continue;

      resolvedPath = filePath;
      break;
    }
  }

  //如果配置文件没有找到，给出警告并返回
  if (!resolvedPath) {
    debug?.("配置文件没有找到");
    return null;
  }

  //检查文件是否为 ESM 模块：
  const isESM = isFilePathESM(resolvedPath);

  try {
    //打包配置文件，打包的原因可能是为了处理不同模块系统（如 ESM 和 CommonJS）的兼容性问题。
    /**
     * bundleConfigFile 函数的目的是使用 esbuild 将配置文件及其依赖项打包成一个独立的 JavaScript 文件。
     *
     * 为什么要打包呢？
     *
     * 1. 兼容性处理：配置文件可能使用了最新的 ECMAScript 语法或者 TypeScript，
     * 需要通过打包工具进行转译，使其兼容当前的 Node.js 环境
     *
     * 2. 模块系统兼容性：
     *    1. 配置文件可以是 ESM 或 CommonJS 模块，打包后统一处理可以避免在代码中处理不同模块系统的复杂性。
     *    2. ESM 模块在 Node.js 中需要异步加载，而 CommonJS 模块是同步加载的。打包可以将不同类型的模块统一成一个格式
     *
     * 3. 依赖解析：配置文件可能依赖其他文件或模块，打包可以将所有依赖打包成一个文件，简化加载逻辑。
     */
    const bundled = await bundleConfigFile(resolvedPath, isESM);

    //从打包后的代码中加载配置，根据配置文件导出内容的类型（函数或对象），调用配置文件获取最终配置对象
    const userConfig = await loadConfigFromBundledFile(
      resolvedPath,
      bundled.code,
      isESM
    );
    debug?.(`bundled config file loaded in ${getTime()}`);

    const config = await (typeof userConfig === "function"
      ? userConfig(configEnv)
      : userConfig);
    if (!isObject(config)) {
      throw new Error(`config must export or return an object.`);
    }
    return {
      path: normalizePath(resolvedPath),
      config,
      dependencies: bundled.dependencies,
    };
  } catch (e) {
    createLogger(logLevel, { customLogger }).error(
      colors.red(`failed to load config from ${resolvedPath}`),
      {
        error: e,
      }
    );
    throw e;
  }
}

//插件排序
export function sortUserPlugins(
  plugins: (Plugin | Plugin[])[] | undefined
): [Plugin[], Plugin[], Plugin[]] {
  const preanys: Plugin[] = [];
  const postanys: Plugin[] = [];
  const normalanys: Plugin[] = [];

  if (plugins) {
    plugins.flat().forEach((p) => {
      //这个插件应该在其他插件之前运行
      if (p.enforce === "pre") preanys.push(p);
      //这个插件应该在其他插件之后运行
      else if (p.enforce === "post") postanys.push(p);
      //默认归为 normalPlugins
      else normalanys.push(p);
    });
  }
  //分别表示预处理插件、正常处理插件和后处理插件。
  return [preanys, normalanys, postanys];
}

/**
 * 用于依次执行插件的 config 钩子函数，并将钩子函数的返回结果合并到当前配置中
 *
 * @param config 初始配置对象
 * @param plugins 插件数组
 * @param configEnv 配置环境对象
 * @returns 最终返回一个合并后的配置对象。
 */
async function runConfigHook(
  config: InlineConfig,
  plugins: Plugin[],
  configEnv: ConfigEnv
): Promise<InlineConfig> {
  let conf = config;

  for (const p of getSortedPluginsByHook("config", plugins)) {
    //获取当前插件的 config 钩子。
    const hook = p.config;
    //获取钩子的处理函数 handler
    const handler = getHookHandler(hook);
    if (handler) {
      //执行钩子函数
      const res = await handler(conf, configEnv);
      if (res) {
        //如果 res 存在，则调用 mergeConfig 函数将 res 合并到当前配置 conf 中。
        conf = mergeConfig(conf, res);
      }
    }
  }

  return conf;
}

/**
 * 用于解析和验证 Vite 配置中的 base 选项
 * 确保 base 选项符合特定的格式和规则，并在必要时发出警告
 *
 * base 选项在 Vite 配置中用于指定资源的基准 URL。
 * 例如，当 base 设置为 '/' 时，资源路径相对于服务器的根路径。
 * 当 base 设置为 './' 时，资源路径相对于当前目录。
 *
 * @param base 默认为 '/'，这是 Vite 配置中的 base 选项，用于指定资源的基准 URL。
 * @param isBuild 表示当前是否是构建命令
 * @param logger 日志记录器，用于发出警告
 * @returns
 */
export function resolveBaseUrl(
  base: UserConfig["base"] = "/",
  isBuild: boolean,
  logger: Logger
): string {
  //检查 base 是否以 . 开头
  if (base[0] === ".") {
    logger.warn(
      colors.yellow(
        colors.bold(
          `(!) invalid "base" option: "${base}". The value can only be an absolute ` +
            `URL, "./", or an empty string.`
        )
      )
    );
    //如果 base 以 . 开头，发出警告，并将 base 设置为 '/'
    //base 只能是绝对路径、./、空字符串
    return "/";
  }

  //检查 base 是否是外部 URL，（例如以 http:// 或 https:// 开头的 URL）
  const isExternal = isExternalUrl(base);
  //如果 base 不是外部 URL，并且不以 / 开头，发出警告，提示 base 选项应该以斜杠开头
  if (!isExternal && base[0] !== "/") {
    logger.warn(
      colors.yellow(colors.bold(`(!) "base" option should start with a slash.`))
    );
  }

  //如果不是构建命令或者 base 不是外部 URL，将 base 解析为一个 URL，并获取其路径部分
  if (!isBuild || !isExternal) {
    base = new URL(base, "http://vitejs.dev").pathname;
    //确保路径以 / 开头，如果不以 / 开头，则添加 /
    if (base[0] !== "/") {
      base = "/" + base;
    }
  }

  return base;
}

/**
 * 用于打包配置文件的异步函数。它使用 esbuild 来打包指定的配置文件，并返回打包后的代码和依赖项列表
 *
 * @param fileName 要打包的配置文件的路径
 * @param isESM
 * @returns
 */
async function bundleConfigFile(
  fileName: string,
  isESM: boolean
): Promise<{ code: string; dependencies: string[] }> {
  //定义了一些变量名用于注入文件路径信息。
  const dirnameVarName = "__vite_injected_original_dirname";
  const filenameVarName = "__vite_injected_original_filename";
  const importMetaUrlVarName = "__vite_injected_original_import_meta_url";

  //使用 esbuild 的 build 函数来打包配置文件
  //esbuild 中文文档 https://esbuild.bootcss.com/api
  const result = await build({
    absWorkingDir: process.cwd(), //设置当前工作目录
    entryPoints: [fileName], //设置入口文件为 fileName，如 entryPoints: ['home.ts', 'settings.ts'],
    write: false, //设置为 false，表示不写入文件系统
    target: ["node18"], //设置打包目标为 node18

    //默认情况下，esbuild 的打包器为浏览器生成代码。
    //如果你打包好的代码想要在 node 环境中运行，你应该设置 platform 为 node：
    platform: "node",
    bundle: true, // 设置为 true，表示需要打包
    format: isESM ? "esm" : "cjs",

    //当你在 node 中导入一个包时，包中的 package.json 文件的 main 字段会决定导入哪个文件
    //包括 esbuild 在内的主流打包器允许你在解析包是额外指定一个 package.json 字段
    //通常至少有三个这样的字段：main、module、browser
    mainFields: ["main"], // 设置主字段为 main

    //当为 inline时 插入整个 source map 到 .js 文件中而不是单独生成一个 .js.map 文件
    sourcemap: "inline",

    //该配置告诉 esbuild 以 JSON 格式生成一些构建相关的元数据
    metafile: true,

    //该特性提供了一种用常量表达式替换全局标识符的方法。
    //它可以在不改变代码本身的情况下改变某些构建之间代码的行为:
    //还记得vite 在一开始注入的一些全局变量吗，在这里做了替换
    define: {
      __dirname: dirnameVarName,
      __filename: filenameVarName,
      "import.meta.url": importMetaUrlVarName,
      "import.meta.dirname": dirnameVarName,
      "import.meta.filename": filenameVarName,
    },

    //这里写了两个自定义插件
    plugins: [
      //这个插件的主要作用是将外部依赖进行外部化处理，
      //以确保在打包时不会将所有依赖都打包进来，而是将一些特定的依赖保持为外部依赖
      {
        name: "externalize-deps",
        setup(build) {
          //缓存包信息，以提高解析性能
          const packageCache = new Map();

          //使用 Vite 的 tryNodeResolve 方法解析模块路径
          const resolveByViteResolver = (
            id: string, //要解析的模块标识符
            importer: string, //导入该模块的文件路径
            isRequire: boolean //布尔值，表示解析时是否使用 require
          ) => {
            //tryNodeResolve 方法会返回一个解析结果对象，如果解析成功，会包含 id 属性表示解析后的路径。
            //resolveByViteResolver 函数最终返回该路径。
            return tryNodeResolve(
              id,
              importer,
              {
                root: path.dirname(fileName), //解析的根目录，这里设为配置文件的目录
                isBuild: true, //表示是否处于构建阶段
                isProduction: true, //表示是否处于生产模式
                preferRelative: false, //表示是否优先解析相对路径
                tryIndex: true, //表示是否尝试解析为索引文件
                mainFields: [], //主字段数组，用于指定包的主入口字段，这里设为空数组，表示不使用任何主字段
                conditions: [], //条件数组，用于指定解析条件，这里设为空数组，表示没有特殊条件。
                overrideConditions: ["node"], //覆盖条件数组，这里设为 ["node"]，表示使用 Node.js 环境条件。
                dedupe: [], //去重数组，这里设为空数组，表示不进行去重
                extensions: DEFAULT_EXTENSIONS, //扩展名数组，表示要解析的文件扩展名，通常包含 .js, .ts, .json 等，这里使用 DEFAULT_EXTENSIONS 常量
                preserveSymlinks: false, //表示是否保留符号链接
                packageCache, //包缓存，用于提高解析性能
                isRequire, //表示是否使用 require 进行解析
              },
              false
            )?.id;
          };

          //这个钩子处理所有非相对路径和非绝对路径的模块解析请求
          build.onResolve(
            //监听所有非相对路径（以 . 开头）和非绝对路径（以 / 开头）的模块。
            { filter: /^[^.].*/ },
            async ({ path: id, importer, kind }) => {
              //如果是一个入口点模块、如果 id 是绝对路径、如果 id 是 Node.js 内置模块 直接返回
              if (
                kind === "entry-point" ||
                path.isAbsolute(id) ||
                isNodeBuiltin(id)
              ) {
                return;
              }

              // With the `isNodeBuiltin` check above, this check captures if the builtin is a
              // non-node built-in, which esbuild doesn't know how to handle. In that case, we
              // externalize it so the non-node runtime handles it instead.
              /**
               * 使用上面的' isNodeBuiltin '检查，这个检查会捕获内置是否是一个非节点内置，
               * 而esbuild不知道如何处理。在这种情况下，我们将其外部化，以便由非节点运行时处理它。
               */
              if (isBuiltin(id)) {
                //如果 id 是非 Node.js 内置模块，将模块标记为外部模块 { external: true }。
                return { external: true };
              }

              //如果模块是 ESM 或动态导入，设置 isImport 为 true。
              const isImport = isESM || kind === "dynamic-import";
              let idFsPath: string | undefined;
              try {
                idFsPath = resolveByViteResolver(id, importer, !isImport);
              } catch (e) {
                //这里主要是对 esm 中使用 requried 导入做一些错误提示
                if (!isImport) {
                  let canResolveWithImport = false;
                  try {
                    canResolveWithImport = !!resolveByViteResolver(
                      id,
                      importer,
                      false
                    );
                  } catch {}
                  if (canResolveWithImport) {
                    throw new Error(
                      `Failed to resolve ${JSON.stringify(
                        id
                      )}. This package is ESM only but it was tried to load by \`require\`. See https://vitejs.dev/guide/troubleshooting.html#this-package-is-esm-only for more details.`
                    );
                  }
                }
                throw e;
              }

              //如果 idFsPath 存在并且是导入模块，将文件路径转换为文件 URL。
              if (idFsPath && isImport) {
                idFsPath = pathToFileURL(idFsPath).href;
              }

              //如果 idFsPath 存在并且不是导入模块，检查文件是否为 ESM。
              //如果是，则抛出错误，因为 ESM 文件不能被 require 加载。
              if (
                idFsPath &&
                !isImport &&
                isFilePathESM(idFsPath, packageCache)
              ) {
                throw new Error(
                  `${JSON.stringify(
                    id
                  )} resolved to an ESM file. ESM file cannot be loaded by \`require\`. See https://vitejs.dev/guide/troubleshooting.html#this-package-is-esm-only for more details.`
                );
              }
              //返回解析结果
              return {
                path: idFsPath,
                external: true,
              };
            }
          );
        },
      },
      {
        //用于向特定类型的文件（JavaScript 和 TypeScript 文件）注入一些全局变量
        //这些变量包括文件的目录名、文件名和文件的 URL。这在一些需要知道文件路径或 URL 的场景中非常有用
        name: "inject-file-scope-variables",
        //esbuild 在构建过程开始时调用此函数，以便插件可以注册钩子
        setup(build) {
          //esbuild 在加载文件时调用这个钩子，这里匹配的是以 .cjs、.mjs、.js、.ts 结尾的文件
          build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
            //使用 fsp.readFile 异步读取文件内容。
            const contents = await fsp.readFile(args.path, "utf-8");

            //注入变量
            const injectValues =
              `const ${dirnameVarName} = ${JSON.stringify(
                path.dirname(args.path)
              )};` +
              `const ${filenameVarName} = ${JSON.stringify(args.path)};` +
              `const ${importMetaUrlVarName} = ${JSON.stringify(
                pathToFileURL(args.path).href
              )};`;

            /**
             * __vite_injected_original_dirname：文件所在目录。
             * __vite_injected_original_filename：文件名。
             * __vite_injected_original_import_meta_url：文件的 URL。
             */

            //返回修改后的文件内容：
            return {
              loader: args.path.endsWith("ts") ? "ts" : "js",
              contents: injectValues + contents,
            };
          });
        },
      },
    ],
  });
  const { text } = result.outputFiles[0];
  return {
    code: text,
    dependencies: result.metafile ? Object.keys(result.metafile.inputs) : [],
  };
}

interface NodeModuleWithCompile extends NodeModule {
  _compile(code: string, filename: string): any;
}

const _require = createRequire(import.meta.url);
/**
 * 用来从打包后的配置文件中加载配置对象的函数。它根据配置文件的类型（ESM 或 CJS）采取不同的加载方式
 *
 * @param fileName
 * @param bundledCode
 * @param isESM
 * @returns
 */
async function loadConfigFromBundledFile(
  fileName: string,
  bundledCode: string,
  isESM: boolean
): Promise<UserConfigExport> {
  // for esm, before we can register loaders without requiring users to run node
  // with --experimental-loader themselves, we have to do a hack here:
  // write it to disk, load it with native Node ESM, then delete the file.

  if (isESM) {
    //处理esm 配置文件
    const fileBase = `${fileName}.timestamp-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

    //创建一个唯一的临时文件名 fileNameTmp
    const fileNameTmp = `${fileBase}.mjs`;
    //使用 pathToFileURL 生成文件的 URL
    const fileUrl = `${pathToFileURL(fileBase)}.mjs`;

    //将打包后的代码写入临时文件名 fileNameTmp
    await fsp.writeFile(fileNameTmp, bundledCode);

    try {
      //通过 import 关键字动态导入临时文件
      return (await import(fileUrl)).default;
    } finally {
      //在导入后，临时文件会被删除以释放磁盘空间。
      fs.unlink(fileNameTmp, () => {}); // Ignore errors
    }
  }
  // 对于cjs，我们可以通过_require.extensions注册一个自定义加载器
  else {
    //处理cjs 文件

    //获取文件扩展名，例如 .js, .ts, .mjs 等
    const extension = path.extname(fileName);

    // We don't use fsp.realpath() here because it has the same behaviour as
    // fs.realpath.native. On some Windows systems, it returns uppercase volume
    // letters (e.g. "C:\") while the Node.js loader uses lowercase volume letters.
    // See https://github.com/vitejs/vite/issues/12923

    //获取真实文件名
    const realFileName = await promisifiedRealpath(fileName);

    //检查配置文件的扩展名是否已经注册了加载器，如果没有，则默认为 .js
    const loaderExt = extension in _require.extensions ? extension : ".js";
    //备份当前注册的加载器，以便稍后恢复使用
    const defaultLoader = _require.extensions[loaderExt]!;

    // 替换默认的模块加载器，用打包后的代码进行加载
    _require.extensions[loaderExt] = (module: NodeModule, filename: string) => {
      //定义一个新的加载器函数。
      if (filename === realFileName) {
        //如果文件名匹配 realFileName，则使用 bundledCode 替换原始代码，并使用 _compile 方法编译模块
        (module as NodeModuleWithCompile)._compile(bundledCode, filename);
      } else {
        //否则，继续使用默认的加载器加载其他文件
        defaultLoader(module, filename);
      }
    };

    // 删除 Node.js 模块缓存中与配置文件相关联的条目。这确保了在下一次加载配置文件时，使用的是新的代码内容。
    delete _require.cache[_require.resolve(fileName)];
    // 使用 `_require` 加载文件，获取原始导出对象
    const raw = _require(fileName);

    // 恢复默认的模块加载器
    _require.extensions[loaderExt] = defaultLoader;

    // 如果是 ES 模块，则返回默认导出；否则直接返回原始对象
    return raw.__esModule ? raw.default : raw;
  }
}
