import type {
  CustomPluginOptions,
  LoadResult,
  ObjectHook,
  PluginContext,
  ResolveIdResult,
  Plugin as RollupPlugin,
  TransformPluginContext,
  TransformResult,
} from "rollup";
export type { PluginContext } from "rollup";
import type { ConfigEnv, ResolvedConfig, UserConfig } from "./config";
import type { ServerHook } from "./server";

/**
 * Vite 插件扩展了 Rollup 插件接口，添加了一些特定于 Vite 的选项。
 * 有效的 Vite 插件也是有效的 Rollup 插件。反之，一个 Rollup 插件可能是也可能不是
 * 有效的 Vite 通用插件，因为一些 Rollup 功能在未打包的开发服务器上下文中没有意义。
 * 也就是说，只要一个 Rollup 插件在其打包阶段和输出阶段钩子之间没有强耦合，那么它应该
 * 可以正常工作（这意味着大多数插件可以）。
 *
 * 默认情况下，插件在 serve 和 build 阶段都会运行。当插件在 serve 阶段应用时，
 * 它只会运行 **非输出插件钩子**（请参阅 rollup 类型定义的 {@link rollup#PluginHooks}）。
 * 你可以认为开发服务器只运行 `const bundle = rollup.rollup()` 但从不调用 `bundle.generate()`。
 *
 * 期望根据 serve/build 阶段有不同行为的插件可以导出一个工厂函数，
 * 该函数通过 options 接收正在运行的命令。
 *
 * 如果一个插件应该只应用于服务器或构建阶段，可以使用函数格式的配置文件来有条件地确定使用的插件。
 */
export interface Plugin<A = any> extends RollupPlugin<A> {
  /**
   * 强制插件调用层级，类似于 webpack 加载器。钩子顺序仍然受钩子对象中的 `order` 属性影响。
   *
   * 插件调用顺序：
   * - 别名解析
   * - `enforce: 'pre'` 插件
   * - vite 核心插件
   * - 普通插件
   * - vite 构建插件
   * - `enforce: 'post'` 插件
   * - vite 构建后插件
   */
  enforce?: "pre" | "post";

  /**
   * 仅应用于 serve 或 build，或在某些条件下应用插件。
   */
  apply?:
    | "serve"
    | "build"
    | ((this: void, config: UserConfig, env: ConfigEnv) => boolean);

  /**
   * 在 Vite 配置解析之前修改配置。钩子可以直接修改传入的配置，或返回一个部分配置对象，
   * 该对象将与现有配置进行深度合并。
   *
   * 注意：用户插件在运行此钩子之前解析，因此在 `config` 钩子中注入其他插件将无效。
   */
  config?: ObjectHook<
    (
      this: void,
      config: UserConfig,
      env: ConfigEnv
    ) =>
      | Omit<UserConfig, "plugins">
      | null
      | void
      | Promise<Omit<UserConfig, "plugins"> | null | void>
  >;

  /**
   * 使用此钩子读取并存储最终解析的 Vite 配置。
   */
  configResolved?: ObjectHook<
    (this: void, config: ResolvedConfig) => void | Promise<void>
  >;

  /**
   * 配置 Vite 服务器。钩子接收 {@link ViteDevServer} 实例。这也可以用于存储服务器的引用
   * 以在其他钩子中使用。
   *
   * 这些钩子将在应用内部中间件之前调用。一个钩子可以返回一个后置钩子，该钩子将在应用内部中间件
   * 之后调用。钩子可以是异步函数，并将按顺序调用。
   */
  configureServer?: ObjectHook<ServerHook>;

  /**
   * 配置预览服务器。钩子接收 {@link PreviewServer} 实例。这也可以用于存储服务器的引用
   * 以在其他钩子中使用。
   *
   * 这些钩子将在应用其他中间件之前调用。一个钩子可以返回一个后置钩子，该钩子将在应用其他中间件
   * 之后调用。钩子可以是异步函数，并将按顺序调用。
   */
  configurePreviewServer?: ObjectHook<PreviewServerHook>;

  /**
   * 转换 index.html。钩子接收以下参数：
   *
   * - html: string
   * - ctx?: vite.ServerContext（仅在 serve 阶段存在）
   * - bundle?: rollup.OutputBundle（仅在 build 阶段存在）
   *
   * 它可以返回一个转换后的字符串，或者一个将被注入到 `<head>` 或 `<body>` 中的 HTML 标签描述符列表。
   *
   * 默认情况下，转换在 Vite 的内部 HTML 转换之后应用。如果需要在 Vite 之前应用转换，请使用对象：
   * `{ order: 'pre', handler: hook }`
   */
  transformIndexHtml?: IndexHtmlTransform;

  /**
   * 执行自定义的 HMR 更新处理。
   * 处理程序接收一个上下文，其中包含更改的文件名、时间戳、受文件更改影响的模块列表以及开发服务器实例。
   *
   * - 钩子可以返回一个过滤后的模块列表，以缩小更新范围。例如，对于 Vue SFC，我们可以通过比较描述符
   *   来缩小要更新的部分。
   *
   * - 钩子还可以返回一个空数组，然后通过服务器的 server.hot.send() 发送自定义的 HMR 负载来执行自定义更新。
   *
   * - 如果钩子不返回值，HMR 更新将按正常方式执行。
   */
  handleHotUpdate?: ObjectHook<
    (
      this: void,
      ctx: HmrContext
    ) => Array<ModuleNode> | void | Promise<Array<ModuleNode> | void>
  >;

  /**
   * 扩展带有 ssr 标志的钩子。
   */
  resolveId?: ObjectHook<
    (
      this: PluginContext,
      source: string,
      importer: string | undefined,
      options: {
        attributes: Record<string, string>;
        custom?: CustomPluginOptions;
        ssr?: boolean;
        /**
         * @internal
         */
        scan?: boolean;
        isEntry: boolean;
      }
    ) => Promise<ResolveIdResult> | ResolveIdResult
  >;

  /**
   * 用于自定义模块的加载过程。它可以用来加载自定义模块内容或处理特定类型的文件。
   */
  load?: ObjectHook<
    (
      this: PluginContext, //插件的上下文
      id: string, //要加载的模块的标识符
      options?: { ssr?: boolean }
    ) => Promise<LoadResult> | LoadResult
  >;

  /**
   * 用于自定义模块内容的转换过程。它可以用来转换模块代码，例如编译预处理器（如 TypeScript 或 Less）或应用其他代码转换。
   */
  transform?: ObjectHook<
    (
      this: TransformPluginContext,
      code: string,
      id: string,
      options?: { ssr?: boolean }
    ) => Promise<TransformResult> | TransformResult
  >;
}

/**
 * infer只能在extends类型子句中使用
 * infer存储的变量H只能用于语句的true返回分支
 */
export type HookHandler<T> = T extends ObjectHook<infer H> ? H : T;

//NonNullable   去除 null 和 undefined 后的新类型
export type PluginWithRequiredHook<K extends keyof Plugin> = Plugin & {
  [P in K]: NonNullable<Plugin[P]>;
};
