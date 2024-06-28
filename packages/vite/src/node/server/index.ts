import { isDepsOptimizerEnabled, resolveConfig } from "../config";
import type { InlineConfig, ResolvedConfig } from "../config";

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

  const resolvedOutDirs = getResolvedOutDirs(
    config.root,
    config.build.outDir,
    config.build.rollupOptions?.output
  );
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

  const ws = createWebSocketServer(httpServer, config, httpsOptions);
  const hot = createHMRBroadcaster()
    .addChannel(ws)
    .addChannel(createServerHMRChannel());
  if (typeof config.server.hmr === "object" && config.server.hmr.channels) {
    config.server.hmr.channels.forEach((channel) => hot.addChannel(channel));
  }

  const publicFiles = await initPublicFilesPromise;
  const { publicDir } = config;

  if (httpServer) {
    setClientErrorHandler(httpServer, config.logger);
  }

  // eslint-disable-next-line eqeqeq
  const watchEnabled = serverConfig.watch !== null;
  const watcher = watchEnabled
    ? (chokidar.watch(
        // config file dependencies and env file might be outside of root
        [
          root,
          ...config.configFileDependencies,
          ...getEnvFilesForMode(config.mode, config.envDir),
          // Watch the public directory explicitly because it might be outside
          // of the root directory.
          ...(publicDir && publicFiles ? [publicDir] : []),
        ],
        resolvedWatchOptions
      ) as FSWatcher)
    : createNoopWatcher(resolvedWatchOptions);

  const moduleGraph: ModuleGraph = new ModuleGraph((url, ssr) =>
    container.resolveId(url, undefined, { ssr })
  );

  const container = await createPluginContainer(config, moduleGraph, watcher);
  const closeHttpServer = createServerCloseFn(httpServer);

  let exitProcess: () => void;

  const devHtmlTransformFn = createDevHtmlTransformFn(config);

  const onCrawlEndCallbacks: (() => void)[] = [];
  const crawlEndFinder = setupOnCrawlEnd(() => {
    onCrawlEndCallbacks.forEach((cb) => cb());
  });
  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    return crawlEndFinder.waitForRequestsIdle(ignoredId);
  }
  function _registerRequestProcessing(id: string, done: () => Promise<any>) {
    crawlEndFinder.registerRequestProcessing(id, done);
  }
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
      await startServer(server, port);
      if (httpServer) {
        server.resolvedUrls = await resolveServerUrls(
          httpServer,
          config.server,
          config
        );
        if (!isRestart && config.server.open) server.openBrowser();
      }
      return server;
    },
    openBrowser() {
      const options = server.config.server;
      const url =
        server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0];
      if (url) {
        const path =
          typeof options.open === "string"
            ? new URL(options.open, url).href
            : url;

        // We know the url that the browser would be opened to, so we can
        // start the request while we are awaiting the browser. This will
        // start the crawling of static imports ~500ms before.
        // preTransformRequests needs to be enabled for this optimization.
        if (server.config.server.preTransformRequests) {
          setTimeout(() => {
            const getMethod = path.startsWith("https:") ? httpsGet : httpGet;

            getMethod(
              path,
              {
                headers: {
                  // Allow the history middleware to redirect to /index.html
                  Accept: "text/html",
                },
              },
              (res) => {
                res.on("end", () => {
                  // Ignore response, scripts discovered while processing the entry
                  // will be preprocessed (server.config.server.preTransformRequests)
                });
              }
            )
              .on("error", () => {
                // Ignore errors
              })
              .end();
          }, 0);
        }

        _openBrowser(path, true, server.config.logger);
      } else {
        server.config.logger.warn("No URL available to open in browser");
      }
    },
    async close() {
      if (!middlewareMode) {
        process.off("SIGTERM", exitProcess);
        if (process.env.CI !== "true") {
          process.stdin.off("end", exitProcess);
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
      ]);
      // Await pending requests. We throw early in transformRequest
      // and in hooks if the server is closing for non-ssr requests,
      // so the import analysis plugin stops pre-transforming static
      // imports and this block is resolved sooner.
      // During SSR, we let pending requests finish to avoid exposing
      // the server closed error to the users.
      while (server._pendingRequests.size > 0) {
        await Promise.allSettled(
          [...server._pendingRequests.values()].map(
            (pending) => pending.request
          )
        );
      }
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
      if (!server._restartPromise) {
        server._forceOptimizeOnRestart = !!forceOptimize;
        server._restartPromise = restartServer(server).finally(() => {
          server._restartPromise = null;
          server._forceOptimizeOnRestart = false;
        });
      }
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
