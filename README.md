## 已经完成的功能

- 解析 vite.config 文件
- 解析 env 文件
- 静态服务配置
- 预构建处理中~
- 预热请求

## debug 调试

项目中有 launch.json 文件，可供调试使用，目前需要在 vite 目录下执行 npm run dev 获取打包后文件，再开始 vscode 的 debug

## vite 预热流程





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





