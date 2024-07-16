import colors from "picocolors";
import { createDebugger, getHash, promiseWithResolvers } from "../utils";
import type { ResolvedConfig, ViteDevServer } from "..";
import { getDepOptimizationConfig } from "../config";
import {
  // addManuallyIncludedOptimizeDeps,
  // addOptimizedDepInfo,
  createIsOptimizedDepFile,
  createIsOptimizedDepUrl,
  // depsFromOptimizedDepInfo,
  depsLogString,
  // discoverProjectDependencies,
  // extractExportsData,
  // getOptimizedDepPath,
  initDepsOptimizerMetadata,
  loadCachedDepOptimizationMetadata,
  // optimizeServerSsrDeps,
  // runOptimizeDeps,
  // toDiscoveredDependencies,
} from ".";
import type { DepOptimizationResult, DepsOptimizer, OptimizedDepInfo } from ".";

const debug = createDebugger("vite:deps");

const depsOptimizerMap = new WeakMap<ResolvedConfig, DepsOptimizer>();
const devSsrDepsOptimizerMap = new WeakMap<ResolvedConfig, DepsOptimizer>();

export function getDepsOptimizer(
  config: ResolvedConfig,
  ssr?: boolean
): DepsOptimizer | undefined {
  return (ssr ? devSsrDepsOptimizerMap : depsOptimizerMap).get(config);
}

export async function initDepsOptimizer(
  config: ResolvedConfig,
  server: ViteDevServer
): Promise<void> {
  if (!getDepsOptimizer(config, false)) {
    await createDepsOptimizer(config, server);
  }
}

/**
 * 这个函数是 Vite 的依赖优化器，用于管理依赖的优化过程
 * 这个函数相当复杂，涉及到多个步骤和状态管理
 * @param config
 * @param server
 */
async function createDepsOptimizer(
  config: ResolvedConfig,
  server: ViteDevServer
): Promise<void> {
  const { logger } = config;
  const ssr = false;
  // 当前时间戳，作为会话标识
  const sessionTimestamp = Date.now().toString();

  // 加载缓存的依赖优化元数据
  const cachedMetadata = await loadCachedDepOptimizationMetadata(config, ssr);

  // 用于处理防抖操作的计时器
  let debounceProcessingHandle: NodeJS.Timeout | undefined;

  // 标记优化器是否已关闭
  let closed = false;

  // 初始化元数据
  let metadata =
    cachedMetadata || initDepsOptimizerMetadata(config, ssr, sessionTimestamp);

  // 获取依赖优化的配置选项
  const options = getDepOptimizationConfig(config, ssr);

  /**
   *  noDiscovery 设置为 true 时，依赖优化器不会自动发现和处理新的依赖
   * 这个选项通常用于某些特定情况下，不希望在优化过程中自动发现新依赖，
   * 例如在一个固定的依赖环境下，防止不必要的依赖更新或添加
   *
   *  holdUntilCrawlEnd 设置为 true 时，依赖优化器会在爬取（crawl）依赖的过程中暂停优化，直到爬取过程结束
   * 这个选项通常用于需要先全面收集依赖信息，然后再进行优化的场景，确保在优化之前已经完全了解所有依赖关系
   *
   * 这两个选项可以在一定程度上控制依赖优化的行为，提供更灵活和精细的依赖管理策略
   */
  const { noDiscovery, holdUntilCrawlEnd } = options;

  const depsOptimizer: DepsOptimizer = {
    metadata, //依赖优化的元数据
    registerMissingImport, //注册缺失的导入
    run: () => debouncedProcessing(0), //启动防抖处理
    // 建判断是否为优化依赖文件的函数
    isOptimizedDepFile: createIsOptimizedDepFile(config),
    // 创建判断是否为优化依赖 URL 的函数
    isOptimizedDepUrl: createIsOptimizedDepUrl(config),
    // 获取优化依赖的 ID，通过依赖信息的 file 和 browserHash 生成
    getOptimizedDepId: (depInfo: OptimizedDepInfo) =>
      `${depInfo.file}?v=${depInfo.browserHash}`,
    close, //关闭优化器的函数
    options, //优化器的配置选项
  };

  // 设置缓存
  depsOptimizerMap.set(config, depsOptimizer);

  // 标记是否发现了新依赖
  let newDepsDiscovered = false;

  // 用于记录新发现的依赖
  let newDepsToLog: string[] = [];
  // 用于处理新依赖日志的计时器
  let newDepsToLogHandle: NodeJS.Timeout | undefined;
  const logNewlyDiscoveredDeps = () => {
    if (newDepsToLog.length) {
      // 使用 config.logger.info 打印新依赖日志，并将 newDepsToLog 清空。
      config.logger.info(
        colors.green(
          `✨ new dependencies optimized: ${depsLogString(newDepsToLog)}`
        ),
        {
          timestamp: true,
        }
      );
      newDepsToLog = [];
    }
  };

  /**用于存储在扫描期间发现的依赖项 */
  let discoveredDepsWhileScanning: string[] = [];
  /** 该函数用于记录扫描期间发现的依赖项 */
  const logDiscoveredDepsWhileScanning = () => {
    if (discoveredDepsWhileScanning.length) {
      // 如果扫描期间发现的依赖项存在，则记录日志信息，并且清空依赖项数组
      config.logger.info(
        colors.green(
          `✨ discovered while scanning: ${depsLogString(
            discoveredDepsWhileScanning
          )}`
        ),
        {
          timestamp: true,
        }
      );
      discoveredDepsWhileScanning = [];
    }
  };

  /**初始化一个处理依赖优化的 Promise */
  let depOptimizationProcessing = promiseWithResolvers<void>();
  /**用于存储依赖优化处理队列中的 Promise */
  let depOptimizationProcessingQueue: PromiseWithResolvers<void>[] = [];

  /**该函数用于解析（resolve）所有在队列中的处理 Promise */
  const resolveEnqueuedProcessingPromises = () => {
    // Resolve all the processings (including the ones which were delayed)
    for (const processing of depOptimizationProcessingQueue) {
      processing.resolve();
    }
    depOptimizationProcessingQueue = [];
  };

  /**用于存储需要重新运行的函数 */
  let enqueuedRerun: (() => void) | undefined;
  /**标记当前是否正在进行依赖优化处理 */
  let currentlyProcessing = false;

  /**标记是否已经进行过首次依赖优化处理 */
  let firstRunCalled = !!cachedMetadata;
  /**标记是否需要警告遗漏的依赖项 */
  let warnAboutMissedDependencies = false;

  /**
   * 这段代码的目的是为了优化依赖的首次加载和后续的依赖发现过程
   *
   * 1. 冷启动：
   * 在冷启动时（没有缓存的元数据），会等待首次请求中发现的静态导入（static imports）
   * 此时，代码会监听 onCrawlEnd 事件，即等待爬取静态导入完成后再继续。
   * 这么做的目的是为了确保在首次加载时尽可能减少页面重新加载的次数，从而提高用户体验
   *
   * 2. 热启动：
   * 在热启动或首次优化之后，每次发现新的依赖项时，采用一个更简单的去抖动（debounce）策略进行处理
   * 这意味着不需要等待爬取结束，可以更快地处理新发现的依赖项，从而提高整体的响应速度
   */
  /**用于标记是否正在等待依赖爬取结束 */
  let waitingForCrawlEnd = false;
  if (!cachedMetadata) {
    // 检查是否有缓存的元数据，如果没有缓存的元数据，则意味着这是一个冷启动

    // 如果是冷启动，代码会注册一个回调函数 onCrawlEnd，该回调函数将在爬取静态导入完成时被调用。
    server._onCrawlEnd(onCrawlEnd);

    // 设置为true 表示当前正在等待依赖爬取结束
    waitingForCrawlEnd = true;
  }

  /**用于存储依赖优化的结果 */
  let optimizationResult:
    | {
        cancel: () => Promise<void>;
        result: Promise<DepOptimizationResult>;
      }
    | undefined;

  /**用于存储发现依赖的结果 */
  let discover:
    | {
        cancel: () => Promise<void>;
        result: Promise<Record<string, string>>;
      }
    | undefined;

  /**
   *  这个函数用于关闭依赖优化器，并确保所有正在进行的任务都被取消或完成。
   */
  async function close() {
    // 设置为 true，表示优化器已关闭
    closed = true;
    await Promise.allSettled([
      // 取消依赖发现任务
      discover?.cancel(),
      // 等待依赖扫描任务完成
      depsOptimizer.scanProcessing,
      // 取消优化结果任务
      optimizationResult?.cancel(),
    ]);
  }

  if (!cachedMetadata) {
    // Enter processing state until crawl of static imports ends
    currentlyProcessing = true;

    // Initialize discovered deps with manually added optimizeDeps.include info

    const manuallyIncludedDeps: Record<string, string> = {};
    await addManuallyIncludedOptimizeDeps(manuallyIncludedDeps, config, ssr);

    const manuallyIncludedDepsInfo = toDiscoveredDependencies(
      config,
      manuallyIncludedDeps,
      ssr,
      sessionTimestamp
    );

    for (const depInfo of Object.values(manuallyIncludedDepsInfo)) {
      addOptimizedDepInfo(metadata, "discovered", {
        ...depInfo,
        processing: depOptimizationProcessing.promise,
      });
      newDepsDiscovered = true;
    }

    if (noDiscovery) {
      // We don't need to scan for dependencies or wait for the static crawl to end
      // Run the first optimization run immediately
      runOptimizer();
    } else {
      // Important, the scanner is dev only
      depsOptimizer.scanProcessing = new Promise((resolve) => {
        // Runs in the background in case blocking high priority tasks
        (async () => {
          try {
            debug?.(colors.green(`scanning for dependencies...`));

            discover = discoverProjectDependencies(config);
            const deps = await discover.result;
            discover = undefined;

            const manuallyIncluded = Object.keys(manuallyIncludedDepsInfo);
            discoveredDepsWhileScanning.push(
              ...Object.keys(metadata.discovered).filter(
                (dep) => !deps[dep] && !manuallyIncluded.includes(dep)
              )
            );

            // Add these dependencies to the discovered list, as these are currently
            // used by the preAliasPlugin to support aliased and optimized deps.
            // This is also used by the CJS externalization heuristics in legacy mode
            for (const id of Object.keys(deps)) {
              if (!metadata.discovered[id]) {
                addMissingDep(id, deps[id]);
              }
            }

            const knownDeps = prepareKnownDeps();
            startNextDiscoveredBatch();

            // For dev, we run the scanner and the first optimization
            // run on the background
            optimizationResult = runOptimizeDeps(config, knownDeps, ssr);

            // If the holdUntilCrawlEnd stratey is used, we wait until crawling has
            // ended to decide if we send this result to the browser or we need to
            // do another optimize step
            if (!holdUntilCrawlEnd) {
              // If not, we release the result to the browser as soon as the scanner
              // is done. If the scanner missed any dependency, and a new dependency
              // is discovered while crawling static imports, then there will be a
              // full-page reload if new common chunks are generated between the old
              // and new optimized deps.
              optimizationResult.result.then((result) => {
                // Check if the crawling of static imports has already finished. In that
                // case, the result is handled by the onCrawlEnd callback
                if (!waitingForCrawlEnd) return;

                optimizationResult = undefined; // signal that we'll be using the result

                runOptimizer(result);
              });
            }
          } catch (e) {
            logger.error(e.stack || e.message);
          } finally {
            resolve();
            depsOptimizer.scanProcessing = undefined;
          }
        })();
      });
    }
  }

  function startNextDiscoveredBatch() {
    newDepsDiscovered = false;

    // Add the current depOptimizationProcessing to the queue, these
    // promises are going to be resolved once a rerun is committed
    depOptimizationProcessingQueue.push(depOptimizationProcessing);

    // Create a new promise for the next rerun, discovered missing
    // dependencies will be assigned this promise from this point
    depOptimizationProcessing = promiseWithResolvers();
  }

  function prepareKnownDeps() {
    const knownDeps: Record<string, OptimizedDepInfo> = {};
    // Clone optimized info objects, fileHash, browserHash may be changed for them
    for (const dep of Object.keys(metadata.optimized)) {
      knownDeps[dep] = { ...metadata.optimized[dep] };
    }
    for (const dep of Object.keys(metadata.discovered)) {
      // Clone the discovered info discarding its processing promise
      const { processing, ...info } = metadata.discovered[dep];
      knownDeps[dep] = info;
    }
    return knownDeps;
  }

  async function runOptimizer(preRunResult?: DepOptimizationResult) {
    // a successful completion of the optimizeDeps rerun will end up
    // creating new bundled version of all current and discovered deps
    // in the cache dir and a new metadata info object assigned
    // to _metadata. A fullReload is only issued if the previous bundled
    // dependencies have changed.

    // if the rerun fails, _metadata remains untouched, current discovered
    // deps are cleaned, and a fullReload is issued

    // All deps, previous known and newly discovered are rebundled,
    // respect insertion order to keep the metadata file stable

    const isRerun = firstRunCalled;
    firstRunCalled = true;

    // Ensure that rerun is called sequentially
    enqueuedRerun = undefined;

    // Ensure that a rerun will not be issued for current discovered deps
    if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle);

    if (closed) {
      currentlyProcessing = false;
      return;
    }

    currentlyProcessing = true;

    try {
      let processingResult: DepOptimizationResult;
      if (preRunResult) {
        processingResult = preRunResult;
      } else {
        const knownDeps = prepareKnownDeps();
        startNextDiscoveredBatch();

        optimizationResult = runOptimizeDeps(config, knownDeps, ssr);
        processingResult = await optimizationResult.result;
        optimizationResult = undefined;
      }

      if (closed) {
        currentlyProcessing = false;
        processingResult.cancel();
        resolveEnqueuedProcessingPromises();
        return;
      }

      const newData = processingResult.metadata;

      const needsInteropMismatch = findInteropMismatches(
        metadata.discovered,
        newData.optimized
      );

      // After a re-optimization, if the internal bundled chunks change a full page reload
      // is required. If the files are stable, we can avoid the reload that is expensive
      // for large applications. Comparing their fileHash we can find out if it is safe to
      // keep the current browser state.
      const needsReload =
        needsInteropMismatch.length > 0 ||
        metadata.hash !== newData.hash ||
        Object.keys(metadata.optimized).some((dep) => {
          return (
            metadata.optimized[dep].fileHash !== newData.optimized[dep].fileHash
          );
        });

      const commitProcessing = async () => {
        await processingResult.commit();

        // While optimizeDeps is running, new missing deps may be discovered,
        // in which case they will keep being added to metadata.discovered
        for (const id in metadata.discovered) {
          if (!newData.optimized[id]) {
            addOptimizedDepInfo(newData, "discovered", metadata.discovered[id]);
          }
        }

        // If we don't reload the page, we need to keep browserHash stable
        if (!needsReload) {
          newData.browserHash = metadata.browserHash;
          for (const dep in newData.chunks) {
            newData.chunks[dep].browserHash = metadata.browserHash;
          }
          for (const dep in newData.optimized) {
            newData.optimized[dep].browserHash = (
              metadata.optimized[dep] || metadata.discovered[dep]
            ).browserHash;
          }
        }

        // Commit hash and needsInterop changes to the discovered deps info
        // object. Allow for code to await for the discovered processing promise
        // and use the information in the same object
        for (const o in newData.optimized) {
          const discovered = metadata.discovered[o];
          if (discovered) {
            const optimized = newData.optimized[o];
            discovered.browserHash = optimized.browserHash;
            discovered.fileHash = optimized.fileHash;
            discovered.needsInterop = optimized.needsInterop;
            discovered.processing = undefined;
          }
        }

        if (isRerun) {
          newDepsToLog.push(
            ...Object.keys(newData.optimized).filter(
              (dep) => !metadata.optimized[dep]
            )
          );
        }

        metadata = depsOptimizer.metadata = newData;
        resolveEnqueuedProcessingPromises();
      };

      if (!needsReload) {
        await commitProcessing();

        if (!debug) {
          if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle);
          newDepsToLogHandle = setTimeout(() => {
            newDepsToLogHandle = undefined;
            logNewlyDiscoveredDeps();
            if (warnAboutMissedDependencies) {
              logDiscoveredDepsWhileScanning();
              config.logger.info(
                colors.magenta(
                  `❗ add these dependencies to optimizeDeps.include to speed up cold start`
                ),
                { timestamp: true }
              );
              warnAboutMissedDependencies = false;
            }
          }, 2 * debounceMs);
        } else {
          debug(
            colors.green(
              `✨ ${
                !isRerun
                  ? `dependencies optimized`
                  : `optimized dependencies unchanged`
              }`
            )
          );
        }
      } else {
        if (newDepsDiscovered) {
          // There are newly discovered deps, and another rerun is about to be
          // executed. Avoid the current full reload discarding this rerun result
          // We don't resolve the processing promise, as they will be resolved
          // once a rerun is committed
          processingResult.cancel();

          debug?.(
            colors.green(
              `✨ delaying reload as new dependencies have been found...`
            )
          );
        } else {
          await commitProcessing();

          if (!debug) {
            if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle);
            newDepsToLogHandle = undefined;
            logNewlyDiscoveredDeps();
            if (warnAboutMissedDependencies) {
              logDiscoveredDepsWhileScanning();
              config.logger.info(
                colors.magenta(
                  `❗ add these dependencies to optimizeDeps.include to avoid a full page reload during cold start`
                ),
                { timestamp: true }
              );
              warnAboutMissedDependencies = false;
            }
          }

          logger.info(
            colors.green(`✨ optimized dependencies changed. reloading`),
            {
              timestamp: true,
            }
          );
          if (needsInteropMismatch.length > 0) {
            config.logger.warn(
              `Mixed ESM and CJS detected in ${colors.yellow(
                needsInteropMismatch.join(", ")
              )}, add ${
                needsInteropMismatch.length === 1 ? "it" : "them"
              } to optimizeDeps.needsInterop to speed up cold start`,
              {
                timestamp: true,
              }
            );
          }

          fullReload();
        }
      }
    } catch (e) {
      logger.error(
        colors.red(`error while updating dependencies:\n${e.stack}`),
        { timestamp: true, error: e }
      );
      resolveEnqueuedProcessingPromises();

      // Reset missing deps, let the server rediscover the dependencies
      metadata.discovered = {};
    }

    currentlyProcessing = false;
    // @ts-expect-error `enqueuedRerun` could exist because `debouncedProcessing` may run while awaited
    enqueuedRerun?.();
  }

  function fullReload() {
    // Cached transform results have stale imports (resolved to
    // old locations) so they need to be invalidated before the page is
    // reloaded.
    server.moduleGraph.invalidateAll();

    server.hot.send({
      type: "full-reload",
      path: "*",
    });
  }

  async function rerun() {
    // debounce time to wait for new missing deps finished, issue a new
    // optimization of deps (both old and newly found) once the previous
    // optimizeDeps processing is finished
    const deps = Object.keys(metadata.discovered);
    const depsString = depsLogString(deps);
    debug?.(colors.green(`new dependencies found: ${depsString}`));
    runOptimizer();
  }

  function getDiscoveredBrowserHash(
    hash: string,
    deps: Record<string, string>,
    missing: Record<string, string>
  ) {
    return getHash(
      hash + JSON.stringify(deps) + JSON.stringify(missing) + sessionTimestamp
    );
  }

  function registerMissingImport(
    id: string,
    resolved: string
  ): OptimizedDepInfo {
    const optimized = metadata.optimized[id];
    if (optimized) {
      return optimized;
    }
    const chunk = metadata.chunks[id];
    if (chunk) {
      return chunk;
    }
    let missing = metadata.discovered[id];
    if (missing) {
      // We are already discover this dependency
      // It will be processed in the next rerun call
      return missing;
    }

    missing = addMissingDep(id, resolved);

    // Until the first optimize run is called, avoid triggering processing
    // We'll wait until the user codebase is eagerly processed by Vite so
    // we can get a list of every missing dependency before giving to the
    // browser a dependency that may be outdated, thus avoiding full page reloads

    if (!waitingForCrawlEnd) {
      // Debounced rerun, let other missing dependencies be discovered before
      // the running next optimizeDeps
      debouncedProcessing();
    }

    // Return the path for the optimized bundle, this path is known before
    // esbuild is run to generate the pre-bundle
    return missing;
  }

  function addMissingDep(id: string, resolved: string) {
    newDepsDiscovered = true;

    return addOptimizedDepInfo(metadata, "discovered", {
      id,
      file: getOptimizedDepPath(id, config, ssr),
      src: resolved,
      // Adding a browserHash to this missing dependency that is unique to
      // the current state of known + missing deps. If its optimizeDeps run
      // doesn't alter the bundled files of previous known dependencies,
      // we don't need a full reload and this browserHash will be kept
      browserHash: getDiscoveredBrowserHash(
        metadata.hash,
        depsFromOptimizedDepInfo(metadata.optimized),
        depsFromOptimizedDepInfo(metadata.discovered)
      ),
      // loading of this pre-bundled dep needs to await for its processing
      // promise to be resolved
      processing: depOptimizationProcessing.promise,
      exportsData: extractExportsData(resolved, config, ssr),
    });
  }

  function debouncedProcessing(timeout = debounceMs) {
    // Debounced rerun, let other missing dependencies be discovered before
    // the next optimizeDeps run
    enqueuedRerun = undefined;
    if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle);
    if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle);
    newDepsToLogHandle = undefined;
    debounceProcessingHandle = setTimeout(() => {
      debounceProcessingHandle = undefined;
      enqueuedRerun = rerun;
      if (!currentlyProcessing) {
        enqueuedRerun();
      }
    }, timeout);
  }

  // onCrawlEnd is called once when the server starts and all static
  // imports after the first request have been crawled (dynamic imports may also
  // be crawled if the browser requests them right away).
  async function onCrawlEnd() {
    // switch after this point to a simple debounce strategy
    waitingForCrawlEnd = false;

    debug?.(colors.green(`✨ static imports crawl ended`));
    if (closed) {
      return;
    }

    // Await for the scan+optimize step running in the background
    // It normally should be over by the time crawling of user code ended
    await depsOptimizer.scanProcessing;

    if (optimizationResult && !config.optimizeDeps.noDiscovery) {
      // In the holdUntilCrawlEnd strategy, we don't release the result of the
      // post-scanner optimize step to the browser until we reach this point
      // If there are new dependencies, we do another optimize run, if not, we
      // use the post-scanner optimize result
      // If holdUntilCrawlEnd is false and we reach here, it means that the
      // scan+optimize step finished after crawl end. We follow the same
      // process as in the holdUntilCrawlEnd in this case.
      const afterScanResult = optimizationResult.result;
      optimizationResult = undefined; // signal that we'll be using the result

      const result = await afterScanResult;
      currentlyProcessing = false;

      const crawlDeps = Object.keys(metadata.discovered);
      const scanDeps = Object.keys(result.metadata.optimized);

      if (scanDeps.length === 0 && crawlDeps.length === 0) {
        debug?.(
          colors.green(
            `✨ no dependencies found by the scanner or crawling static imports`
          )
        );
        // We still commit the result so the scanner isn't run on the next cold start
        // for projects without dependencies
        startNextDiscoveredBatch();
        runOptimizer(result);
        return;
      }

      const needsInteropMismatch = findInteropMismatches(
        metadata.discovered,
        result.metadata.optimized
      );
      const scannerMissedDeps = crawlDeps.some(
        (dep) => !scanDeps.includes(dep)
      );
      const outdatedResult =
        needsInteropMismatch.length > 0 || scannerMissedDeps;

      if (outdatedResult) {
        // Drop this scan result, and perform a new optimization to avoid a full reload
        result.cancel();

        // Add deps found by the scanner to the discovered deps while crawling
        for (const dep of scanDeps) {
          if (!crawlDeps.includes(dep)) {
            addMissingDep(dep, result.metadata.optimized[dep].src!);
          }
        }
        if (scannerMissedDeps) {
          debug?.(
            colors.yellow(
              `✨ new dependencies were found while crawling that weren't detected by the scanner`
            )
          );
        }
        debug?.(colors.green(`✨ re-running optimizer`));
        debouncedProcessing(0);
      } else {
        debug?.(
          colors.green(
            `✨ using post-scan optimizer result, the scanner found every used dependency`
          )
        );
        startNextDiscoveredBatch();
        runOptimizer(result);
      }
    } else if (!holdUntilCrawlEnd) {
      // The post-scanner optimize result has been released to the browser
      // If new deps have been discovered, issue a regular rerun of the
      // optimizer. A full page reload may still be avoided if the new
      // optimize result is compatible in this case
      if (newDepsDiscovered) {
        debug?.(
          colors.green(
            `✨ new dependencies were found while crawling static imports, re-running optimizer`
          )
        );
        warnAboutMissedDependencies = true;
        debouncedProcessing(0);
      }
    } else {
      const crawlDeps = Object.keys(metadata.discovered);
      currentlyProcessing = false;

      if (crawlDeps.length === 0) {
        debug?.(
          colors.green(
            `✨ no dependencies found while crawling the static imports`
          )
        );
        firstRunCalled = true;
      }

      // queue the first optimizer run, even without deps so the result is cached
      debouncedProcessing(0);
    }
  }
}
