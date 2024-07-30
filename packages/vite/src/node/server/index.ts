import path from "node:path";
import { execSync } from "node:child_process";
import type { Http2SecureServer } from "node:http2";
import type * as net from "node:net";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import type * as http from "node:http";

import connect from "connect";
import chokidar from "chokidar";
import colors from "picocolors";
import corsMiddleware from "cors";
import type { SourceMap } from "rollup";
import picomatch from "picomatch";
import type { Matcher } from "picomatch";
import type { Connect } from "dep-types/connect";
import type { FSWatcher, WatchOptions } from "dep-types/chokidar";
import launchEditorMiddleware from "launch-editor-middleware";

import { createWebSocketServer } from "./ws";
import { getEnvFilesForMode } from "../env";
import { isDepsOptimizerEnabled, resolveConfig } from "../config";
import type { InlineConfig, ResolvedConfig } from "../config";
import {
  createHMRBroadcaster,
  createServerHMRChannel,
  getShortName,
  handleHMRUpdate,
  // updateModules,
} from "./hmr";
import type { HMRBroadcaster, HmrOptions } from "./hmr";

import { initPublicFiles } from "../publicDir";
import {
  httpServerStart,
  resolveHttpServer,
  resolveHttpsConfig,
  setClientErrorHandler,
} from "../http";
import {
  createNoopWatcher,
  getResolvedOutDirs,
  resolveChokidarOptions,
  resolveEmptyOutDir,
} from "../watch";
import { CLIENT_DIR, DEFAULT_DEV_PORT } from "../constants";
import {
  diffDnsOrderChange,
  isInNodeModules,
  isObject,
  isParentDirectory,
  mergeConfig,
  normalizePath,
  promiseWithResolvers,
  resolveHostname,
  resolveServerUrls,
} from "../utils";
import { ModuleGraph } from "./moduleGraph";
import type { ModuleNode } from "./moduleGraph";
import { ERR_CLOSED_SERVER, createPluginContainer } from "./pluginContainer";
// import { ssrTransform } from "../ssr/ssrTransform";
// import { ssrLoadModule } from "../ssr/ssrModuleLoader";
// import { ssrFetchModule } from "../ssr/ssrFetchModule";
// import { ssrFixStacktrace, ssrRewriteStacktrace } from "../ssr/ssrStacktrace";

import { ERR_OUTDATED_OPTIMIZED_DEP } from "../plugins/optimizedDeps";
import { openBrowser as _openBrowser } from "./openBrowser";
import { getDepsOptimizer, initDepsOptimizer } from "../optimizer";
import { printServerUrls } from "../logger";
import { bindCLIShortcuts } from "../shortcuts";
import type { BindCLIShortcutsOptions } from "../shortcuts";
import { getFsUtils } from "../fsUtils";

//中间件的处理
import { errorMiddleware, prepareError } from "./middlewares/error";
// import { timeMiddleware } from "./middlewares/time";

// 这里的代码关系到裸导入转换完成后，返回给浏览器
import {
  cachedTransformMiddleware,
  transformMiddleware,
} from "./middlewares/transform";
// import { proxyMiddleware } from "./middlewares/proxy";
// import { baseMiddleware } from "./middlewares/base";
import {
  servePublicMiddleware,
  serveRawFsMiddleware,
  serveStaticMiddleware,
} from "./middlewares/static";
import { htmlFallbackMiddleware } from "./middlewares/htmlFallback";
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware,
} from "./middlewares/indexHtml";
import { notFoundMiddleware } from "./middlewares/notFound";
import type { CommonServerOptions } from "../http";

import { searchForWorkspaceRoot } from "./searchRoot";

//文件预热
import { transformRequest } from "./transformRequest";
import { warmupFiles } from "./warmup";

export interface ServerOptions extends CommonServerOptions {
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   */
  hmr?: HmrOptions | boolean;
  /**
   * Warm-up files to transform and cache the results in advance. This improves the
   * initial page load during server starts and prevents transform waterfalls.
   */
  warmup?: {
    /**
     * The files to be transformed and used on the client-side. Supports glob patterns.
     */
    clientFiles?: string[];
    /**
     * The files to be transformed and used in SSR. Supports glob patterns.
     */
    ssrFiles?: string[];
  };
  /**
   * chokidar watch options or null to disable FS watching
   * https://github.com/paulmillr/chokidar#api
   */
  watch?: WatchOptions | null;
  /**
   * Create Vite dev server to be used as a middleware in an existing server
   * @default false
   */
  middlewareMode?:
    | boolean
    | {
        /**
         * Parent server instance to attach to
         *
         * This is needed to proxy WebSocket connections to the parent server.
         */
        server: http.Server;
      };
  /**
   * Options for files served via '/\@fs/'.
   */
  fs?: FileSystemServeOptions;
  /**
   * Origin for the generated asset URLs.
   *
   * @example `http://127.0.0.1:8080`
   */
  origin?: string;
  /**
   * Pre-transform known direct imports
   * @default true
   */
  preTransformRequests?: boolean;
  /**
   * Whether or not to ignore-list source files in the dev server sourcemap, used to populate
   * the [`x_google_ignoreList` source map extension](https://developer.chrome.com/blog/devtools-better-angular-debugging/#the-x_google_ignorelist-source-map-extension).
   *
   * By default, it excludes all paths containing `node_modules`. You can pass `false` to
   * disable this behavior, or, for full control, a function that takes the source path and
   * sourcemap path and returns whether to ignore the source path.
   */
  sourcemapIgnoreList?:
    | false
    | ((sourcePath: string, sourcemapPath: string) => boolean);
}

export interface FileSystemServeOptions {
  /**
   * Strictly restrict file accessing outside of allowing paths.
   *
   * Set to `false` to disable the warning
   *
   * @default true
   */
  strict?: boolean;

  /**
   * Restrict accessing files outside the allowed directories.
   *
   * Accepts absolute path or a path relative to project root.
   * Will try to search up for workspace root by default.
   */
  allow?: string[];

  /**
   * Restrict accessing files that matches the patterns.
   *
   * This will have higher priority than `allow`.
   * picomatch patterns are supported.
   *
   * @default ['.env', '.env.*', '*.crt', '*.pem']
   */
  deny?: string[];

  /**
   * Enable caching of fs calls. It is enabled by default if no custom watch ignored patterns are provided.
   *
   * @experimental
   * @default undefined
   */
  cachedChecks?: boolean;
}

export type HttpServer = http.Server | Http2SecureServer;

export type ServerHook = (
  this: void,
  server: ViteDevServer
) => (() => void) | void | Promise<(() => void) | void>;
export interface ViteDevServer {
  /**
   *  存储了解析后的 Vite 配置对象
   */
  config: ResolvedConfig;
  /**
   * 是一个 Connect 应用实例.
   *  1. 可用于在开发服务器上挂载自定义中间件
   *  2. 也可以用作自定义http服务器的处理函数或作为任何连接风格的Node.js框架中的中间件
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server;
  /**
   *  是一个原生的 Node.js HTTP 服务器实例，在中间件模式下为 null。
   */
  httpServer: HttpServer | null;
  /**
   * 一个 Chokidar 监视器实例，用于监视文件变化。
   * https://github.com/paulmillr/chokidar#api
   */
  watcher: FSWatcher;
  /**
   * 一个 WebSocket 服务器实例，用于与客户端进行实时通信,有send 方法
   * @deprecated use `hot` instead
   */
  ws: WebSocketServer;
  /**
   * 一个 HMR 广播器，用于向客户端发送自定义的 HMR 消息
   *
   * 总是向至少一个WebSocket客户端发送消息。任何第三方都可以向广播器添加通道来处理消息
   */
  hot: HMRBroadcaster;
  /**
   * 一个 Rollup 插件容器，可以在给定文件上运行插件钩子。
   */
  pluginContainer: PluginContainer;
  /**
   *  是一个模块图，跟踪导入关系、URL 到文件映射和 HMR 状态。
   */
  moduleGraph: ModuleGraph;
  /**
   *  存储 Vite 在 CLI 上打印的解析后的 URLs，在中间件模式下或 server.listen 调用前为 null
   */
  resolvedUrls: ResolvedServerUrls | null;
  /**
   * 用于程序化地解析、加载和转换 URL，并获取结果，避免通过 HTTP 请求管道
   */
  transformRequest(
    url: string,
    options?: TransformOptions
  ): Promise<TransformResult | null>;
  /**
   *
   * 类似于 transformRequest，但仅预热 URLs，以便下一次请求可以从缓存中获取
   * 该函数在内部处理和报告错误时永远不会抛出错误
   */
  warmupRequest(url: string, options?: TransformOptions): Promise<void>;
  /**
   * 应用 Vite 内置的 HTML 转换和任何插件的 HTML 转换
   */
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string
  ): Promise<string>;
  /**
   * 将模块代码转换为 SSR 格式
   */
  ssrTransform(
    code: string,
    inMap: SourceMap | { mappings: "" } | null,
    url: string,
    originalCode?: string
  ): Promise<TransformResult | null>;
  /**
   * 加载给定 URL 作为 SSR 的实例化模块
   */
  ssrLoadModule(
    url: string,
    opts?: { fixStacktrace?: boolean }
  ): Promise<Record<string, any>>;
  /**
   * 获取有关 Vite SSR 运行时模块的信息
   * @experimental
   */
  ssrFetchModule(id: string, importer?: string): Promise<FetchResult>;
  /**
   * 返回给定堆栈的修复版本
   */
  ssrRewriteStacktrace(stack: string): string;
  /**
   *  修复给定 SSR 错误的堆栈跟踪。
   */
  ssrFixStacktrace(e: Error): void;
  /**
   *  触发模块在模块图中的 HMR。可以使用 server.moduleGraph API 获取要重新加载的模块。
   */
  reloadModule(module: ModuleNode): Promise<void>;
  /**
   * 启动服务器
   */
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>;
  /**
   * 停止服务器
   */
  close(): Promise<void>;
  /**
   * 打印服务器 URL
   */
  printUrls(): void;
  /**
   * 绑定 CLI 快捷方式
   */
  bindCLIShortcuts(options?: BindCLIShortcutsOptions<ViteDevServer>): void;
  /**
   * 重启服务器
   *
   * @param forceOptimize - force the optimizer to re-bundle, same as --force cli flag
   */
  restart(forceOptimize?: boolean): Promise<void>;

  /**
   * 打开浏览器
   */
  openBrowser(): void;
  /**
   * Calling `await server.waitForRequestsIdle(id)` will wait until all static imports
   * are processed. If called from a load or transform plugin hook, the id needs to be
   * passed as a parameter to avoid deadlocks. Calling this function after the first
   * static imports section of the module graph has been processed will resolve immediately.
   * @experimental
   */
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>;
  /**
   * 注册请求处理函数
   * @internal
   */
  _registerRequestProcessing: (
    id: string,
    done: () => Promise<unknown>
  ) => void;
  /**
   * 爬取结束时的回调注册函数
   * @internal
   */
  _onCrawlEnd(cb: () => void): void;
  /**
   * 设置内部服务器函数
   * @internal
   */
  _setInternalServer(server: ViteDevServer): void;
  /**
   * @internal
   */
  _importGlobMap: Map<string, { affirmed: string[]; negated: string[] }[]>;
  /**
   * @internal
   */
  _restartPromise: Promise<void> | null;
  /**
   * @internal
   */
  _forceOptimizeOnRestart: boolean;
  /**
   * @internal
   */
  _pendingRequests: Map<
    string,
    {
      request: Promise<TransformResult | null>;
      timestamp: number;
      abort: () => void;
    }
  >;
  /**
   * @internal
   */
  _fsDenyGlob: Matcher;
  /**
   * @internal
   */
  _shortcutsOptions?: BindCLIShortcutsOptions<ViteDevServer>;
  /**
   * @internal
   */
  _currentServerPort?: number | undefined;
  /**
   * @internal
   */
  _configServerPort?: number | undefined;
}

export interface ResolvedServerUrls {
  local: string[];
  network: string[];
}

export function createServer(inlineConfig = {}) {
  return _createServer(inlineConfig, { hotListen: true });
}
export async function _createServer(
  inlineConfig: InlineConfig = {},
  options: { hotListen: boolean }
): Promise<ViteDevServer> {
  //返回一个解析后的配置
  const config = await resolveConfig(inlineConfig, "serve");

  //初始化公共文件，返回一个 Promise 对象 initPublicFilesPromise。
  const initPublicFilesPromise = initPublicFiles(config);

  const { root, server: serverConfig } = config;

  //解析 HTTPS 配置
  const httpsOptions = await resolveHttpsConfig(config.server.https);
  const { middlewareMode } = serverConfig;

  //解析输出目录
  const resolvedOutDirs = getResolvedOutDirs(
    config.root,
    config.build.outDir,
    config.build.rollupOptions?.output
  );
  //解析输出目录是否应该被清空
  const emptyOutDir = resolveEmptyOutDir(
    config.build.emptyOutDir,
    config.root,
    resolvedOutDirs
  );
  const resolvedWatchOptions = resolveChokidarOptions(
    config,
    {
      disableGlobbing: true,
      ...serverConfig.watch,
    },
    resolvedOutDirs,
    emptyOutDir
  );

  const middlewares = connect() as Connect.Server;
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(serverConfig, middlewares, httpsOptions);

  //返回一个 WebSocket 服务器，用于处理客户端的连接和消息。
  const ws = createWebSocketServer(httpServer, config, httpsOptions);
  // 返回一个 HMR 广播器对象
  const hot = createHMRBroadcaster()
    //将之前创建的 ws WebSocket 服务器对象作为一个频道添加到 HMR 广播器中
    .addChannel(ws)
    //将另一个频道 createServerHMRChannel() 添加到 HMR 广播器中
    .addChannel(createServerHMRChannel());
  if (typeof config.server.hmr === "object" && config.server.hmr.channels) {
    //检查 config 中是否有 server.hmr 属性，并且它是一个对象且包含 channels 属性

    //遍历 config.server.hmr.channels 数组，将每个通道对象通过 hot.addChannel(channel) 添加到 HMR 广播器中
    config.server.hmr.channels.forEach((channel) => hot.addChannel(channel));
  }

  //初始化公共文件
  const publicFiles = await initPublicFilesPromise;
  const { publicDir } = config;

  if (httpServer) {
    //设置客户端错误处理程序，通常用于捕获和处理客户端请求中的错误信息。
    setClientErrorHandler(httpServer, config.logger);
  }

  // eslint-disable-next-line eqeqeq
  //根据 serverConfig.watch 的值来决定是否启用文件监视器，并创建相应的监视器对象
  const watchEnabled = serverConfig.watch !== null;
  const watcher = watchEnabled
    ? (chokidar.watch(
        //创建一个 chokidar 的文件监视器对象
        // 配置文件依赖项和env文件可能在根目录之外
        [
          //数组中包含了需要监视的路径：
          //根目录 、配置文件依赖、环境文件、公共文件目录（如果存在）
          root,
          ...config.configFileDependencies,
          ...getEnvFilesForMode(config.mode, config.envDir),
          //显式地监视公共目录，因为它可能位于根目录之外。
          ...(publicDir && publicFiles ? [publicDir] : []),
        ],
        resolvedWatchOptions
      ) as FSWatcher)
    : //createNoopWatcher 是一个函数，用于创建一个空的监视器对象或者一个不执行任何操作的监视器对象
      //根据 resolvedWatchOptions 的设置来决定其行为。
      createNoopWatcher(resolvedWatchOptions);

  const moduleGraph: ModuleGraph = new ModuleGraph((url, ssr) =>
    container.resolveId(url, undefined, { ssr })
  );

  //创建插件容器
  const container = await createPluginContainer(config, moduleGraph, watcher);
  //关闭 HTTP 服务器的函数
  const closeHttpServer = createServerCloseFn(httpServer);

  //用于退出进程或执行其他清理操作。
  let exitProcess: () => void;

  //创建开发环境下的 HTML 转换函数：
  const devHtmlTransformFn = createDevHtmlTransformFn(config);

  //用于存储在爬取结束时需要执行的回调函数
  const onCrawlEndCallbacks: (() => void)[] = [];

  //设置爬取结束时的回调触发器
  //setupOnCrawlEnd 函数接受一个回调函数作为参数，这个回调函数会在爬取结束时被调用。
  const crawlEndFinder = setupOnCrawlEnd(() => {
    onCrawlEndCallbacks.forEach((cb) => cb());
  });

  //等待请求空闲，即等待所有请求处理完成。
  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    return crawlEndFinder.waitForRequestsIdle(ignoredId);
  }

  //用于注册请求处理的回调函数。
  function _registerRequestProcessing(id: string, done: () => Promise<any>) {
    crawlEndFinder.registerRequestProcessing(id, done);
  }

  //将传入的回调函数 cb 推入 onCrawlEndCallbacks 数组
  //作用是注册在爬取结束时需要执行的回调函数，用于处理爬取结束后的逻辑。
  function _onCrawlEnd(cb: () => void) {
    onCrawlEndCallbacks.push(cb);
  }

  let server: ViteDevServer = {
    config,
    middlewares,
    httpServer,
    watcher,
    pluginContainer: container,
    ws,
    hot,
    moduleGraph,
    resolvedUrls: null, // will be set on listen
    ssrTransform(
      code: string,
      inMap: SourceMap | { mappings: "" } | null,
      url: string,
      originalCode = code
    ) {
      return ssrTransform(code, inMap, url, originalCode, server.config);
    },
    transformRequest(url, options) {
      return transformRequest(url, server, options);
    },
    async warmupRequest(url, options) {
      try {
        await transformRequest(url, server, options);
      } catch (e) {
        if (
          e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
          e?.code === ERR_CLOSED_SERVER
        ) {
          // these are expected errors
          return;
        }
        // Unexpected error, log the issue but avoid an unhandled exception
        server.config.logger.error(`Pre-transform error: ${e.message}`, {
          error: e,
          timestamp: true,
        });
      }
    },
    transformIndexHtml(url, html, originalUrl) {
      return devHtmlTransformFn(server, url, html, originalUrl);
    },
    async ssrLoadModule(url, opts?: { fixStacktrace?: boolean }) {
      return ssrLoadModule(
        url,
        server,
        undefined,
        undefined,
        opts?.fixStacktrace
      );
    },
    async ssrFetchModule(url: string, importer?: string) {
      return ssrFetchModule(server, url, importer);
    },
    ssrFixStacktrace(e) {
      ssrFixStacktrace(e, moduleGraph);
    },
    ssrRewriteStacktrace(stack: string) {
      return ssrRewriteStacktrace(stack, moduleGraph);
    },
    async reloadModule(module) {
      if (serverConfig.hmr !== false && module.file) {
        updateModules(module.file, [module], Date.now(), server);
      }
    },
    async listen(port?: number, isRestart?: boolean) {
      //用于启动 Vite 开发服务器并监听指定的端口
      await startServer(server, port);
      if (httpServer) {
        //来解析服务器的 URL
        server.resolvedUrls = await resolveServerUrls(
          httpServer,
          config.server,
          config
        );
        //如果不是重新启动，并且配置中指定了 open 为 true，则调用 server.openBrowser() 打开浏览器。
        if (!isRestart && config.server.open) server.openBrowser();
      }
      return server;
    },
    //用于在浏览器中打开 Vite 服务器的解析后的 URL。
    openBrowser() {
      //获取服务器配置选项
      const options = server.config.server;

      //尝试从 server.resolvedUrls 中获取本地 (local) 或网络 (network) 地址的第一个 URL。
      const url =
        server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0];
      if (url) {
        //生成最终的打开路径
        const path =
          typeof options.open === "string"
            ? new URL(options.open, url).href
            : url;

        /**
         * 这段注释解释了为什么在调用浏览器打开 URL 之前，会提前发起一个 HTTP 请求
         *
         * 1. 我们知道浏览器将要打开的 URL：这指的是在 openBrowser 方法中已经确定了要打开的具体 URL 地址。
         * 2. 可以在等待浏览器打开的同时开始请求：由于已经知道将要打开的 URL，所以可以在浏览器打开之前，就开始发起 HTTP 请求。
         * 3. 这将会在静态导入的处理开始前约500毫秒：通过在等待浏览器的过程中发起请求，
         *    可以提前约500毫秒地开始处理静态导入。这是因为在处理入口文件时，会发现静态导入的模块，
         *    从而可以提前加载这些模块，以提高加载性能和效率。
         * 4. 需要启用 preTransformRequests 才能实现此优化：为了能够执行这种优化，
         *    必须在 Vite 服务器的配置中启用 preTransformRequests 选项，这样服务器就能预处理静态导入，提前加载相关资源。
         */

        //如果配置中启用了 server.preTransformRequests，则会通过 setTimeout 在0秒后发起 HTTP GET 请求
        if (server.config.server.preTransformRequests) {
          //将请求的发起安排在异步事件队列的下一个周期中，而不是具体的500毫秒延迟。
          //这种做法是为了在浏览器打开之前尽可能早地触发静态资源的加载和处理。
          setTimeout(() => {
            //根据 path 的协议 (https 或 http) 使用相应的方法 (httpsGet 或 httpGet) 发起请求。
            const getMethod = path.startsWith("https:") ? httpsGet : httpGet;

            getMethod(
              path,
              {
                //设置请求头
                headers: {
                  // 允许服务器使用历史中间件重定向到 /index.html, 这里主要解决历史模式下，刷新404的问题
                  // 刷新页面或直接访问子路由时能正确地返回主页面（即 index.html）
                  Accept: "text/html",
                },
              },
              (res) => {
                res.on("end", () => {
                  //请求结束时忽略响应，因为在处理入口时发现的脚本将会被预处理
                });
              }
            )
              .on("error", () => {
                // 在发生错误时忽略错误。
              })
              .end();
          }, 0);
        }

        //打开浏览器
        _openBrowser(path, true, server.config.logger);
      } else {
        //如果无法获取有效的 URL，则通过日志记录器输出警告信息
        server.config.logger.warn("No URL available to open in browser");
      }
    },
    //实现了关闭服务器的异步函数
    async close() {
      //检查是否处于中间件模式
      if (!middlewareMode) {
        //移除 SIGTERM 信号的处理和 stdin 流的监听。
        process.off("SIGTERM", exitProcess);
        if (process.env.CI !== "true") {
          process.stdin.off("end", exitProcess);
        }
      }
      //关闭多个资源
      await Promise.allSettled([
        watcher.close(),
        hot.close(),
        container.close(), //Rollup plugin container
        crawlEndFinder?.cancel(),
        getDepsOptimizer(server.config)?.close(), //关闭非 SSR 请求的依赖优化器
        getDepsOptimizer(server.config, true)?.close(), //关闭 SSR 请求的依赖优化器
        closeHttpServer(), //关闭 HTTP 服务器
      ]);

      /**
       * 等待所有挂起的请求完成。在服务器关闭过程中，确保所有未完成的请求都得到了处理
       * 以便安全地关闭服务器并清理资源
       *
       * 如果服务器正在处理非 SSR 请求并即将关闭，那么在 transformRequest 函数或其它插件钩子中，
       * 会提前抛出错误。这样做是为了停止对静态导入进行预转换，以便尽早解决关闭操作。
       *
       * 对于 SSR 请求，我们允许所有挂起的请求完成，以避免向用户暴露服务器已关闭的错误。
       * 这是因为 SSR 请求可能需要完成其处理流程，否则可能导致用户体验上的问题或错误信息泄露。
       */

      //检查是否还有挂起的请求未处理
      while (server._pendingRequests.size > 0) {
        //等待所有挂起请求的 Promise 完成。
        await Promise.allSettled(
          [...server._pendingRequests.values()].map(
            (pending) => pending.request
          )
        );
      }

      //清空 server._pendingRequests，确保所有挂起的请求都得到了处理
      server.resolvedUrls = null;
    },
    printUrls() {
      if (server.resolvedUrls) {
        printServerUrls(
          server.resolvedUrls,
          serverConfig.host,
          config.logger.info
        );
      } else if (middlewareMode) {
        throw new Error("cannot print server URLs in middleware mode.");
      } else {
        throw new Error(
          "cannot print server URLs before server.listen is called."
        );
      }
    },
    bindCLIShortcuts(options) {
      bindCLIShortcuts(server, options);
    },
    async restart(forceOptimize?: boolean) {
      //检查 server._restartPromise 是否存在，来确定服务器是否已经在重启过程中
      if (!server._restartPromise) {
        //如果指定了 forceOptimize 参数为 true，
        //则将 _forceOptimizeOnRestart 设置为 true，表示在重启时需要强制优化。
        server._forceOptimizeOnRestart = !!forceOptimize;

        //开始执行重启操作
        server._restartPromise = restartServer(server).finally(() => {
          //执行清理操作
          //将 _restartPromise 设置为 null，表示重启操作已完成
          server._restartPromise = null;
          //_forceOptimizeOnRestart 设置为 false，重置优化标志为默认值。
          server._forceOptimizeOnRestart = false;
        });
      }

      //如果存在，则表示重启正在进行，直接返回当前的 _restartPromise，避免重复触发重启
      return server._restartPromise;
    },

    waitForRequestsIdle,
    _registerRequestProcessing,
    _onCrawlEnd,

    _setInternalServer(_server: ViteDevServer) {
      // Rebind internal the server variable so functions reference the user
      // server instance after a restart
      server = _server;
    },
    _restartPromise: null,
    _importGlobMap: new Map(),
    _forceOptimizeOnRestart: false,
    _pendingRequests: new Map(),
    _fsDenyGlob: picomatch(
      // matchBase: true does not work as it's documented
      // https://github.com/micromatch/picomatch/issues/89
      // convert patterns without `/` on our side for now
      config.server.fs.deny.map((pattern) =>
        pattern.includes("/") ? pattern : `**/${pattern}`
      ),
      {
        matchBase: false,
        nocase: true,
        dot: true,
      }
    ),
    _shortcutsOptions: undefined,
  };

  //用于在服务器重启后维持与原始服务器实例 server 的一致性
  //即使在代理对象 reflexServer 上进行操作，
  //所有的属性访问和修改都会直接作用于原始的 server 实例
  const reflexServer = new Proxy(server, {
    get: (_, property: keyof ViteDevServer) => {
      //当通过 reflexServer 访问属性时，实际上是在访问 server 对象的相应属性。
      return server[property];
    },
    set: (_, property: keyof ViteDevServer, value: never) => {
      //当通过 reflexServer 设置属性时，会将值赋给 server 对象的相应属性，并返回 true 表示设置成功。
      server[property] = value;
      return true;
    },
  });

  //是在非中间件模式下，设置一个退出处理函数 exitProcess，
  //用来处理进程的终止信号（SIGTERM）和标准输入流结束事件（end）。
  if (!middlewareMode) {
    exitProcess = async () => {
      try {
        //关闭服务器
        await server.close();
      } finally {
        //终止当前 Node.js 进程
        process.exit();
      }
    };
    //注册对 SIGTERM 信号的处理
    //一旦接收到 SIGTERM 信号，就会执行 exitProcess 函数，关闭服务器并终止进程
    process.once("SIGTERM", exitProcess);
    if (process.env.CI !== "true") {
      //如果当前环境不是 CI 环境（即 process.env.CI !== "true"），
      //则使用 process.stdin.on("end", exitProcess) 注册对标准输入流结束事件的处理。
      //当标准输入流结束时，也会执行 exitProcess 函数，关闭服务器并终止进程。
      process.stdin.on("end", exitProcess);
    }
  }

  //用于处理模块热更新
  const onHMRUpdate = async (
    type: "create" | "delete" | "update",
    file: string //表示发生变更的文件路径或标识
  ) => {
    if (serverConfig.hmr !== false) {
      //检查是否在配置中禁用了 HMR
      //只有当 serverConfig.hmr 不等于 false 时才会继续执行后续操作。
      try {
        //处理具体的 HMR 更新操作
        await handleHMRUpdate(type, file, server);
      } catch (err) {
        //发送错误热更新广播器
        hot.send({
          type: "error",
          err: prepareError(err),
        });
      }
    }
  };

  /**
   * 主要用于监控文件的添加和删除事件，确保文件变更时能够及时通知相关的处理逻辑，
   * 如容器的变更监控、公共文件管理以及模块热更新等。
   * @param file
   * @param isUnlink
   */
  const onFileAddUnlink = async (file: string, isUnlink: boolean) => {
    //路径标准化
    file = normalizePath(file);
    //调用容器方法，watchChange 方法，告知文件变更事件的类型（删除或创建）。
    await container.watchChange(file, {
      event: isUnlink ? "delete" : "create",
    });

    //处理公共目录文件
    if (publicDir && publicFiles) {
      if (file.startsWith(publicDir)) {
        //如果 file 路径以 publicDir 开头，表示是公共目录中的文件
        const path = file.slice(publicDir.length);
        //根据 isUnlink 决定是删除还是添加文件到 publicFiles
        publicFiles[isUnlink ? "delete" : "add"](path);
        if (!isUnlink) {
          //如果是添加文件，检查是否存在具有相同路径的模块，并清除其在 moduleGraph.etagToModuleMap 中的记录
          //以确保下次请求优先使用公共文件而不是模块。
          const moduleWithSamePath = await moduleGraph.getModuleByUrl(path);
          const etag = moduleWithSamePath?.transformResult?.etag;
          if (etag) {
            //在下一次请求时，公共文件应该优于具有相同路径的模块。防止transform etag快速路径服务于模块
            moduleGraph.etagToModuleMap.delete(etag);
          }
        }
      }
    }

    //如果是文件删除操作，调用 moduleGraph 的 onFileDelete 方法处理文件删除。
    if (isUnlink) moduleGraph.onFileDelete(file);
    //触发模块热更新
    await onHMRUpdate(isUnlink ? "delete" : "create", file);
  };

  //监听文件变更事件 (change 事件)，并对文件的更新操作进行处理
  watcher.on("change", async (file) => {
    // 路径标准化
    file = normalizePath(file);
    //通知容器文件 file 发生了更新事件
    await container.watchChange(file, { event: "update" });

    //模块图缓存失效：
    //调用 moduleGraph 的 onFileChange 方法，使与文件相关的模块图缓存失效，以便后续重新加载或处理。
    moduleGraph.onFileChange(file);
    //调用 onHMRUpdate 函数，触发模块热更新事件，传入操作类型为
    await onHMRUpdate("update", file);
  });

  getFsUtils(config).initWatcher?.(watcher);

  //监听文件的添加
  watcher.on("add", (file) => {
    onFileAddUnlink(file, false);
  });
  //监听文件的删除
  watcher.on("unlink", (file) => {
    onFileAddUnlink(file, true);
  });

  // 监听了 hot 对象的 vite:invalidate 事件，Vite 中用于模块热更新（HMR）的事件
  // 该事件表示需要无效化某个模块，以便进行模块热更新
  hot.on("vite:invalidate", async ({ path, message }) => {
    // 从模块图中获取对应路径的模块对象
    const mod = moduleGraph.urlToModuleMap.get(path);
    if (
      mod && //模块存在
      mod.isSelfAccepting && // 模块可以接受自身更新
      mod.lastHMRTimestamp > 0 && // 存在上次的 HMR 时间戳
      !mod.lastHMRInvalidationReceived // 上次 HMR 无效化未接收
    ) {
      // 标记模块的上次 HMR 无效化已接收
      mod.lastHMRInvalidationReceived = true;

      // 记录日志信息
      config.logger.info(
        colors.yellow(`hmr invalidate `) +
          colors.dim(path) +
          (message ? ` ${message}` : ""),
        { timestamp: true }
      );

      // 获取模块文件的简短名称
      const file = getShortName(mod.file!, config.root);

      // 更新依赖该模块的模块
      // updateModules(
      //   file,
      //   [...mod.importers],
      //   mod.lastHMRTimestamp,
      //   server,
      //   true // 标记为模块的强制更新
      // );
    }
  });

  //确保在非中间件模式下（即独立运行模式）
  if (!middlewareMode && httpServer) {
    //当 HTTP 服务器开始监听时，更新服务器配置中的端口号。
    httpServer.once("listening", () => {
      serverConfig.port = (httpServer.address() as net.AddressInfo).port;
    });
  }

  // 应用插件的服务器配置钩子
  // 存储执行后的钩子结果。
  const postHooks: ((() => void) | void)[] = [];
  for (const hook of config.getSortedPluginHooks("configureServer")) {
    //钩子是按顺序排序的，确保它们按照预定的顺序执行
    //每个钩子都是一个异步函数，调用时将 reflexServer 传递给它
    //并将其执行结果（void 或 () => void）存储到 postHooks 数组中
    postHooks.push(await hook(reflexServer));
  }

  // Internal middlewares ------------------------------------------------------

  //定义了 Vite 开发服务器的一些内部中间件

  // 请求计时中间件
  if (process.env.DEBUG) {
    //仅当环境变量 DEBUG 设置时启用
    //使用 middlewares.use 方法，将 timeMiddleware 添加到中间件栈中。
    //timeMiddleware 接受 root 目录作为参数，
    //负责记录请求的开始时间和结束时间，从而计算请求处理所需的时间。
    // middlewares.use(timeMiddleware(root));
  }

  // 处理跨域资源共享（CORS），使服务器能够处理跨域请求。
  // 默认情况下启用，除非 serverConfig.cors 显式设置为 false。
  const { cors } = serverConfig;
  if (cors !== false) {
    middlewares.use(corsMiddleware(typeof cors === "boolean" ? {} : cors));
  }

  //缓存转换中间件，处理缓存的转换，以提高性能
  middlewares.use(cachedTransformMiddleware(server));

  // 配置代理
  const { proxy } = serverConfig;
  if (proxy) {
    // const middlewareServer =
    //   (isObject(middlewareMode) ? middlewareMode.server : null) || httpServer;
    // middlewares.use(proxyMiddleware(middlewareServer, proxy, config));
  }

  // 基础路径
  if (config.base !== "/") {
    // 只有在 config.base 不是默认值 / 时才会启用基础路径中间件
    // middlewares.use(baseMiddleware(config.rawBase, !!middlewareMode));
  }

  // 打开编辑器支持中间件
  /**
   * 当客户端向 "/__open-in-editor" 发送请求时，该中间件会处理请求，并启动配置好的编辑器以打开指定文件
   * 这个功能常用于在开发工具中点击某个文件路径时直接在编辑器中打开相应文件，提高开发效率
   */
  middlewares.use("/__open-in-editor", launchEditorMiddleware());

  //HMR Ping 请求处理中间件，以便在开发环境中保持连接的活跃性
  //保留命名函数。这个名字可以通过“debug =connect:dispatcher…”在调试日志中看到。
  middlewares.use(function viteHMRPingMiddleware(req, res, next) {
    if (req.headers["accept"] === "text/x-vite-ping") {
      //检查请求头中的 "accept"

      //返回 HTTP 状态码 204 No Content，表示成功但无内容。这确保了客户端与服务器的连接保持活跃
      res.writeHead(204).end();
    } else {
      //不是，调用 next() 将请求传递给下一个中间件
      next();
    }
  });

  // 在 /public 目录下提供静态文件服务
  // 这适用于转换中间件之前，这样这些文件就可以按原样提供而不需要转换。
  if (publicDir) {
    middlewares.use(servePublicMiddleware(server, publicFiles));
  }

  // 主要的文件转换中间件,这个中间件很重要，访问的文件都是通过这个中间件去做转换
  // 比如 /src/main.ts 中涉及到 import {createApp} from 'vue',就是通过这个中间件
  // 调用 transform 方法做转换，实际的转换发生再 importAnaysis 这个插件里面做的转换
  middlewares.use(transformMiddleware(server));

  // 提供静态文件服务
  middlewares.use(serveRawFsMiddleware(server));
  middlewares.use(serveStaticMiddleware(server));

  // html 回退，为单页应用（SPA）或多页应用（MPA）提供 HTML 回退功能
  if (config.appType === "spa" || config.appType === "mpa") {
    // 这一步的中间件关键，经过这个中间件处理后，后一个中间件 indexHtmlMiddleware 才能去处理根目录下面的index.html
    middlewares.use(
      htmlFallbackMiddleware(root, config.appType === "spa", getFsUtils(config))
    );
  }

  /**
   * 在 HTML 中间件之前运行用户定义的钩子函数，以便用户可以提供自定义内容而不是 index.html。
   */
  postHooks.forEach((fn) => fn && fn());

  //对于单页应用（SPA）或多页应用（MPA），提供 index.html 的转换和 404 错误处理。
  if (config.appType === "spa" || config.appType === "mpa") {
    // transform index.html
    middlewares.use(indexHtmlMiddleware(root, server));
    // handle 404s
    middlewares.use(notFoundMiddleware());
  }

  // 处理服务器中的一般错误，该中间件可以在请求处理过程中捕获到的任何错误，并进行适当的处理和记录
  middlewares.use(errorMiddleware(server, !!middlewareMode));

  // httpServer.listen can be called multiple times
  // when port when using next port number
  // this code is to avoid calling buildStart multiple times
  /**
   * 为什么需要 initServer 函数？
   * 1. 在某些情况下，httpServer.listen 可能会被多次调用。
   *    比如在尝试不同端口号启动服务器时，可能会尝试多个端口，直到找到一个可用的端口。
   * 2. 当使用下一个端口号时，可能会多次调用 httpServer.listen。
   *    例如，如果默认端口被占用，服务器会尝试使用下一个可用的端口
   * 3. 这段代码的目的是为了避免多次调用 buildStart 方法。
   *    buildStart 方法可能涉及到耗时的初始化过程，如果多次调用会导致性能问题或其他不可预见的问题。
   */

  //用于存储初始化过程的 Promise，以确保同一时间只有一个初始化过程在进行
  let initingServer: Promise<void> | undefined;
  let serverInited = false; //用于标记服务器是否已经初始化完成

  /**
   * 用于初始化服务器。
   * 目的是为了确保在服务器启动时，一些关键的初始化步骤只执行一次，
   * 即使 httpServer.listen 被多次调用。这是为了避免重复执行 buildStart 以及其他初始化逻辑
   *
   * @returns
   */
  const initServer = async () => {
    //检查服务器是否已经初始化
    if (serverInited) return;
    //检查是否有正在进行的初始化过程
    if (initingServer) return initingServer;

    //开始初始化过程
    initingServer = (async function () {
      // 调用 buildStart 钩子函数，开始构建过程
      await container.buildStart({});
      // 在所有容器插件准备好后启动深度优化器
      if (isDepsOptimizerEnabled(config, false)) {
        //如果启用了依赖优化器，则初始化依赖优化器
        /** 这里开始的依赖预构建 */
        await initDepsOptimizer(config, server);
      }

      //调用 warmupFiles 函数，对一些文件进行预热，以提高性能
      warmupFiles(server);

      //初始化完成后，重置 initingServer 以允许将来的重新初始化
      initingServer = undefined;
      //设置 serverInited 为 true，表示服务器已经初始化完成
      serverInited = true;
    })();
    return initingServer;
  };

  //下面代码的主要目的是在启动 HTTP 服务器前确保初始化某些必要的组件或优化器。
  //它覆盖了 httpServer.listen 方法，在实际启动服务器之前执行一些初始化操作
  if (!middlewareMode && httpServer) {
    // 确保不是中间件模式且存在 httpServer 实例。
    // 将原始的 httpServer.listen 方法绑定到 listen 变量上，以便稍后调用。
    const listen = httpServer.listen.bind(httpServer);

    // 覆盖 httpServer.listen 方法，在实际调用原始 listen 方法之前，先执行一些初始化操作。
    httpServer.listen = (async (port: number, ...args: any[]) => {
      try {
        //确保 WebSocket 服务器启动
        hot.listen();
        //initServer 确保某些组件或优化器在服务器启动前已经初始化
        await initServer();
      } catch (e) {
        //捕获错误并发出 error 事件
        httpServer.emit("error", e);
        return;
      }
      //调用原始的 listen 方法：
      return listen(port, ...args);
    }) as any;
  } else {
    //处理中间件模式或没有 httpServer 的清空
    if (options.hotListen) {
      //options.hotListen 为 true，则启动 WebSocket 服务器
      hot.listen();
    }
    //调用 initServer 进行初始化
    await initServer();
  }

  return server;
}

/**
 * 于启动 Vite 开发服务器。
 * 它接收一个 ViteDevServer 实例和一个可选的端口号 inlinePort，并在特定条件下启动 HTTP 服务器
 *
 * @param server
 * @param inlinePort
 */
async function startServer(
  server: ViteDevServer,
  inlinePort?: number
): Promise<void> {
  const httpServer = server.httpServer;
  if (!httpServer) {
    //不能在中间件模式下调用 server.listen。
    throw new Error("Cannot call server.listen in middleware mode.");
  }

  //获取服务器配置选项。
  const options = server.config.server;
  //解析主机名
  const hostname = await resolveHostname(options.host);
  //确定端口，优先使用 inlinePort，否则使用配置中的端口
  const configPort = inlinePort ?? options.port;

  /**
   * 1. 非严格端口模式：在开发服务器的配置中，可以选择是否启用严格端口模式。
   *    非严格端口模式下，开发服务器可以使用操作系统提供的可用端口，而不仅限于配置中指定的端口。
   * 2. 端口可能不一致：在重新启动服务器时，如果之前使用的端口仍然可用，开发服务器可能会选择重新使用该端口。
   *    这种情况下，服务器当前运行的端口可能会与配置中指定的端口不同。
   * 3. 避免浏览器标签页切换：为了避免正在运行的浏览器标签页因为端口变化而刷新或重新加载，
   *    开发服务器会尽量保持之前使用的端口不变，除非配置中显式地更改了端口设置。
   *
   * 这样的设计能够确保开发过程中，开发服务器的端口变化对开发者在浏览器中打开的标签页造成的干扰最小化，
   * 提升开发体验的连续性和稳定性
   */

  //如果配置的端口为空或者等于服务器配置的端口，使用当前服务器端口
  //否则使用 configPort，如果都没有，则使用默认端口 DEFAULT_DEV_PORT
  const port =
    (!configPort || configPort === server._configServerPort
      ? server._currentServerPort
      : configPort) ?? DEFAULT_DEV_PORT;

  // 更新服务器的配置端口
  server._configServerPort = configPort;

  // 启动 HTTP 服务器
  const serverPort = await httpServerStart(httpServer, {
    port,
    strictPort: options.strictPort,
    host: hostname.host,
    logger: server.config.logger,
  });
  // 更新服务器当前端口
  server._currentServerPort = serverPort;
}

//重新启动 Vite 开发服务器的逻辑
async function restartServer(server: ViteDevServer) {
  //全局计时器重置，用于记录重新启动服务器的时间戳，以便后续性能分析或日志记录
  global.__vite_start_time = performance.now();
  const shortcutsOptions = server._shortcutsOptions;

  let inlineConfig = server.config.inlineConfig;

  //在重新启动时设置了 _forceOptimizeOnRestart 标志
  if (server._forceOptimizeOnRestart) {
    //会将 inlineConfig 中的 optimizeDeps 配置项强制设置为 force: true，以便强制重新优化依赖。
    inlineConfig = mergeConfig(inlineConfig, {
      optimizeDeps: {
        force: true,
      },
    });
  }

  // Reinit the server by creating a new instance using the same inlineConfig
  // This will triger a reload of the config file and re-create the plugins and
  // middlewares. We then assign all properties of the new server to the existing
  // server instance and set the user instance to be used in the new server.
  // This allows us to keep the same server instance for the user.
  {
    //创建新服务器实例
    let newServer = null;
    try {
      //使用新的配置 inlineConfig 创建一个新的 Vite 服务器实例
      newServer = await _createServer(inlineConfig, { hotListen: false });
    } catch (err: any) {
      //如果创建过程中出现错误，会捕获并记录错误信息，然后退出函数。
      server.config.logger.error(err.message, {
        timestamp: true,
      });
      server.config.logger.error("server restart failed", { timestamp: true });
      return;
    }

    //关闭旧服务器实例
    await server.close();

    //更新服务器实例属性
    const middlewares = server.middlewares;
    newServer._configServerPort = server._configServerPort;
    newServer._currentServerPort = server._currentServerPort;

    //将新创建的服务器实例 newServer 的属性复制到旧的服务器实例 server 中，保持用户引用的一致性。
    Object.assign(server, newServer);

    //重新绑定中间件，新服务器实例的中间件栈复制回旧服务器实例，以保持现有的中间件配置
    //保持相同的连接实例，以便app.use(vite.middleware)在middlewareMode (. middleware)重启后工作。路由总是'/')
    middlewares.stack = newServer.middlewares.stack;
    server.middlewares = middlewares;

    //将新服务器实例的内部服务器变量绑定回旧服务器实例，以确保所有函数引用正确的用户服务器。
    newServer._setInternalServer(server);
  }

  const {
    logger,
    server: { port, middlewareMode },
  } = server.config;

  if (!middlewareMode) {
    //如果不是中间件模式，重新启动服务器并监听指定的端口 port；
    await server.listen(port, true);
  } else {
    //如果是中间件模式，则重新启动热更新服务器。
    server.hot.listen();
  }

  //记录服务器重新启动的信息日志
  logger.info("server restarted.", { timestamp: true });

  //重新绑定 CLI 快捷方式选项
  if (shortcutsOptions) {
    //如果存在 CLI 快捷方式选项，则禁用打印，并重新绑定服务器的 CLI 快捷方式。
    shortcutsOptions.print = false;
    // bindCLIShortcuts(server, shortcutsOptions);
  }

  //这段代码通过创建新的服务器实例并在关闭旧实例后进行属性复制，实现了服务器的平滑重启过程，
  //以确保在开发过程中，服务器重新启动时不中断现有的开发流程和连接
}

//用于创建关闭服务器的函数
export function createServerCloseFn(
  server: HttpServer | null
): () => Promise<void> {
  if (!server) {
    //如果传入的 server 是 null，则返回一个立即 resolved 的 Promise，什么都不做。
    return () => Promise.resolve();
  }

  let hasListened = false;
  //用于存储当前打开的 net.Socket 连接
  const openSockets = new Set<net.Socket>();

  server.on("connection", (socket) => {
    //当服务器接收到新的连接时，将其添加到 openSockets 中，
    //并监听连接的关闭事件，在连接关闭时从集合中删除该 socket
    openSockets.add(socket);
    socket.on("close", () => {
      openSockets.delete(socket);
    });
  });

  //当服务器首次开始侦听时，设置 hasListened 标志为 true。
  server.once("listening", () => {
    hasListened = true;
  });

  //返回关闭服务器的函数
  return () =>
    new Promise<void>((resolve, reject) => {
      openSockets.forEach((s) => s.destroy());
      if (hasListened) {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
}

//定义了在请求空闲一段时间后调用 callOnCrawlEnd 的超时时间，单位为毫秒。
const callCrawlEndIfIdleAfterMs = 50;

interface CrawlEndFinder {
  // 注册请求处理函数，接受一个唯一的 id 和一个处理完成的异步函数 done
  registerRequestProcessing: (id: string, done: () => Promise<any>) => void;
  //等待所有请求处理完成的方法，ignoredId 用于忽略某个请求的完成
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>;
  //取消等待请求处理完成的操作
  cancel: () => void;
}

//要用于管理请求处理的状态，并在所有请求处理完成时执行特定的回调函数 onCrawlEnd
//接受一个 onCrawlEnd 回调函数作为参数，该函数将在所有请求处理完成后执行。
function setupOnCrawlEnd(onCrawlEnd: () => void): CrawlEndFinder {
  //存储已注册的请求处理标识符集合
  const registeredIds = new Set<string>();
  // 存储已观察到的请求处理标识符集合
  const seenIds = new Set<string>();
  //使用一个带有解析器的 Promise，用于等待请求处理完成。
  const onCrawlEndPromiseWithResolvers = promiseWithResolvers<void>();

  //超时处理器，用于延迟调用 callOnCrawlEndWhenIdle
  let timeoutHandle: NodeJS.Timeout | undefined;
  //标记是否取消了等待请求处理完成的操作。
  let cancelled = false;
  //用于取消等待请求处理完成的操作
  function cancel() {
    cancelled = true;
  }

  let crawlEndCalled = false;
  function callOnCrawlEnd() {
    if (!cancelled && !crawlEndCalled) {
      //检查是否取消了操作，并且 crawlEndCalled 是否已经为 false
      crawlEndCalled = true;
      onCrawlEnd();
    }
    //完成对 Promise 的解析
    onCrawlEndPromiseWithResolvers.resolve();
  }

  //注册请求处理函数
  function registerRequestProcessing(
    id: string,
    done: () => Promise<any>
  ): void {
    if (!seenIds.has(id)) {
      //如果 id 尚未被观察到（即不在 seenIds 中）
      //则将其添加到 seenIds 和 registeredIds 中，并执行 done 函数。
      seenIds.add(id);
      registeredIds.add(id);
      done()
        .catch(() => {})
        .finally(() => markIdAsDone(id));
    }
  }

  //等待所有请求处理完成函数
  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    if (ignoredId) {
      //如果提供了 ignoredId，则将其添加到 seenIds 中，并调用 markIdAsDone。
      seenIds.add(ignoredId);
      markIdAsDone(ignoredId);
    }
    //等待请求处理完成后的 Promise。
    return onCrawlEndPromiseWithResolvers.promise;
  }

  //标记请求处理完成函数
  function markIdAsDone(id: string): void {
    if (registeredIds.has(id)) {
      //如果 registeredIds 中包含 id，则从 registeredIds 中删除，
      //并调用 checkIfCrawlEndAfterTimeout 检查是否需要在空闲时调用 onCrawlEnd
      registeredIds.delete(id);
      checkIfCrawlEndAfterTimeout();
    }
  }

  //用于检查是否在请求处理空闲一段时间后调用 onCrawlEnd
  function checkIfCrawlEndAfterTimeout() {
    //如果已取消操作或者 registeredIds 集合中仍有未处理的请求，直接返回
    if (cancelled || registeredIds.size > 0) return;

    //如果存在 timeoutHandle，则清除现有的超时处理器。
    if (timeoutHandle) clearTimeout(timeoutHandle);

    //设置新的超时处理器，调用 callOnCrawlEndWhenIdle 函数，
    //在指定的 callCrawlEndIfIdleAfterMs 毫秒后调用 onCrawlEnd。
    timeoutHandle = setTimeout(
      callOnCrawlEndWhenIdle,
      callCrawlEndIfIdleAfterMs
    );
  }
  async function callOnCrawlEndWhenIdle() {
    if (cancelled || registeredIds.size > 0) return;
    callOnCrawlEnd();
  }

  return {
    registerRequestProcessing,
    waitForRequestsIdle,
    cancel,
  };
}

export function resolveServerOptions(
  root: string,
  raw: ServerOptions | undefined,
  logger: Logger
): ResolvedServerOptions {
  const server: ResolvedServerOptions = {
    preTransformRequests: true,
    ...(raw as Omit<ResolvedServerOptions, "sourcemapIgnoreList">),
    sourcemapIgnoreList:
      raw?.sourcemapIgnoreList === false
        ? () => false
        : raw?.sourcemapIgnoreList || isInNodeModules,
    middlewareMode: raw?.middlewareMode || false,
  };
  let allowDirs = server.fs?.allow;
  const deny = server.fs?.deny || [".env", ".env.*", "*.{crt,pem}"];

  if (!allowDirs) {
    allowDirs = [searchForWorkspaceRoot(root)];
  }

  if (process.versions.pnp) {
    try {
      const enableGlobalCache =
        execSync("yarn config get enableGlobalCache", { cwd: root })
          .toString()
          .trim() === "true";
      const yarnCacheDir = execSync(
        `yarn config get ${enableGlobalCache ? "globalFolder" : "cacheFolder"}`,
        { cwd: root }
      )
        .toString()
        .trim();
      allowDirs.push(yarnCacheDir);
    } catch (e) {
      logger.warn(`Get yarn cache dir error: ${e.message}`, {
        timestamp: true,
      });
    }
  }

  allowDirs = allowDirs.map((i) => resolvedAllowDir(root, i));

  // only push client dir when vite itself is outside-of-root
  const resolvedClientDir = resolvedAllowDir(root, CLIENT_DIR);
  if (!allowDirs.some((dir) => isParentDirectory(dir, resolvedClientDir))) {
    allowDirs.push(resolvedClientDir);
  }

  server.fs = {
    strict: server.fs?.strict ?? true,
    allow: allowDirs,
    deny,
    cachedChecks: server.fs?.cachedChecks,
  };

  if (server.origin?.endsWith("/")) {
    server.origin = server.origin.slice(0, -1);
    logger.warn(
      colors.yellow(
        `${colors.bold("(!)")} server.origin should not end with "/". Using "${
          server.origin
        }" instead.`
      )
    );
  }

  return server;
}

function resolvedAllowDir(root: string, dir: string): string {
  return normalizePath(path.resolve(root, dir));
}

/**
 * 用于重新启动 Vite 开发服务器，并在某些条件下打印新的服务器 URL
 * @param server
 * @returns
 */
export async function restartServerWithUrls(
  server: ViteDevServer
): Promise<void> {
  if (server.config.server.middlewareMode) {
    // 如果是中间件模式，直接重启服务器并返回
    await server.restart();
    return;
  }

  // 保存重启前的端口、主机、已解析的url，以便在重启后比较
  const { port: prevPort, host: prevHost } = server.config.server;
  const prevUrls = server.resolvedUrls;

  await server.restart();

  // 获取重启后的配置
  const {
    logger,
    server: { port, host },
  } = server.config;

  // 端口是否发生变化、主机是否发生变化、解析的 URL 顺序是否发生变化
  if (
    (port ?? DEFAULT_DEV_PORT) !== (prevPort ?? DEFAULT_DEV_PORT) ||
    host !== prevHost ||
    diffDnsOrderChange(prevUrls, server.resolvedUrls)
  ) {
    // 如果任一条件满足，则打印新的服务器 URL
    logger.info("");
    server.printUrls();
  }
}
