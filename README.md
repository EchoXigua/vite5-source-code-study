## 已经完成的功能

- [x] 解析 vite.config 文件

- [x] 解析 env 文件

- [x] 静态服务配置

- [x] 依赖预构建

- [x] 预热请求

- [ ] 热更新

  

## debug 调试

项目中有 launch.json 文件，可供调试使用，目前需要在 vite 目录下执行 npm run dev 获取打包后文件，再开始 vscode 的 debug



## 源码系列文章

+ [小白也能读懂的vite源码系列——vite 开发启动流程（一）](https://juejin.cn/post/7396463744187711497)
+ [小白也能读懂的vite源码系列——vite 中间件处理（二）](https://juejin.cn/post/7396921720722325541)



## vite 开发环境启动流程

今天我们来看一下 vite 在开发环境下是如何启动一个服务器的，并且在启动服务器这期间都做了哪些事情，为什么 vite 会这么快，让我们深入源码，揭开它的面纱。

### npm run dev

梦开始的地方，在 package.json 文件中，这是我们最熟悉的命令了，执行完 npm run dev 后，会启动一个服务器，并且自动打开浏览器（配置 open），然后就能显现出页面内容，那么这一切都是如何进行的呢？

```json
"scripts": {
	"dev": "vite"
},
```



​	在实际的项目开发中，dev 这个命令一般都会拼接很多参数，这些处理大部分都是给 vite 传递参数（行内参数），同时我们更多的是通过 vite.config.ts(.js) 这个文件，来配置 vite 的。后续我们会讲解这一块，先继续往后看，最重要的核心就是执行了 vite 这个命令



我们来看看 vite 这个命令里面做了什么

在 bin/vite.js 这个文件中

```javascript
#!/usr/bin/env node
import { performance } from 'node:perf_hooks'

if (!import.meta.url.includes('node_modules')) {
  try {
    // only available as dev dependency
    await import('source-map-support').then((r) => r.default.install())
  } catch (e) {}
}

global.__vite_start_time = performance.now()

// check debug mode first before requiring the CLI.
const debugIndex = process.argv.findIndex((arg) => /^(?:-d|--debug)$/.test(arg))
const filterIndex = process.argv.findIndex((arg) =>
  /^(?:-f|--filter)$/.test(arg),
)
const profileIndex = process.argv.indexOf('--profile')

if (debugIndex > 0) {
  let value = process.argv[debugIndex + 1]
  if (!value || value.startsWith('-')) {
    value = 'vite:*'
  } else {
    // support debugging multiple flags with comma-separated list
    value = value
      .split(',')
      .map((v) => `vite:${v}`)
      .join(',')
  }
  process.env.DEBUG = `${
    process.env.DEBUG ? process.env.DEBUG + ',' : ''
  }${value}`

  if (filterIndex > 0) {
    const filter = process.argv[filterIndex + 1]
    if (filter && !filter.startsWith('-')) {
      process.env.VITE_DEBUG_FILTER = filter
    }
  }
}

function start() {
  return import('../dist/node/cli.js')
}

if (profileIndex > 0) {
  process.argv.splice(profileIndex, 1)
  const next = process.argv[profileIndex]
  if (next && !next.startsWith('-')) {
    process.argv.splice(profileIndex, 1)
  }
  const inspector = await import('node:inspector').then((r) => r.default)
  const session = (global.__vite_profile_session = new inspector.Session())
  session.connect()
  session.post('Profiler.enable', () => {
    session.post('Profiler.start', start
  })
} else {
  start()
}
```





我们最主要的就是看 start 这个函数，我们主要研究主流程，细枝末节的，感兴趣的可以去了解下。

```js
function start() {
	return import('../dist/node/cli.js')
}
```



这里使用的打包后的 cli 文件，源码位置/packages/vite/src/node/cli.ts

这一块是配置一些配置项，重点放在下面的 dev 执行的

```js
cli
  .option('-c, --config <file>', `[string] use specified config file`)
  .option('--base <path>', `[string] public base path (default: /)`, {
    type: [convertBase],
  })
  .option('-l, --logLevel <level>', `[string] info | warn | error | silent`)
  .option('--clearScreen', `[boolean] allow/disable clear screen when logging`)
  .option('-d, --debug [feat]', `[string | boolean] show debug logs`)
  .option('-f, --filter <filter>', `[string] filter debug logs`)
  .option('-m, --mode <mode>', `[string] set env mode`)
```





npm run dev 执行的就是 vite，也就是这里执行的 dev 下面的 action 里面的方法

```js
// dev
cli
  .command('[root]', 'start dev server') // default command
  .alias('serve') // the command is called 'serve' in Vite's API
  .alias('dev') // alias to align with the script name
  .option('--host [host]', `[string] specify hostname`, { type: [convertHost] })
  .option('--port <port>', `[number] specify port`)
  .option('--open [path]', `[boolean | string] open browser on startup`)
  .option('--cors', `[boolean] enable CORS`)
  .option('--strictPort', `[boolean] exit if specified port is already in use`)
  .option(
    '--force',
    `[boolean] force the optimizer to ignore the cache and re-bundle`,
  )
  .action(async (root: string, options: ServerOptions & GlobalCLIOptions) => {
    filterDuplicateOptions(options)

    // output structure is preserved even after bundling so require()
    // is ok here
    const { createServer } = await import('./server')
    try {
      const server = await createServer({
        root,
        base: options.base,
        mode: options.mode,
        configFile: options.config,
        logLevel: options.logLevel,
        clearScreen: options.clearScreen,
        optimizeDeps: { force: options.force },
        server: cleanOptions(options),
      })

      if (!server.httpServer) {
        throw new Error('HTTP server not available')
      }

      await server.listen()

      const info = server.config.logger.info

      const viteStartTime = global.__vite_start_time ?? false
      const startupDurationString = viteStartTime
        ? colors.dim(
            `ready in ${colors.reset(
              colors.bold(Math.ceil(performance.now() - viteStartTime)),
            )} ms`,
          )
        : ''
      const hasExistingLogs =
        process.stdout.bytesWritten > 0 || process.stderr.bytesWritten > 0

      info(
        `\n  ${colors.green(
          `${colors.bold('VITE')} v${VERSION}`,
        )}  ${startupDurationString}\n`,
        {
          clear: !hasExistingLogs,
        },
      )

      server.printUrls()
      const customShortcuts: CLIShortcut<typeof server>[] = []
      if (profileSession) {
        customShortcuts.push({
          key: 'p',
          description: 'start/stop the profiler',
          async action(server) {
            if (profileSession) {
              await stopProfiler(server.config.logger.info)
            } else {
              const inspector = await import('node:inspector').then(
                (r) => r.default,
              )
              await new Promise<void>((res) => {
                profileSession = new inspector.Session()
                profileSession.connect()
                profileSession.post('Profiler.enable', () => {
                  profileSession!.post('Profiler.start', () => {
                    server.config.logger.info('Profiler started')
                    res()
                  })
                })
              })
            }
          },
        })
      }
      server.bindCLIShortcuts({ print: true, customShortcuts })
    } catch (e) {
      const logger = createLogger(options.logLevel)
      logger.error(colors.red(`error when starting dev server:\n${e.stack}`), {
        error: e,
      })
      stopProfiler(logger.info)
      process.exit(1)
    }
  })
```



### 执行 cli
dev 模式下主要执行的就是下面两个步骤

1. createServer
2. server.listen

除了执行这两个以外，还做了一些交互上的处理，如：打印服务器的 url、绑定一些快捷命令（直接在命令行输入指令）

```js
//打印服务器的 URL
server.printUrls();
```

![image.png](https://cdn.nlark.com/yuque/0/2024/png/29519093/1721964466246-eae945c2-66b1-44d6-9472-a3b3f3cbade4.png?x-oss-process=image%2Fformat%2Cwebp)



自定义快捷键

```js
 //绑定cli 快捷命令
server.bindCLIShortcuts({ print: true, customShortcuts });

//开发模式下的一些快捷键
const BASE_DEV_SHORTCUTS: CLIShortcut<ViteDevServer>[] = [
  {
    key: "r",
    description: "restart the server",
    async action(server) {
      await restartServerWithUrls(server);
    },
  },
  {
    key: "u",
    description: "show server url",
    action(server) {
      server.config.logger.info("");
      server.printUrls();
    },
  },
  {
    key: "o",
    description: "open in browser",
    action(server) {
      server.openBrowser();
    },
  },
  {
    key: "c",
    description: "clear console",
    action(server) {
      server.config.logger.clearScreen("error");
    },
  },
  {
    key: "q",
    description: "quit",
    async action(server) {
      await server.close().finally(() => process.exit());
    },
  },
];
```



#### createServer

重点在创建服务器和启动服务器这两个步骤，接下来我们详细来看。位置在 packages/vite/src/node/server/index.ts 后续的步骤都是在 vite/src/node 下面的目录中，之后我就以 node/来表示文件存在的位置了

cli.ts 中导入了 createServer 这个方法，然而这个方法实际上调用的是\_createServer

```typescript
export function createServer(
  inlineConfig: InlineConfig = {},
): Promise<ViteDevServer> {
  return _createServer(inlineConfig, { hotListen: true })
}
```



这个函数设计到的源码过多，我展示主要的部分

```typescript
export async function _createServer(
  inlineConfig: InlineConfig = {},
  options: { hotListen: boolean },
): Promise<ViteDevServer> {
  const config = await resolveConfig(inlineConfig, 'serve')

  const initPublicFilesPromise = initPublicFiles(config);

  const httpsOptions = await resolveHttpsConfig(config.server.https);
  
  const middlewares = connect() as Connect.Server;
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(serverConfig, middlewares, httpsOptions);

  const ws = createWebSocketServer(httpServer, config, httpsOptions)
  const hot = createHMRBroadcaster()
    .addChannel(ws)
    .addChannel(createServerHMRChannel())

  /* ...... */

  const container = await createPluginContainer(config, moduleGraph, watcher)

  const devHtmlTransformFn = createDevHtmlTransformFn(config)

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
    transformRequest(url, options) {
      return transformRequest(url, server, options)
    },
    async warmupRequest(url, options) {
      try {
        await transformRequest(url, server, options)
      } catch (e) {
        if (
          e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
          e?.code === ERR_CLOSED_SERVER
        ) {
          // these are expected errors
          return
        }
        // Unexpected error, log the issue but avoid an unhandled exception
        server.config.logger.error(`Pre-transform error: ${e.message}`, {
          error: e,
          timestamp: true,
        })
      }
    },
    transformIndexHtml(url, html, originalUrl) {
      return devHtmlTransformFn(server, url, html, originalUrl)
    },
       /* ....*/
    async ssrFetchModule(url: string, importer?: string) {
      return ssrFetchModule(server, url, importer)
    },
   
    async listen(port?: number, isRestart?: boolean) {
      await startServer(server, port)
      if (httpServer) {
        server.resolvedUrls = await resolveServerUrls(
          httpServer,
          config.server,
          config,
        )
        if (!isRestart && config.server.open) server.openBrowser()
      }
      return server
    },
    openBrowser() {
      const options = server.config.server
      const url =
        server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0]
      if (url) {
        const path =
          typeof options.open === 'string'
            ? new URL(options.open, url).href
            : url

        // We know the url that the browser would be opened to, so we can
        // start the request while we are awaiting the browser. This will
        // start the crawling of static imports ~500ms before.
        // preTransformRequests needs to be enabled for this optimization.
        if (server.config.server.preTransformRequests) {
          setTimeout(() => {
            const getMethod = path.startsWith('https:') ? httpsGet : httpGet

            getMethod(
              path,
              {
                headers: {
                  // Allow the history middleware to redirect to /index.html
                  Accept: 'text/html',
                },
              },
              (res) => {
                res.on('end', () => {
                  // Ignore response, scripts discovered while processing the entry
                  // will be preprocessed (server.config.server.preTransformRequests)
                })
              },
            )
              .on('error', () => {
                // Ignore errors
              })
              .end()
          }, 0)
        }

        _openBrowser(path, true, server.config.logger)
      } else {
        server.config.logger.warn('No URL available to open in browser')
      }
    },
    async close() {
      if (!middlewareMode) {
        process.off('SIGTERM', exitProcess)
        if (process.env.CI !== 'true') {
          process.stdin.off('end', exitProcess)
        }
      }
      await Promise.allSettled([
        watcher.close(),
        hot.close(),
        container.close(),
        crawlEndFinder?.cancel(),
        getDepsOptimizer(server.config)?.close(),
        getDepsOptimizer(server.config, true)?.close(),
        closeHttpServer(),
      ])
      // Await pending requests. We throw early in transformRequest
      // and in hooks if the server is closing for non-ssr requests,
      // so the import analysis plugin stops pre-transforming static
      // imports and this block is resolved sooner.
      // During SSR, we let pending requests finish to avoid exposing
      // the server closed error to the users.
      while (server._pendingRequests.size > 0) {
        await Promise.allSettled(
          [...server._pendingRequests.values()].map(
            (pending) => pending.request,
          ),
        )
      }
      server.resolvedUrls = null
    },
    printUrls() {
      if (server.resolvedUrls) {
        printServerUrls(
          server.resolvedUrls,
          serverConfig.host,
          config.logger.info,
        )
      } else if (middlewareMode) {
        throw new Error('cannot print server URLs in middleware mode.')
      } else {
        throw new Error(
          'cannot print server URLs before server.listen is called.',
        )
      }
    },
    bindCLIShortcuts(options) {
      bindCLIShortcuts(server, options)
    },


    waitForRequestsIdle,
    _registerRequestProcessing,
    _onCrawlEnd,

    _setInternalServer(_server: ViteDevServer) {
      // Rebind internal the server variable so functions reference the user
      // server instance after a restart
      server = _server
    },
    _restartPromise: null,
    _importGlobMap: new Map(),
    _forceOptimizeOnRestart: false,
    _pendingRequests: new Map(),
   /* ... */
  }

  /*....*/

  
  //这里是注册一些中间件，后面详细说
    middlewares.use(cachedTransformMiddleware(server))
 
  /*...*/


  // 这个函数在初始化vite 服务器
    const initServer = async () => {
      if (serverInited) return
      if (initingServer) return initingServer
  
      initingServer = (async function () {
        await container.buildStart({})
        // start deps optimizer after all container plugins are ready
        // 这里是vite 预构建依赖的地方
        if (isDepsOptimizerEnabled(config, false)) {
          await initDepsOptimizer(config, server)
        }
        warmupFiles(server)
        initingServer = undefined
        serverInited = true
      })()
      return initingServer
    }

  /*....*/

  // 将server 返回，cli中去调用listen启动服务器
  return server
}
```









#### server.listen

这是 cli 中的处理，先创建 vite 服务器，然后调用 listen 去启动服务器

```typescript
const server = await createServer({
    root,
    base: options.base,
    mode: options.mode,
    configFile: options.config,
    logLevel: options.logLevel,
    clearScreen: options.clearScreen,
    optimizeDeps: { force: options.force },
    server: cleanOptions(options),
  })

  if (!server.httpServer) {
    throw new Error('HTTP server not available')
  }

  await server.listen()
```



 await server.listen() 我们来看这个里面做了哪些事情。在server 中定义了 listen 方法，用于启动服务器

```typescript
  async listen(port?: number, isRestart?: boolean) {
    await startServer(server, port)
    if (httpServer) {
      server.resolvedUrls = await resolveServerUrls(
        httpServer,
        config.server,
        config,
      )
      if (!isRestart && config.server.open) server.openBrowser()
    }
    return server
  },
```



1. 调用 startServer，启动一个服务器
2. 调用 resolveServerUrls，解析服务器的本地和网络 URL
   resolvedUrls 存储 Vite 在 CLI 上打印的解析后的 URLs，在中间件模式下或 server.listen 调用前为 null
3. 如果不是重启且配置了 open（打开浏览器），则会调用 server 身上的 openBrowser 打开浏览器





这个函数用于启动 Vite 开发服务器，接收一个 ViteDevServer 实例和一个可选的端口号 inlinePort，并在特定条件下启动 HTTP 服务器

```typescript
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
```



startServer 里面实际调用了 httpServerStart 这个方法来去启动服务器（listen）

```typescript
export async function httpServerStart(
  httpServer: HttpServer,
  serverOptions: {
    port: number;
    strictPort: boolean | undefined;
    host: string | undefined;
    logger: Logger;
  }
): Promise<number> {
  let { port, strictPort, host, logger } = serverOptions;

  return new Promise((resolve, reject) => {
    const onError = (e: Error & { code?: string }) => {
      if (e.code === "EADDRINUSE") {
        if (strictPort) {
          httpServer.removeListener("error", onError);
          reject(new Error(`Port ${port} is already in use`));
        } else {
          logger.info(`Port ${port} is in use, trying another one...`);
          httpServer.listen(++port, host);
        }
      } else {
        httpServer.removeListener("error", onError);
        reject(e);
      }
    };

    httpServer.on("error", onError);

    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", onError);
      resolve(port);
    });
  });
}
```



这里的重点就是 httpServer.listen ，还记得吗，在创建server 的时候，这里已经把listen 方法重写了，来让我们回顾一下：

1. 先保存一份原始的listen 方法
2. 重写listen方法，在执行原始的listen 方法之间做一些初始化的事情，例如：

1. 1. 启动热更新服务
   2. 调用initServer 这个方法里面最重要的就是预构建依赖，其次是对一些文件预热

```typescript
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
```



我们再来看看 initServer，这个函数主要用于初始化服务器。

目的是为了确保在服务器启动时，一些关键的初始化步骤只执行一次，即使 httpServer.listen 被多次调用。

这是为了避免重复执行 buildStart 以及其他初始化逻辑

```typescript
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
```



> 这里提一下 buildStart 这里通过插件容器去调用 插件的buildStart钩子函数，一些插件需要在此做一些初始化的事情

这里是pluginContainer 自身的buildStart，会并行执行所有插件的 buildStart 钩子

```typescript
 async buildStart() {
    await handleHookPromise(
      hookParallel(
        "buildStart",
        (plugin) => new Context(plugin),
        () => [container.options as NormalizedInputOptions]
      )
    );
  },
```

下面是客户端注入常量的插件，在buildStart 钩子做了一些初始化，在transform 钩子的时候去替换源码中定义的常量，将其转换为真实的常量。源码位置vite/src/node/plugins/clientInjections.ts

```typescript
export function clientInjectionsPlugin(config: ResolvedConfig): Plugin {
  let injectConfigValues: (code: string) => string

  return {
    name: 'vite:client-inject',
    async buildStart() {
      const resolvedServerHostname = (await resolveHostname(config.server.host))
        .name
      const resolvedServerPort = config.server.port!
      const devBase = config.base

      const serverHost = `${resolvedServerHostname}:${resolvedServerPort}${devBase}`

      let hmrConfig = config.server.hmr
      hmrConfig = isObject(hmrConfig) ? hmrConfig : undefined
      const host = hmrConfig?.host || null
      const protocol = hmrConfig?.protocol || null
      const timeout = hmrConfig?.timeout || 30000
      const overlay = hmrConfig?.overlay !== false
      const isHmrServerSpecified = !!hmrConfig?.server
      const hmrConfigName = path.basename(config.configFile || 'vite.config.js')

      // hmr.clientPort -> hmr.port
      // -> (24678 if middleware mode and HMR server is not specified) -> new URL(import.meta.url).port
      let port = hmrConfig?.clientPort || hmrConfig?.port || null
      if (config.server.middlewareMode && !isHmrServerSpecified) {
        port ||= 24678
      }

      let directTarget = hmrConfig?.host || resolvedServerHostname
      directTarget += `:${hmrConfig?.port || resolvedServerPort}`
      directTarget += devBase

      let hmrBase = devBase
      if (hmrConfig?.path) {
        hmrBase = path.posix.join(hmrBase, hmrConfig.path)
      }

      const userDefine: Record<string, any> = {}
      for (const key in config.define) {
        // import.meta.env.* is handled in `importAnalysis` plugin
        if (!key.startsWith('import.meta.env.')) {
          userDefine[key] = config.define[key]
        }
      }
      const serializedDefines = serializeDefine(userDefine)

      const modeReplacement = escapeReplacement(config.mode)
      const baseReplacement = escapeReplacement(devBase)
      const definesReplacement = () => serializedDefines
      const serverHostReplacement = escapeReplacement(serverHost)
      const hmrProtocolReplacement = escapeReplacement(protocol)
      const hmrHostnameReplacement = escapeReplacement(host)
      const hmrPortReplacement = escapeReplacement(port)
      const hmrDirectTargetReplacement = escapeReplacement(directTarget)
      const hmrBaseReplacement = escapeReplacement(hmrBase)
      const hmrTimeoutReplacement = escapeReplacement(timeout)
      const hmrEnableOverlayReplacement = escapeReplacement(overlay)
      const hmrConfigNameReplacement = escapeReplacement(hmrConfigName)

      injectConfigValues = (code: string) => {
        return code
          .replace(`__MODE__`, modeReplacement)
          .replace(/__BASE__/g, baseReplacement)
          .replace(`__DEFINES__`, definesReplacement)
          .replace(`__SERVER_HOST__`, serverHostReplacement)
          .replace(`__HMR_PROTOCOL__`, hmrProtocolReplacement)
          .replace(`__HMR_HOSTNAME__`, hmrHostnameReplacement)
          .replace(`__HMR_PORT__`, hmrPortReplacement)
          .replace(`__HMR_DIRECT_TARGET__`, hmrDirectTargetReplacement)
          .replace(`__HMR_BASE__`, hmrBaseReplacement)
          .replace(`__HMR_TIMEOUT__`, hmrTimeoutReplacement)
          .replace(`__HMR_ENABLE_OVERLAY__`, hmrEnableOverlayReplacement)
          .replace(`__HMR_CONFIG_NAME__`, hmrConfigNameReplacement)
      }
    },
    async transform(code, id, options) {
      if (id === normalizedClientEntry || id === normalizedEnvEntry) {
        return injectConfigValues(code)
      } else if (!options?.ssr && code.includes('process.env.NODE_ENV')) {
        // replace process.env.NODE_ENV instead of defining a global
        // for it to avoid shimming a `process` object during dev,
        // avoiding inconsistencies between dev and build
        const nodeEnv =
          config.define?.['process.env.NODE_ENV'] ||
          JSON.stringify(process.env.NODE_ENV || config.mode)
        return await replaceDefine(
          code,
          id,
          {
            'process.env.NODE_ENV': nodeEnv,
            'global.process.env.NODE_ENV': nodeEnv,
            'globalThis.process.env.NODE_ENV': nodeEnv,
          },
          config,
        )
      }
    },
  }
}
```



让我们在回到主线流程上面来

```typescript
 async listen(port?: number, isRestart?: boolean) {
    await startServer(server, port)
    if (httpServer) {
      server.resolvedUrls = await resolveServerUrls(
        httpServer,
        config.server,
        config,
      )
      if (!isRestart && config.server.open) server.openBrowser()
    }
    return server
  },
```

启动完服务器后，会去调用openBrowser 打开浏览器，这里对windows 和 mac 系统做了不同的处理，windows 通过调用 open 这个包去打开浏览器，而mac 电脑 则通过node子进程 去执行一些命令来打开浏览器。源码位置vite/src/node/server/openBrowser.ts





至此，执行完 npm run dev 启动vite 服务器的大致流程就算完了，但是要想真正的能够正常的打开浏览器显示里面的内容 还需要很多工作的处理，预构建依赖会单独出一章讲解
