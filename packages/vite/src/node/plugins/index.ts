import aliasPlugin, { type ResolverFunction } from "@rollup/plugin-alias";
import type { HookHandler, Plugin, PluginWithRequiredHook } from "../plugin";
import type { PluginHookUtils, ResolvedConfig } from "../config";
import { isDepsOptimizerEnabled } from "../config";
import { getDepsOptimizer } from "../optimizer";
import { shouldExternalizeForSSR } from "../ssr/ssrExternal";
import { importAnalysisPlugin } from "./importAnalysis";

// import { optimizedDepsPlugin } from "./optimizedDeps";
// import { watchPackageDataPlugin } from '../packages'
// import { preAliasPlugin } from "./preAlias";
import { resolvePlugin } from "./resolve";
import { getFsUtils } from "../fsUtils";

/**
 * 用于根据配置和插件类型（前置插件、普通插件和后置插件）解析和返回一个插件数组
 * @param config
 * @param prePlugins
 * @param normalPlugins
 * @param postPlugins
 * @returns
 */
export async function resolvePlugins(
  config: ResolvedConfig,
  prePlugins: Plugin[],
  normalPlugins: Plugin[],
  postPlugins: Plugin[]
): Promise<Plugin[]> {
  const isBuild = config.command === "build";
  const isWorker = config.isWorker;
  const buildPlugins = isBuild
    ? await (await import("../build")).resolveBuildPlugins(config)
    : { pre: [], post: [] };
  const { modulePreload } = config.build;

  /** 判断是否启用依赖优化 */
  const depsOptimizerEnabled =
    !isBuild &&
    (isDepsOptimizerEnabled(config, false) ||
      isDepsOptimizerEnabled(config, true));

  return [
    // depsOptimizerEnabled ? optimizedDepsPlugin(config) : null,
    // isBuild ? metadataPlugin() : null,
    // !isWorker ? watchPackageDataPlugin(config.packageCache) : null,
    // preAliasPlugin(config),
    aliasPlugin({
      entries: config.resolve.alias,
      customResolver: viteAliasCustomResolver,
    }),
    ...prePlugins,
    // modulePreload !== false && modulePreload.polyfill
    //   ? modulePreloadPolyfillPlugin(config)
    //   : null,
    resolvePlugin({
      // 将 config.resolve 对象中的所有属性展开并传递给 resolvePlugin
      // 这通常包括解析模块时使用的一些选项，如别名、扩展名等
      ...config.resolve,
      root: config.root, //根目录
      isProduction: config.isProduction, //指示当前环境是否为生产环境
      isBuild, //当前是否处于构建模式
      packageCache: config.packageCache, //缓存的包数据。用于加速模块解析和构建过程
      ssrConfig: config.ssr, //指定 SSR 相关的选项和设置
      // 指示是否以源代码的形式处理文件。这可能影响模块的解析和处理方式，通常用于开发模式下的动态导入等
      asSrc: true,
      fsUtils: getFsUtils(config), //文件系统工具
      /**这里很重要,涉及到 vite 依赖预构建缓存的处理,这里是获取依赖缓存的值 */
      getDepsOptimizer: isBuild
        ? undefined
        : (ssr: boolean) => getDepsOptimizer(config, ssr),
      // 用于确定某个模块是否应该被外部化的函数
      shouldExternalize:
        isBuild && config.build.ssr
          ? (id, importer) => shouldExternalizeForSSR(id, importer, config)
          : undefined,
    }),
    // htmlInlineProxyPlugin(config),
    // cssPlugin(config),
    // config.esbuild !== false ? esbuildPlugin(config) : null,
    // jsonPlugin(
    //   {
    //     namedExports: true,
    //     ...config.json,
    //   },
    //   isBuild
    // ),
    // wasmHelperPlugin(config),
    // webWorkerPlugin(config),
    // assetPlugin(config),
    ...normalPlugins,
    // wasmFallbackPlugin(),
    // definePlugin(config),
    // cssPostPlugin(config),
    // isBuild && buildHtmlPlugin(config),
    // workerImportMetaUrlPlugin(config),
    // assetImportMetaUrlPlugin(config),
    ...buildPlugins.pre,
    // dynamicImportVarsPlugin(config),
    // importGlobPlugin(config),
    ...postPlugins,
    ...buildPlugins.post,
    // internal server-only plugins are always applied after everything else
    ...(isBuild
      ? []
      : [
          // clientInjectionsPlugin(config),
          // cssAnalysisPlugin(config),
          importAnalysisPlugin(config),
        ]),
  ].filter(Boolean) as Plugin[];
}

export function getHookHandler(hook: any) {
  return (typeof hook === "object" ? hook.handler : hook) as any;
}

export function createPluginHookUtils(
  plugins: readonly Plugin[]
): PluginHookUtils {
  // 用于缓存按钩子名称排序后的插件数组,可以提高性能，避免重复计算排序
  const sortedPluginsCache = new Map<keyof Plugin, Plugin[]>();

  /**
   * 获取排序后的插件
   * @param hookName
   * @returns
   */
  function getSortedPlugins<K extends keyof Plugin>(
    hookName: K
  ): PluginWithRequiredHook<K>[] {
    if (sortedPluginsCache.has(hookName))
      return sortedPluginsCache.get(hookName) as PluginWithRequiredHook<K>[];

    // 对 plugins 数组按照给定的钩子名称 hookName 进行排序，。
    const sorted = getSortedPluginsByHook(hookName, plugins);
    // 并将排序结果存入 sortedPluginsCache(设置缓存)
    sortedPluginsCache.set(hookName, sorted);
    return sorted;
  }

  /**
   * 获取排序后插件的hook函数
   * @param hookName
   * @returns
   */
  function getSortedPluginHooks<K extends keyof Plugin>(
    hookName: K
  ): NonNullable<HookHandler<Plugin[K]>>[] {
    // 获取排序后的插件
    const plugins = getSortedPlugins(hookName);
    // 遍历每个插件，并通过 getHookHandler 函数获取该插件在给定钩子上的处理函数
    /**
     * 使用 filter(Boolean) 过滤掉空值（未定义的处理函数）
     *
     * 怎么做到的？
     *  当应用于数组时，filter(Boolean) 实际上会对数组中的每个元素应用 Boolean 函数。
     *  Boolean 函数会将每个元素转换为布尔值并返回结果
     *
     *  1. 对于大多数对象来说，包括数组，Boolean(obj) 都会返回 true
     *  2. 对于 undefined、null、0、''、NaN 等值，Boolean(value) 都会返回 false
     */
    return plugins.map((p) => getHookHandler(p[hookName])).filter(Boolean);
  }

  return {
    getSortedPlugins,
    getSortedPluginHooks,
  };
}

/**
 * 根据指定钩子的顺序（pre、normal、post）对插件进行排序。
 * 排序后的插件将按照指定的钩子顺序插入到结果数组中。
 *
 * @param hookName 要排序的钩子名称
 * @param plugins 插件数组
 * @returns 包含指定钩子的插件数组
 */
export function getSortedPluginsByHook<K extends keyof Plugin>(
  hookName: K,
  plugins: readonly Plugin[]
): PluginWithRequiredHook<K>[] {
  //初始化排序数组和索引
  const sortedPlugins: Plugin[] = [];
  //使用索引来跟踪并直接将有序的插件插入到结果数组中，以避免每个钩子创建3个额外的临时数组

  //pre、normal、post，分别用于跟踪 pre、normal 和 post 插件的位置。
  let pre = 0,
    normal = 0,
    post = 0;

  //遍历插件数组
  for (const plugin of plugins) {
    //每个插件的指定钩子 hook
    const hook = plugin[hookName];
    if (hook) {
      if (typeof hook === "object") {
        //如果 hook 存在且是一个对象，根据 hook.order 的值插入插件到 sortedPlugins 数组的相应位置：
        if (hook.order === "pre") {
          //入到 pre 索引位置，并增加 pre 索引
          sortedPlugins.splice(pre++, 0, plugin);
          continue;
        }
        if (hook.order === "post") {
          //插入到 pre + normal + post 索引位置，并增加 post 索引
          sortedPlugins.splice(pre + normal + post++, 0, plugin);
          continue;
        }
      }

      //其他情况：插入到 pre + normal 索引位置，并增加 normal 索引。
      sortedPlugins.splice(pre + normal++, 0, plugin);
    }
  }

  //返回排序后的插件数组
  return sortedPlugins as PluginWithRequiredHook<K>[];
}

// Same as `@rollup/plugin-alias` default resolver, but we attach additional meta
// if we can't resolve to something, which will error in `importAnalysis`
export const viteAliasCustomResolver: ResolverFunction = async function (
  id,
  importer,
  options
) {
  const resolved = await this.resolve(id, importer, options);
  return resolved || { id, meta: { "vite:alias": { noResolved: true } } };
};
