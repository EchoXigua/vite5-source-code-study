import path from "node:path";
import type { RollupOptions } from "rollup";
import type { Alias, AliasOptions } from "dep-types/alias";

import {
  asyncFlatten,
  isExternalUrl,
  mergeAlias,
  mergeConfig,
  normalizeAlias,
  normalizePath,
} from "./utils";
import type { HookHandler, Plugin, PluginWithRequiredHook } from "./plugin";

import {
  CLIENT_ENTRY,
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
import type { InternalResolveOptions, ResolveOptions } from "./plugins/resolve";
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
 * 主要目的是解析和生成 Vite 的配置
 * @param inlineConfig 用户传递的内联配置
 * @param command 命令类型，可以是 'build' 或 'serve'
 * @param defaultMode 默认模式，默认为 'development'
 * @param defaultNodeEnv 默认的 NODE_ENV，默认为 'development'
 * @param isPreview 是否是预览模式，默认为 false
 * @returns
 */
export async function resolveConfig(
  inlineConfig: any,
  command: "build" | "serve",
  defaultMode = "development",
  defaultNodeEnv = "development",
  isPreview = false
) {
  let config = inlineConfig;
  //初始化配置文件依赖数组
  let configFileDependencies: string[] = [];
  //确定模式
  let mode = inlineConfig.mode || defaultMode;
  //是否设置NODE_ENV
  const isNodeEnvSet = !!process.env.NODE_ENV;
  const packageCache = new Map();

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
  const filterany = (p: any) => {
    if (!p) {
      return false;
    } else if (!p.apply) {
      return true;
    } else if (typeof p.apply === "function") {
      return p.apply({ ...config, mode }, configEnv);
    } else {
      return p.apply === command;
    }
  };

  // resolve anys
  const rawUseranys = ((await asyncFlatten(config.anys || [])) as any[]).filter(
    filterany
  );
  //过滤用户插件，并将其按优先级分类（prePlugins, normalPlugins, postPlugins）。
  const [preanys, normalanys, postanys] = sortUseranys(rawUseranys);

  //运行配置钩子
  const useranys = [...preanys, ...normalanys, ...postanys];
  config = await runConfigHook(config, useranys, configEnv);

  // Define logger
  const logger = createLogger(config.logLevel, {
    allowClearScreen: config.clearScreen,
    customLogger: config.customLogger,
  });

  // 解析项目的根目录
  const resolvedRoot = normalizePath(
    config.root ? path.resolve(config.root) : process.cwd()
  );

  //   checkBadCharactersInPath(resolvedRoot, logger);

  //定义客户端别名
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

  const resolveOptions: any["resolve"] = {
    mainFields: config.resolve?.mainFields ?? DEFAULT_MAIN_FIELDS,
    conditions: config.resolve?.conditions ?? [],
    extensions: config.resolve?.extensions ?? DEFAULT_EXTENSIONS,
    dedupe: config.resolve?.dedupe ?? [],
    preserveSymlinks: config.resolve?.preserveSymlinks ?? false,
    alias: resolvedAlias,
  };

  //解析环境变量文件 .env files
  const envDir = config.envDir
    ? normalizePath(path.resolve(resolvedRoot, config.envDir))
    : resolvedRoot;
  const userEnv =
    inlineConfig.envFile !== false &&
    loadEnv(mode, envDir, resolveEnvPrefix(config));

  // Note it is possible for user to have a custom mode, e.g. `staging` where
  // development-like behavior is expected. This is indicated by NODE_ENV=development
  // loaded from `.staging.env` and set by us as VITE_USER_NODE_ENV
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
  const relativeBaseShortcut = config.base === "" || config.base === "./";

  // During dev, we ignore relative base and fallback to '/'
  // For the SSR build, relative base isn't possible by means
  // of import.meta.url.
  const resolvedBase = relativeBaseShortcut
    ? !isBuild || config.build?.ssr
      ? "/"
      : "./"
    : resolveBaseUrl(config.base, isBuild, logger) ?? "/";

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

export async function loadConfigFromFile(
  configEnv: ConfigEnv,
  configFile?: string,
  configRoot: string = process.cwd(),
  logLevel?: LogLevel,
  customLogger?: Logger
): Promise<{
  path: string;
  config: any;
  dependencies: string[];
} | null> {
  const start = performance.now();
  const getTime = () => `${(performance.now() - start).toFixed(2)}ms`;

  let resolvedPath: string | undefined;

  if (configFile) {
    // explicit config path is always resolved from cwd
    resolvedPath = path.resolve(configFile);
  } else {
    // implicit config file loaded from inline root (if present)
    // otherwise from cwd
    for (const filename of DEFAULT_CONFIG_FILES) {
      const filePath = path.resolve(configRoot, filename);
      if (!fs.existsSync(filePath)) continue;

      resolvedPath = filePath;
      break;
    }
  }

  if (!resolvedPath) {
    debug?.("no config file found.");
    return null;
  }

  const isESM = isFilePathESM(resolvedPath);

  try {
    const bundled = await bundleConfigFile(resolvedPath, isESM);
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

export function sortUseranys(
  anys: (any | any[])[] | undefined
): [any[], any[], any[]] {
  const preanys: any[] = [];
  const postanys: any[] = [];
  const normalanys: any[] = [];

  if (anys) {
    anys.flat().forEach((p) => {
      if (p.enforce === "pre") preanys.push(p);
      else if (p.enforce === "post") postanys.push(p);
      else normalanys.push(p);
    });
  }

  return [preanys, normalanys, postanys];
}

async function runConfigHook(
  config: any,
  plugins: any[],
  configEnv: ConfigEnv
): Promise<any> {
  let conf = config;

  for (const p of getSortedPluginsByHook("config", plugins)) {
    const hook = p.config;
    const handler = getHookHandler(hook);
    if (handler) {
      const res = await handler(conf, configEnv);
      if (res) {
        conf = mergeConfig(conf, res);
      }
    }
  }

  return conf;
}

export function resolveBaseUrl(
  base: any["base"] = "/",
  isBuild: boolean,
  logger: Logger
): string {
  if (base[0] === ".") {
    logger.warn(
      colors.yellow(
        colors.bold(
          `(!) invalid "base" option: "${base}". The value can only be an absolute ` +
            `URL, "./", or an empty string.`
        )
      )
    );
    return "/";
  }

  // external URL flag
  const isExternal = isExternalUrl(base);
  // no leading slash warn
  if (!isExternal && base[0] !== "/") {
    logger.warn(
      colors.yellow(colors.bold(`(!) "base" option should start with a slash.`))
    );
  }

  // parse base when command is serve or base is not External URL
  if (!isBuild || !isExternal) {
    base = new URL(base, "http://vitejs.dev").pathname;
    // ensure leading slash
    if (base[0] !== "/") {
      base = "/" + base;
    }
  }

  return base;
}
