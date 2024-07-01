import path from "node:path";
import type { Http2SecureServer } from "node:http2";
import type * as net from "node:net";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import type * as http from "node:http";

import connect from "connect";
import chokidar from "chokidar";
import type { SourceMap } from "rollup";
import picomatch from "picomatch";
import type { Matcher } from "picomatch";
import type { Connect } from "dep-types/connect";
import type { FSWatcher, WatchOptions } from "dep-types/chokidar";

import { createWebSocketServer } from "./ws";
import { getEnvFilesForMode } from "../env";

import { isDepsOptimizerEnabled, resolveConfig } from "../config";
import type { InlineConfig, ResolvedConfig } from "../config";

import {
  createHMRBroadcaster,
  createServerHMRChannel,
  getShortName,
  handleHMRUpdate,
  updateModules,
} from "./hmr";

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
import { ssrTransform } from "../ssr/ssrTransform";
import { ssrLoadModule } from "../ssr/ssrModuleLoader";
import { ssrFetchModule } from "../ssr/ssrFetchModule";
import { ssrFixStacktrace, ssrRewriteStacktrace } from "../ssr/ssrStacktrace";

import { transformRequest } from "./transformRequest";
import { ERR_OUTDATED_OPTIMIZED_DEP } from "../plugins/optimizedDeps";
import { openBrowser as _openBrowser } from "./openBrowser";
import { getDepsOptimizer, initDepsOptimizer } from "../optimizer";
import { printServerUrls } from "../logger";
import { bindCLIShortcuts } from "../shortcuts";
import type { BindCLIShortcutsOptions } from "../shortcuts";

export type HttpServer = http.Server | Http2SecureServer;

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
                  //允许服务器使用历史中间件重定向到 /index.html。
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

  // maintain consistency with the server instance after restarting.
  const reflexServer = new Proxy(server, {
    get: (_, property: keyof ViteDevServer) => {
      return server[property];
    },
    set: (_, property: keyof ViteDevServer, value: never) => {
      server[property] = value;
      return true;
    },
  });

  if (!middlewareMode) {
    exitProcess = async () => {
      try {
        await server.close();
      } finally {
        process.exit();
      }
    };
    process.once("SIGTERM", exitProcess);
    if (process.env.CI !== "true") {
      process.stdin.on("end", exitProcess);
    }
  }

  const onHMRUpdate = async (
    type: "create" | "delete" | "update",
    file: string
  ) => {
    if (serverConfig.hmr !== false) {
      try {
        await handleHMRUpdate(type, file, server);
      } catch (err) {
        hot.send({
          type: "error",
          err: prepareError(err),
        });
      }
    }
  };

  const onFileAddUnlink = async (file: string, isUnlink: boolean) => {
    file = normalizePath(file);
    await container.watchChange(file, {
      event: isUnlink ? "delete" : "create",
    });

    if (publicDir && publicFiles) {
      if (file.startsWith(publicDir)) {
        const path = file.slice(publicDir.length);
        publicFiles[isUnlink ? "delete" : "add"](path);
        if (!isUnlink) {
          const moduleWithSamePath = await moduleGraph.getModuleByUrl(path);
          const etag = moduleWithSamePath?.transformResult?.etag;
          if (etag) {
            // The public file should win on the next request over a module with the
            // same path. Prevent the transform etag fast path from serving the module
            moduleGraph.etagToModuleMap.delete(etag);
          }
        }
      }
    }
    if (isUnlink) moduleGraph.onFileDelete(file);
    await onHMRUpdate(isUnlink ? "delete" : "create", file);
  };

  watcher.on("change", async (file) => {
    file = normalizePath(file);
    await container.watchChange(file, { event: "update" });
    // invalidate module graph cache on file change
    moduleGraph.onFileChange(file);
    await onHMRUpdate("update", file);
  });

  getFsUtils(config).initWatcher?.(watcher);

  watcher.on("add", (file) => {
    onFileAddUnlink(file, false);
  });
  watcher.on("unlink", (file) => {
    onFileAddUnlink(file, true);
  });

  hot.on("vite:invalidate", async ({ path, message }) => {
    const mod = moduleGraph.urlToModuleMap.get(path);
    if (
      mod &&
      mod.isSelfAccepting &&
      mod.lastHMRTimestamp > 0 &&
      !mod.lastHMRInvalidationReceived
    ) {
      mod.lastHMRInvalidationReceived = true;
      config.logger.info(
        colors.yellow(`hmr invalidate `) +
          colors.dim(path) +
          (message ? ` ${message}` : ""),
        { timestamp: true }
      );
      const file = getShortName(mod.file!, config.root);
      updateModules(
        file,
        [...mod.importers],
        mod.lastHMRTimestamp,
        server,
        true
      );
    }
  });

  if (!middlewareMode && httpServer) {
    httpServer.once("listening", () => {
      // update actual port since this may be different from initial value
      serverConfig.port = (httpServer.address() as net.AddressInfo).port;
    });
  }

  // apply server configuration hooks from plugins
  const postHooks: ((() => void) | void)[] = [];
  for (const hook of config.getSortedPluginHooks("configureServer")) {
    postHooks.push(await hook(reflexServer));
  }

  // Internal middlewares ------------------------------------------------------

  // request timer
  if (process.env.DEBUG) {
    middlewares.use(timeMiddleware(root));
  }

  // cors (enabled by default)
  const { cors } = serverConfig;
  if (cors !== false) {
    middlewares.use(corsMiddleware(typeof cors === "boolean" ? {} : cors));
  }

  middlewares.use(cachedTransformMiddleware(server));

  // proxy
  const { proxy } = serverConfig;
  if (proxy) {
    const middlewareServer =
      (isObject(middlewareMode) ? middlewareMode.server : null) || httpServer;
    middlewares.use(proxyMiddleware(middlewareServer, proxy, config));
  }

  // base
  if (config.base !== "/") {
    middlewares.use(baseMiddleware(config.rawBase, !!middlewareMode));
  }

  // open in editor support
  middlewares.use("/__open-in-editor", launchEditorMiddleware());

  // ping request handler
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  middlewares.use(function viteHMRPingMiddleware(req, res, next) {
    if (req.headers["accept"] === "text/x-vite-ping") {
      res.writeHead(204).end();
    } else {
      next();
    }
  });

  // serve static files under /public
  // this applies before the transform middleware so that these files are served
  // as-is without transforms.
  if (publicDir) {
    middlewares.use(servePublicMiddleware(server, publicFiles));
  }

  // main transform middleware
  middlewares.use(transformMiddleware(server));

  // serve static files
  middlewares.use(serveRawFsMiddleware(server));
  middlewares.use(serveStaticMiddleware(server));

  // html fallback
  if (config.appType === "spa" || config.appType === "mpa") {
    middlewares.use(
      htmlFallbackMiddleware(root, config.appType === "spa", getFsUtils(config))
    );
  }

  // run post config hooks
  // This is applied before the html middleware so that user middleware can
  // serve custom content instead of index.html.
  postHooks.forEach((fn) => fn && fn());

  if (config.appType === "spa" || config.appType === "mpa") {
    // transform index.html
    middlewares.use(indexHtmlMiddleware(root, server));

    // handle 404s
    middlewares.use(notFoundMiddleware());
  }

  // error handler
  middlewares.use(errorMiddleware(server, !!middlewareMode));

  // httpServer.listen can be called multiple times
  // when port when using next port number
  // this code is to avoid calling buildStart multiple times
  let initingServer: Promise<void> | undefined;
  let serverInited = false;
  const initServer = async () => {
    if (serverInited) return;
    if (initingServer) return initingServer;

    initingServer = (async function () {
      await container.buildStart({});
      // start deps optimizer after all container plugins are ready
      if (isDepsOptimizerEnabled(config, false)) {
        await initDepsOptimizer(config, server);
      }
      warmupFiles(server);
      initingServer = undefined;
      serverInited = true;
    })();
    return initingServer;
  };

  if (!middlewareMode && httpServer) {
    // overwrite listen to init optimizer before server start
    const listen = httpServer.listen.bind(httpServer);
    httpServer.listen = (async (port: number, ...args: any[]) => {
      try {
        // ensure ws server started
        hot.listen();
        await initServer();
      } catch (e) {
        httpServer.emit("error", e);
        return;
      }
      return listen(port, ...args);
    }) as any;
  } else {
    if (options.hotListen) {
      hot.listen();
    }
    await initServer();
  }

  return server;
}

async function startServer(
  server: ViteDevServer,
  inlinePort?: number
): Promise<void> {
  const httpServer = server.httpServer;
  if (!httpServer) {
    throw new Error("Cannot call server.listen in middleware mode.");
  }

  const options = server.config.server;
  const hostname = await resolveHostname(options.host);
  const configPort = inlinePort ?? options.port;
  // When using non strict port for the dev server, the running port can be different from the config one.
  // When restarting, the original port may be available but to avoid a switch of URL for the running
  // browser tabs, we enforce the previously used port, expect if the config port changed.
  const port =
    (!configPort || configPort === server._configServerPort
      ? server._currentServerPort
      : configPort) ?? DEFAULT_DEV_PORT;
  server._configServerPort = configPort;

  const serverPort = await httpServerStart(httpServer, {
    port,
    strictPort: options.strictPort,
    host: hostname.host,
    logger: server.config.logger,
  });
  server._currentServerPort = serverPort;
}

async function restartServer(server: ViteDevServer) {
  global.__vite_start_time = performance.now();
  const shortcutsOptions = server._shortcutsOptions;

  let inlineConfig = server.config.inlineConfig;
  if (server._forceOptimizeOnRestart) {
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
    let newServer = null;
    try {
      // delay ws server listen
      newServer = await _createServer(inlineConfig, { hotListen: false });
    } catch (err: any) {
      server.config.logger.error(err.message, {
        timestamp: true,
      });
      server.config.logger.error("server restart failed", { timestamp: true });
      return;
    }

    await server.close();

    // Assign new server props to existing server instance
    const middlewares = server.middlewares;
    newServer._configServerPort = server._configServerPort;
    newServer._currentServerPort = server._currentServerPort;
    Object.assign(server, newServer);

    // Keep the same connect instance so app.use(vite.middlewares) works
    // after a restart in middlewareMode (.route is always '/')
    middlewares.stack = newServer.middlewares.stack;
    server.middlewares = middlewares;

    // Rebind internal server variable so functions reference the user server
    newServer._setInternalServer(server);
  }

  const {
    logger,
    server: { port, middlewareMode },
  } = server.config;
  if (!middlewareMode) {
    await server.listen(port, true);
  } else {
    server.hot.listen();
  }
  logger.info("server restarted.", { timestamp: true });

  if (shortcutsOptions) {
    shortcutsOptions.print = false;
    bindCLIShortcuts(server, shortcutsOptions);
  }
}

export function createServerCloseFn(
  server: HttpServer | null
): () => Promise<void> {
  if (!server) {
    return () => Promise.resolve();
  }

  let hasListened = false;
  const openSockets = new Set<net.Socket>();

  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => {
      openSockets.delete(socket);
    });
  });

  server.once("listening", () => {
    hasListened = true;
  });

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

function setupOnCrawlEnd(onCrawlEnd: () => void): CrawlEndFinder {
  const registeredIds = new Set<string>();
  const seenIds = new Set<string>();
  const onCrawlEndPromiseWithResolvers = promiseWithResolvers<void>();

  let timeoutHandle: NodeJS.Timeout | undefined;

  let cancelled = false;
  function cancel() {
    cancelled = true;
  }

  let crawlEndCalled = false;
  function callOnCrawlEnd() {
    if (!cancelled && !crawlEndCalled) {
      crawlEndCalled = true;
      onCrawlEnd();
    }
    onCrawlEndPromiseWithResolvers.resolve();
  }

  function registerRequestProcessing(
    id: string,
    done: () => Promise<any>
  ): void {
    if (!seenIds.has(id)) {
      seenIds.add(id);
      registeredIds.add(id);
      done()
        .catch(() => {})
        .finally(() => markIdAsDone(id));
    }
  }

  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    if (ignoredId) {
      seenIds.add(ignoredId);
      markIdAsDone(ignoredId);
    }
    return onCrawlEndPromiseWithResolvers.promise;
  }

  function markIdAsDone(id: string): void {
    if (registeredIds.has(id)) {
      registeredIds.delete(id);
      checkIfCrawlEndAfterTimeout();
    }
  }

  function checkIfCrawlEndAfterTimeout() {
    if (cancelled || registeredIds.size > 0) return;

    if (timeoutHandle) clearTimeout(timeoutHandle);
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
