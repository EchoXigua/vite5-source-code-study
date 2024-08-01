import colors from "picocolors";
import { createDebugger, getHash, promiseWithResolvers } from "../utils";
import type { ResolvedConfig, ViteDevServer } from "..";
import { getDepOptimizationConfig } from "../config";
import {
  addManuallyIncludedOptimizeDeps,
  addOptimizedDepInfo,
  createIsOptimizedDepFile,
  createIsOptimizedDepUrl,
  depsFromOptimizedDepInfo,
  depsLogString,
  discoverProjectDependencies,
  extractExportsData,
  getOptimizedDepPath,
  initDepsOptimizerMetadata,
  loadCachedDepOptimizationMetadata,
  // optimizeServerSsrDeps,
  runOptimizeDeps,
  toDiscoveredDependencies,
} from ".";
import type { DepOptimizationResult, DepsOptimizer, OptimizedDepInfo } from ".";

const debug = createDebugger("vite:deps");

/**
 * The amount to wait for requests to register newly found dependencies before triggering
 * a re-bundle + page reload
 */
const debounceMs = 100;

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

  /** 标记是否发现了新依赖 */
  let newDepsDiscovered = false;

  /** 用于记录新发现的依赖 */
  let newDepsToLog: string[] = [];
  /** 用于处理新依赖日志的计时器 */
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
   * 在热启动或首次优化之后，每次发现新的依赖项时，采用一个更简单的防抖（debounce）策略进行处理
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
    // 冷启动（没有缓存的元数据）

    // 进入处理状态，直到静态导入的抓取结束
    // 设置为 true，表示正在处理依赖优化
    currentlyProcessing = true;

    // 初始化手动包含的依赖项
    /**来存储手动包含的依赖项 */
    const manuallyIncludedDeps: Record<string, string> = {};

    // 添加手动包含的依赖项
    await addManuallyIncludedOptimizeDeps(manuallyIncludedDeps, config, ssr);

    // 将手动包含的依赖项转换 这是一个依赖信息的记录
    const manuallyIncludedDepsInfo = toDiscoveredDependencies(
      config,
      manuallyIncludedDeps,
      ssr,
      sessionTimestamp
    );

    // 将每个手动包含的依赖信息添加到 metadata 的 discovered 部分，
    // 同时将 processing 设置为 depOptimizationProcessing.promise。
    for (const depInfo of Object.values(manuallyIncludedDepsInfo)) {
      addOptimizedDepInfo(metadata, "discovered", {
        ...depInfo,
        /**
         * depOptimizationProcessing 是一个包含 resolve 和 promise 属性的对象
         *
         * 将一个表示依赖优化处理状态的 Promise 关联到每一个依赖项上
         * 1. 跟踪依赖项的优化状态：任何地方都可以通过这个 Promise 知道依赖优化过程是否完成
         * 2. 实现异步操作：当依赖项在优化过程中，可以通过这个 Promise 实现异步等待，确保优化完成后再进行下一步操作
         */
        processing: depOptimizationProcessing.promise,
      });
      // 新的依赖发现
      newDepsDiscovered = true;
    }

    // 下面这段代码的主要目的是在开发环境中扫描项目依赖项，并根据扫描结果进行依赖优化处理
    if (noDiscovery) {
      // We don't need to scan for dependencies or wait for the static crawl to end
      // Run the first optimization run immediately
      // 如果不需要进行依赖扫描或等待静态抓取结束
      // 立即进行第一次优化

      // noDiscovery 为 true 表示不需要进行依赖扫描，可以立即进行第一次优化处理
      runOptimizer();
    } else {
      // 进入依赖扫描和优化的流程

      // 注意，扫描器仅用于开发环境
      // 这个 Promise 用于追踪依赖扫描过程的状态
      depsOptimizer.scanProcessing = new Promise((resolve) => {
        // 在后台运行，以防止阻塞高优先级任务
        (async () => {
          try {
            debug?.(colors.green(`scanning for dependencies...`));

            // 异步函数扫描项目依赖项，并将结果存储在 deps 中
            discover = discoverProjectDependencies(config);
            const deps = await discover.result;
            discover = undefined;

            // 获取手动包含的依赖项列表
            const manuallyIncluded = Object.keys(manuallyIncludedDepsInfo);

            // 过滤出扫描过程中发现的新依赖项，并将其添加到 discoveredDepsWhileScanning 列表中
            discoveredDepsWhileScanning.push(
              ...Object.keys(metadata.discovered).filter(
                // 过滤出发现的新依赖项
                (dep) => !deps[dep] && !manuallyIncluded.includes(dep)
              )
            );

            // Add these dependencies to the discovered list, as these are currently
            // used by the preAliasPlugin to support aliased and optimized deps.
            // This is also used by the CJS externalization heuristics in legacy mode
            /**
             *  这一段注释解释了为什么要将这些依赖项添加到已发现的依赖项列表中
             *
             * 1. 支持别名和优化依赖项：
             * 这些依赖项目前由 preAliasPlugin 使用，preAliasPlugin 是 Vite 中的一个插件，用于处理依赖项的别名和优化
             * 将这些依赖项添加到已发现的依赖项列表中，可以确保它们在构建过程中被正确处理和优化。
             *
             * 2. 旧模式中的 CJS 外部化启发式：
             * 这些依赖项还用于旧模式中的 CJS（CommonJS）外部化启发式方法。
             * 在旧模式下，Vite 可能需要根据某些启发式方法决定哪些依赖项需要外部化处理（即不打包进最终构建产物中，而是保持为外部依赖）
             */

            // 将扫描过程中发现的依赖项添加到元数据的 discovered 部分。
            for (const id of Object.keys(deps)) {
              // 检查这些依赖项是否已经在 metadata.discovered 中（即是否已经被记录为已发现的依赖项）
              if (!metadata.discovered[id]) {
                // 对于尚未被记录为已发现的依赖项，将其添加到已发现的依赖项列表中
                addMissingDep(id, deps[id]);
              }
            }

            // 准备已知的依赖项
            const knownDeps = prepareKnownDeps();
            // 用来启动下一个已发现的依赖项批次处理
            startNextDiscoveredBatch();

            // 在开发环境中，依赖项扫描器和第一次依赖项优化将在后台运行
            optimizationResult = runOptimizeDeps(config, knownDeps, ssr);

            /**
             * 如果 holdUntilCrawlEnd 为 true，表示我们需要等待静态导入的爬取过程结束，
             * 然后再决定是否将结果发送到浏览器，或者需要执行另一个优化步骤
             */
            if (!holdUntilCrawlEnd) {
              // If not, we release the result to the browser as soon as the scanner
              // is done. If the scanner missed any dependency, and a new dependency
              // is discovered while crawling static imports, then there will be a
              // full-page reload if new common chunks are generated between the old
              // and new optimized deps.
              /**
               * 这段注释解释了在 holdUntilCrawlEnd 为 false 的情况下，
               * 依赖扫描器完成后会立即将结果释放到浏览器的行为，以及在静态导入爬取过程中可能出现的情况
               *
               *
               * 1. 释放结果到浏览器：
               * 如果 holdUntilCrawlEnd 为 false，意味着不需要等待静态导入的爬取过程结束
               * 在这种情况下，一旦依赖扫描器完成扫描，结果就会立即发送到浏览器
               * 这可以加快开发过程中的反馈速度，让开发者更快地看到变化
               *
               * 2. 可能的依赖项遗漏：
               * 扫描器可能会遗漏某些依赖项，特别是那些在初始扫描过程中未被检测到的依赖项
               * 这些遗漏的依赖项可能会在静态导入爬取过程中被发现
               *
               * 3. 新依赖项的发现与处理：
               * 如果在静态导入爬取过程中发现了新的依赖项，而这些依赖项在初始扫描过程中未被检测到，则需要处理这些新依赖项
               * 如果这些新发现的依赖项与旧的优化依赖项之间生成了新的公共模块（common chunks），
               * 则浏览器会进行一次完整的页面重载（full-page reload），以确保新的优化依赖项能够正确加载
               *
               * @example
               * 假设我们有一个项目，初始扫描过程中未检测到依赖 foo，但在静态导入爬取过程中发现了 foo
               * 如果 foo 被发现生成了新的公共模块，浏览器会进行完整的页面重载，以确保新依赖项 foo 正确加载并优化
               */
              optimizationResult.result.then((result) => {
                /**
                 * 在处理结果时，会检查静态导入的爬取是否已经完成。
                 * 如果已经完成，结果将由 onCrawlEnd 回调处理
                 * 如果尚未完成，将 optimizationResult 设置为 undefined，表示我们将使用当前结果，
                 * 然后调用 runOptimizer 函数进行优化
                 */
                if (!waitingForCrawlEnd) return;

                optimizationResult = undefined; // signal that we'll be using the result

                runOptimizer(result);
              });
            }
          } catch (e) {
            // 记录错误信息
            logger.error(e.stack || e.message);
          } finally {
            // 用于标记当前异步操作已经完成并且成功
            resolve();

            // 设置为 undefined 表示当前没有正在进行的依赖项扫描过程
            // 这是为了清理状态，防止下次扫描时误认为还有未完成的扫描任务
            depsOptimizer.scanProcessing = undefined;
          }
        })();
      });
    }
  }

  /**
   * 这个函数用于启动处理新发现的依赖项的下一批次，并管理优化依赖项处理的相关 Promise 对象
   *
   * 函数用于启动和管理处理依赖项优化的任务
   * 它通过重置状态、更新处理队列以及创建新的 Promise 来确保依赖项优化过程的顺利进行
   */
  function startNextDiscoveredBatch() {
    /**
     * 状态重置为 false,这个状态通常用于标识是否有新的依赖项被发现
     * 重置这个状态是为了在处理新的批次时能够准确地判断是否有新的依赖项需要处理
     */
    newDepsDiscovered = false;

    /**
     * 将当前的depOptimizationProcessing添加到队列中，一旦提交了重新运行，这些承诺将被解析
     *
     * depOptimizationProcessingQueue 是一个队列，用于管理所有待处理的依赖项优化 Promise
     * 将当前的 Promise 加入队列后，可以确保在优化重新运行时，能够顺序处理之前的所有 Promise
     */
    depOptimizationProcessingQueue.push(depOptimizationProcessing);

    /**
     * 创建一个新的 Promise 对象，并将其赋值给 depOptimizationProcessing
     * 这一步是为了为接下来发现的新依赖项分配一个新的 Promise
     * 这个新的 Promise 将用于处理下一批次的优化任务
     */
    depOptimizationProcessing = promiseWithResolvers();
  }

  /**
   * 这个函数的作用是准备一个包含已知依赖项信息的对象，
   * 这个对象由优化过的和发现的依赖项信息构成
   * 该函数会在处理这些依赖项时生成一个副本，以确保原始数据不被直接修改。
   * @returns
   */
  function prepareKnownDeps() {
    // 用于存储最终的依赖项信息
    const knownDeps: Record<string, OptimizedDepInfo> = {};
    /**
     * 通过拷贝优化过的依赖项信息，可以确保在后续操作中修改 knownDeps 对象不会影响原始的 metadata.optimized 数据
     * 特别是文件哈希（fileHash）和浏览器哈希（browserHash）可能会被更改
     */
    for (const dep of Object.keys(metadata.optimized)) {
      // 对每个优化过的依赖项信息进行浅拷贝，并将其添加到 knownDeps 对象中
      knownDeps[dep] = { ...metadata.optimized[dep] };
    }

    for (const dep of Object.keys(metadata.discovered)) {
      /**
       * 这样做是为了确保在 knownDeps 中不包含 processing 属性，这通常是一个 Promise 对象，
       * 代表依赖项是否仍在处理中。仅保留实际的依赖项信息。
       */

      // 解构出 processing 属性和其他属性 丢弃其处理承诺
      const { processing, ...info } = metadata.discovered[dep];
      // 将剩余的依赖项信息（即 info）添加到 knownDeps 对象中
      knownDeps[dep] = info;
    }
    return knownDeps;
  }

  /**
   * 这个函数在依赖项优化过程中很重要
   *
   * 这个函数用于优化项目的依赖项，处理优化结果，并决定是否需要重新加载页面
   * 它支持初次优化和后续的重新优化（即“重新运行”）
   * 优化结果会更新依赖项的元数据，并在需要时触发全页面重载
   * @param preRunResult
   * @returns
   */
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

    /**
     * 这段注释详细描述了在依赖项优化过程中的几个关键步骤和策略
     *
     * 1. 成功完成优化依赖项的重新运行
     *    1) 成功的重新运行: 如果优化依赖项的重新运行成功，它将创建一个新的打包版本，包括所有当前和新发现的依赖项
     *    2) 缓存目录: 新的打包版本会存储在缓存目录中（cache dir）
     *    3) 更新 _metadata: 会创建一个新的元数据对象，并将其分配给 _metadata 变量
     *    4) 全页面重载: 仅在先前打包的依赖项发生变化时才会触发全页面重载。这是为了避免不必要的重载，优化性能
     *
     * 2. 重新运行失败的处理
     *    1) 重新运行失败: 如果优化依赖项的重新运行失败，当前的 _metadata 将保持不变
     *    2) 清理当前发现的依赖项: 清理当前已发现的依赖项，以防止将错误的状态传播到下一个优化阶段
     *    3) 触发全页面重载: 由于优化失败，通常需要触发全页面重载以重新初始化状态或清理错误
     *
     *
     * 3. 重新打包所有依赖项
     *    1) 重新打包: 在优化过程中，所有依赖项（包括之前已知的和新发现的）都会被重新打包
     *    2) 保持插入顺序: 为了保持元数据文件的稳定性，打包时会尊重依赖项的插入顺序
     *       这样做可以确保元数据的一致性，避免因为依赖项顺序变化导致的问题
     *
     * 总结:
     * 成功的优化运行: 创建新的打包文件和元数据对象，仅在依赖项变化时才全页面重载
     * 失败的优化运行: 保持旧的元数据，清理发现的依赖项，并触发全页面重载
     * 重新打包依赖项: 重新打包所有依赖项，并保持元数据的插入顺序，以确保元数据文件的稳定性和一致性
     */

    /**记录是否是重新优化的运行 */
    const isRerun = firstRunCalled;
    /**设置为 true，标志首次优化已经完成 */
    firstRunCalled = true;

    // 确保重新优化是顺序执行的，清除可能存在的排队任务
    enqueuedRerun = undefined;

    // 如果有正在进行的防抖定时器，清除它，以便立即处理优化
    if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle);

    //  如果优化器已经关闭，停止当前处理并退出
    if (closed) {
      currentlyProcessing = false;
      return;
    }

    // 设置为 true，表示当前正在进行优化处理
    currentlyProcessing = true;

    try {
      let processingResult: DepOptimizationResult;

      // 如果有预处理结果（例如从之前的优化运行中传递过来的结果），使用它
      // 这意味着已经有了一个之前计算的优化结果，直接使用它来避免重新计算
      if (preRunResult) {
        processingResult = preRunResult;
      } else {
        // 准备当前已知的依赖项,这些依赖项是从现有的元数据中提取的
        const knownDeps = prepareKnownDeps();
        // 启动下一批次的发现处理, 这可能是为了处理新发现的依赖项
        startNextDiscoveredBatch();

        // 执行优化依赖项的函数，并等待其结果
        optimizationResult = runOptimizeDeps(config, knownDeps, ssr);
        processingResult = await optimizationResult.result;
        // 设为 undefined，以表示不再需要优化结果
        optimizationResult = undefined;
      }

      if (closed) {
        // closed 为 true，则表示当前优化过程已经被关闭或取消

        // 标记当前优化过程已经结束
        currentlyProcessing = false;

        // 取消当前的处理结果。这是为了确保任何未完成的操作不会继续进行
        processingResult.cancel();

        // 确保所有排队的操作都能得到处理或取消
        resolveEnqueuedProcessingPromises();
        return;
      }

      // 获取处理结果中的元数据
      const newData = processingResult.metadata;

      // 检查当前发现的依赖项与优化后的依赖项之间是否存在互操作性问题（例如，ESM 和 CJS 的混合使用）
      // needsInteropMismatch 将包含所有存在互操作性不匹配的依赖项
      const needsInteropMismatch = findInteropMismatches(
        metadata.discovered,
        newData.optimized
      );

      // After a re-optimization, if the internal bundled chunks change a full page reload
      // is required. If the files are stable, we can avoid the reload that is expensive
      // for large applications. Comparing their fileHash we can find out if it is safe to
      // keep the current browser state.
      /**
       * 这段注释解释了在优化依赖项之后是否需要重新加载页面的策略
       *
       * 1. 重新优化后的内部打包文件变化:
       * 如果在重新优化依赖项后，内部的打包文件（即生成的 JavaScript 代码块或模块）发生了变化，则需要重新加载页面
       * 内部打包文件的变化可能会影响整个应用的状态和行为
       * 为了确保应用程序能够正确地加载新版本的代码，需要刷新页面来加载最新的文件和状态
       *
       * 2. 避免不必要的页面重新加载
       * 如果优化后的文件没有变化，即文件内容保持稳定，则可以避免重新加载页面
       * 页面重新加载是一个代价高昂的操作，特别是对于大型应用程序，它可能会显著影响用户体验
       *
       * 3. 通过比较文件哈希来判断是否需要重新加载
       * 通过比较优化前后文件的哈希值（fileHash），可以判断是否需要重新加载页面
       *    哈希值的作用:哈希值是文件内容的唯一标识符。
       *    如果文件内容没有变化，那么它们的哈希值也不会变化。通过比较哈希值，可以判断文件是否被修改
       *
       * 如果哈希值不同，说明文件内容发生了变化，需要重新加载页面
       * 如果哈希值相同，说明文件内容保持稳定，可以安全地保持当前的浏览器状态而无需重新加载页面
       */

      /** 决定是否需要重新加载页面 */
      const needsReload =
        // 如果有依赖项存在互操作性不匹配
        needsInteropMismatch.length > 0 ||
        //  如果优化前后的元数据哈希值不同
        metadata.hash !== newData.hash ||
        // 如果优化前后的依赖项文件哈希值不同
        Object.keys(metadata.optimized).some((dep) => {
          return (
            metadata.optimized[dep].fileHash !== newData.optimized[dep].fileHash
          );
        });

      /**
       * 该函数用于在依赖优化后处理和提交优化结果
       */
      const commitProcessing = async () => {
        // 等待 commit 方法完成
        // 这个方法可能会执行一些必要的操作，比如将优化结果保存到磁盘或更新缓存
        await processingResult.commit();

        /**
         * 在优化过程中，可能会发现新的依赖项。这里检查 metadata.discovered 中的所有依赖项
         * 如果这些依赖项不在 newData.optimized 中，则将它们添加到 newData 中
         */
        for (const id in metadata.discovered) {
          if (!newData.optimized[id]) {
            addOptimizedDepInfo(newData, "discovered", metadata.discovered[id]);
          }
        }

        // 如果不需要重新加载页面，函数会保持 browserHash 的稳定
        // browserHash 是一个用于标识浏览器状态的哈希值
        if (!needsReload) {
          // 为了避免页面重新加载时的状态丢失，newData 中的 browserHash 被设置为 metadata.browserHash 的值
          newData.browserHash = metadata.browserHash;

          // 更新 chunks 中的 browserHash
          for (const dep in newData.chunks) {
            // 对于每一个依赖项，它将 newData.chunks[dep].browserHash 设置为当前的 metadata.browserHash
            // 这保证了所有的 chunks 对象中的 browserHash 属性都与当前 metadata 保持一致
            newData.chunks[dep].browserHash = metadata.browserHash;
            /**
             * 如果不进行页面重新加载，我们需要保持 browserHash 的一致性，以便在页面保持当前状态时，浏览器能够正确识别和处理缓存的文件
             * 通过保持 browserHash 的一致，避免了因文件变更导致的缓存失效和页面状态丢失的问题
             */
          }

          // 更新 optimized 中的 browserHash
          for (const dep in newData.optimized) {
            newData.optimized[dep].browserHash = (
              metadata.optimized[dep] || metadata.discovered[dep]
            ).browserHash;
          }
        }

        // Commit hash and needsInterop changes to the discovered deps info
        // object. Allow for code to await for the discovered processing promise
        // and use the information in the same object
        /**
         * 这段代码的主要目的是将优化后的依赖项信息更新到 metadata.discovered 中
         */
        for (const o in newData.optimized) {
          // 对于每一个优化后的依赖项,检查 metadata.discovered 中是否存在相应的发现记录
          const discovered = metadata.discovered[o];
          if (discovered) {
            // 如果存在更新 浏览器哈希、文件哈希、

            const optimized = newData.optimized[o];
            discovered.browserHash = optimized.browserHash;
            discovered.fileHash = optimized.fileHash;
            // needsInterop 用于标识该依赖项是否需要模块间的互操作性处理
            discovered.needsInterop = optimized.needsInterop;
            // 设置为 undefined，以标记该依赖项的处理已完成
            discovered.processing = undefined;
          }
        }

        if (isRerun) {
          // 如果这是一次重新优化的运行(isRerun 为 true）

          // 这段代码会收集那些在 newData.optimized 中存在但在 metadata.optimized 中不存在的依赖项
          // 它将这些新发现的依赖项的标识符（dep）添加到 newDepsToLog 数组中
          newDepsToLog.push(
            ...Object.keys(newData.optimized).filter(
              (dep) => !metadata.optimized[dep]
            )
          );
          // 这些新发现的依赖项会被记录下来，以便后续处理和日志记录
          // 这样做可以帮助开发者跟踪和记录新发现的依赖项，方便调试和优化
        }

        // 更新 metadata
        metadata = depsOptimizer.metadata = newData;

        // 在优化依赖项的过程中，可能会有多个处理承诺排队等待。调用这个函数可以确保这些承诺被解决，
        // 使得相关的异步操作能够继续进行。这样可以确保整个依赖项优化流程的顺畅执行。
        resolveEnqueuedProcessingPromises();
      };

      // 这段代码是处理依赖优化完成后的逻辑
      // 主要目的是决定是否需要重新加载页面，并根据情况记录日志和处理发现的依赖项
      if (!needsReload) {
        // 如果优化后的结果表明不需要重新加载页面,调用 commitProcessing() 函数来提交当前优化的结果
        // 提交当前优化结果以更新 metadata，并确保在不需要页面重新加载的情况下保持最新的状态。
        await commitProcessing();

        // 处理非调试模式下的日志记录
        if (!debug) {
          /**
           * 在非调试模式下（debug 为 false），代码会设置一个定时器，来延迟记录新发现的依赖项，以避免过于频繁的日志记录。
           * 并提醒用户将这些依赖项添加到 optimizeDeps.include 中，以加速冷启动。
           */
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
          // 在调试模式下（debug 为 true），代码直接记录优化结果的信息，不进行延迟处理
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
        // 处理需要重新加载的情况

        // 检查是否发现了新依赖项
        if (newDepsDiscovered) {
          // There are newly discovered deps, and another rerun is about to be
          // executed. Avoid the current full reload discarding this rerun result
          // We don't resolve the processing promise, as they will be resolved
          // once a rerun is committed

          // 如果发现了新依赖项,则取消当前的处理结果
          processingResult.cancel();

          // 并标记需要推迟重新加载的操作
          debug?.(
            colors.green(
              `✨ delaying reload as new dependencies have been found...`
            )
          );
        } else {
          // 没有发现新依赖项

          // 提交处理结果
          await commitProcessing();

          // 记录日志
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

          // 处理 esmodule 合 cjs 混用问题
          if (needsInteropMismatch.length > 0) {
            // 记录警告信息，提示用户在 optimizeDeps.needsInterop 配置中添加这些模块，以加速冷启动。
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

          // 重新加载页面
          // 这通常在依赖项或配置发生重大变化时调用，以确保新的依赖项和优化结果被正确应用
          fullReload();
        }
      }
    } catch (e) {
      logger.error(
        colors.red(`error while updating dependencies:\n${e.stack}`),
        { timestamp: true, error: e }
      );

      // 调用函数来处理队列中等待处理的promise
      // 这确保即使在发生错误时，也能将相关的promise解决，防止程序陷入挂起状态
      resolveEnqueuedProcessingPromises();

      // 重置发现的依赖项
      // 处理错误后重置状态，以便服务器可以重新发现并处理依赖项。这防止了依赖项状态的污染和潜在的错误
      metadata.discovered = {};
    }

    // 设置为 false，表示当前的处理过程已完成或失败
    currentlyProcessing = false;
    // @ts-expect-error `enqueuedRerun` could exist because `debouncedProcessing` may run while awaited
    // 处理可能存在的排队任务，以确保所有任务都得到适当处理。
    enqueuedRerun?.();
  }

  /**
   * 用于触发浏览器的全页面重载
   */
  function fullReload() {
    // Cached transform results have stale imports (resolved to
    // old locations) so they need to be invalidated before the page is
    // reloaded.
    // 失效化所有缓存的模块
    // 这是因为在全页面重载之前，需要确保所有的缓存都被清除，以防止旧的模块信息影响新的页面加载
    server.moduleGraph.invalidateAll();

    // 发送一个 full-reload 类型的消息到客户端。这个消息会通知浏览器执行全页面重载操作
    // 通知浏览器重新加载页面，从而应用最新的模块和依赖项
    server.hot.send({
      type: "full-reload",
      path: "*",
    });
  }

  /**
   * 用于在发现新的依赖项之后，重新运行依赖优化器
   * 它会在当前的依赖优化处理完成后，发起新的优化过程以处理包括旧的和新的依赖项
   */
  async function rerun() {
    // debounce time to wait for new missing deps finished, issue a new
    // optimization of deps (both old and newly found) once the previous
    // optimizeDeps processing is finished
    /**
     * 这段注释描述了 rerun 函数的作用
     * 它指出了函数的两个主要功能：延迟处理新依赖项和重新优化所有依赖项
     *
     * 1. 去抖动时间 (debounce time):
     * 在处理新发现的缺失依赖项时，rerun 函数会等待一段时间，
     * 以确保所有新依赖项的处理都已完成。这段时间被称为“去抖动时间”
     * 目的是避免在依赖项处理过程中频繁地重新优化，确保只有在所有缺失的依赖项都被发现后才重新运行优化过程
     *
     * rerun 函数会触发 runOptimizer 函数，而去抖动的时间实际上是在 runOptimizer 调用之前通过其他机制来控制的
     * 下面代码中的 debouncedProcessing 函数就是来实现防抖的
     *
     * 2. 优化依赖项:
     * 一旦去抖动时间结束，rerun 函数会触发一个新的优化过程，来处理包括旧的和新发现的所有依赖项
     * 这保证了在每次依赖项优化后，所有依赖项（无论是之前的还是新发现的）都被适当地优化，以保持应用程序的最新状态和性能
     *
     */

    // 获取当前发现的新依赖项列表
    const deps = Object.keys(metadata.discovered);
    const depsString = depsLogString(deps);
    // 通过 debug 记录新发现的依赖项信息
    debug?.(colors.green(`new dependencies found: ${depsString}`));
    // 重新运行依赖优化器,这会触发新的优化过程，以处理当前和新的依赖项
    runOptimizer();
  }

  /**
   * 用于生成一个哈希值，以标识某一时刻的发现的依赖项和缺失项的状态
   * 这个哈希值可以用来检查和比较依赖项的状态是否发生了变化，从而决定是否需要重新加载页面或执行其他操作
   * @param hash
   * @param deps
   * @param missing
   * @returns
   */
  function getDiscoveredBrowserHash(
    hash: string,
    deps: Record<string, string>,
    missing: Record<string, string>
  ) {
    // 通过将这些信息转换为 JSON 字符串并拼接起来，可以确保即使是微小的变化也会导致哈希值的变化，从而准确地反映出依赖项的状态
    return getHash(
      hash + JSON.stringify(deps) + JSON.stringify(missing) + sessionTimestamp
    );
  }

  /**
   * 函数的目的是处理和注册缺失的导入依赖，并在依赖被发现时更新相关的元数据
   * 这个函数主要用于在依赖项被发现或处理时，确保所有依赖项都被适当管理，并避免过早的页面重载
   * @param id 依赖项的标识符（通常是模块的路径或名称）
   * @param resolved 依赖项的解析路径或文件系统中的实际路径
   * @returns
   */
  function registerMissingImport(
    id: string,
    resolved: string
  ): OptimizedDepInfo {
    // 首先检查 metadata.optimized 中是否已经有这个依赖项,有的话直接返回这个优化后的依赖项
    const optimized = metadata.optimized[id];
    if (optimized) {
      return optimized;
    }

    // 如果在 metadata.chunks 中找到这个依赖项，说明它是一个已经处理过的块（chunk），也返回它
    const chunk = metadata.chunks[id];
    if (chunk) {
      return chunk;
    }

    // 检查发现的缺失依赖项
    let missing = metadata.discovered[id];
    if (missing) {
      // 说明这个依赖项已经被发现，它将在下一次重新运行调用中处理
      // 返回这个缺失的依赖项
      return missing;
    }

    // 如果没有找到这个依赖项，将其添加到 metadata.discovered 中
    // addMissingDep 函数的作用是将缺失的依赖项记录到元数据中
    missing = addMissingDep(id, resolved);

    // Until the first optimize run is called, avoid triggering processing
    // We'll wait until the user codebase is eagerly processed by Vite so
    // we can get a list of every missing dependency before giving to the
    // browser a dependency that may be outdated, thus avoiding full page reloads
    /**
     * 这段注释解释了 registerMissingImport 函数中的一个关键逻辑，用于避免在第一次优化运行之前触发处理
     * 其主要目的是在 Vite 完成对用户代码的预处理之前，收集所有缺失的依赖项，
     * 以便在处理这些依赖项时避免旧的、不完整的依赖项被提供给浏览器，从而避免不必要的全页重载
     */

    //  判断是否需要等待所有依赖项被发现,表示是否正在等待 Vite 完成对用户代码的预处理
    if (!waitingForCrawlEnd) {
      // 在 debouncedProcessing 函数中设置延迟时间，以便在新依赖项被发现后，等待一段时间再触发优化处理
      // 这确保了在处理依赖项之前可以发现和注册更多的缺失依赖项，避免了因处理过早而导致的页面重载问题
      debouncedProcessing();
    }

    // 返回优化包的路径，在运行esbuild生成预包之前，这个路径是已知的
    return missing;
  }

  /**
   * 这个函数的目的是将一个新的缺失依赖项添加到 metadata 中，
   * 标记为发现的依赖项，并提供必要的信息，以便后续优化处理
   * @param id
   * @param resolved
   * @returns
   */
  function addMissingDep(id: string, resolved: string) {
    // 表示发现了新的依赖项，这可能会影响优化过程的行为
    newDepsDiscovered = true;

    // 添加新的依赖项信息:
    return addOptimizedDepInfo(metadata, "discovered", {
      id, // 依赖项的唯一标识符
      file: getOptimizedDepPath(id, config, ssr), // 依赖项在优化后的路径
      src: resolved, // 解析后的依赖项路径
      /**
       * 这是为缺失的依赖项生成的一个哈希值，唯一标识当前状态下的已知和缺失依赖项
       * 这种哈希值是通过结合当前的 metadata.hash 和依赖项的已知及发现的状态来生成的
       *
       * 如果优化依赖项的过程中，已知依赖项的打包文件没有发生变化，那么这个 browserHash 仍然有效
       * 也就是说，浏览器可以继续使用现有的状态而不需要进行全页重载
       * 只有当 browserHash 发生变化时，才需要触发全页重载，以保证浏览器中加载的资源是最新的
       */
      browserHash: getDiscoveredBrowserHash(
        metadata.hash,
        depsFromOptimizedDepInfo(metadata.optimized),
        depsFromOptimizedDepInfo(metadata.discovered)
      ),
      // 在依赖项被标记为缺失后，可能需要一些时间来处理和优化这个依赖项
      // processing promise 允许代码等待这个处理操作的完成，确保依赖项在被使用之前已经被正确地处理和优化
      processing: depOptimizationProcessing.promise,
      // 从依赖项的源代码中提取的导出数据
      exportsData: extractExportsData(resolved, config, ssr),
    });
  }

  /**
   * 它用于控制依赖项优化的触发频率，确保在一定时间内只执行一次优化操作，从而避免频繁触发优化过程
   * 这里就是rerun 执行的防抖时间
   * @param timeout
   */
  function debouncedProcessing(timeout = debounceMs) {
    enqueuedRerun = undefined;
    // 如果已经存在一个防抖定时器，它将被清除
    if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle);
    // 如果有日志相关的定时器存在，也会被清除
    if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle);

    newDepsToLogHandle = undefined;
    // 设置一个新的防抖定时器
    debounceProcessingHandle = setTimeout(() => {
      debounceProcessingHandle = undefined;
      enqueuedRerun = rerun;
      if (!currentlyProcessing) {
        // 在当前没有处理的情况下,调用 rerun
        enqueuedRerun();
      }
    }, timeout);
  }

  /**
   * 这个 onCrawlEnd 函数在 Vite 的开发服务器启动时被调用,
   * 它会在服务器启动并且所有静态导入（static imports）在第一次请求之后都被爬取（crawled）完成时触发
   *
   * 静态导入
   *    import x from 'module'
   *    onCrawlEnd 会处理所有这些静态导入的爬取完成后的逻辑
   * 动态导入
   *    import('module')
   *    如果浏览器立即请求动态导入，onCrawlEnd 也可能处理这些动态导入的爬取
   *
   * 在 onCrawlEnd 被调用时，意味着所有静态导入和（可能的）动态导入都已经被爬取，确保在后续的优化和处理过程中可以获得完整的依赖项信息
   * 这个函数负责检查依赖项的变化，并根据扫描和爬取的结果决定是否需要重新优化依赖项
   *
   * @returns
   */
  async function onCrawlEnd() {
    // 在爬取结束后，函数会切换到简单的防抖策略，避免在短时间内重复触发优化过程
    waitingForCrawlEnd = false;

    debug?.(colors.green(`✨ static imports crawl ended`));
    if (closed) {
      return;
    }

    // 等待依赖优化器的扫描和优化步骤完成。这通常在爬取用户代码的同时进行。
    await depsOptimizer.scanProcessing;

    // 如果有优化结果，并且配置允许发现新的依赖项，函数将处理这些结果
    if (optimizationResult && !config.optimizeDeps.noDiscovery) {
      // In the holdUntilCrawlEnd strategy, we don't release the result of the
      // post-scanner optimize step to the browser until we reach this point
      // If there are new dependencies, we do another optimize run, if not, we
      // use the post-scanner optimize result
      // If holdUntilCrawlEnd is false and we reach here, it means that the
      // scan+optimize step finished after crawl end. We follow the same
      // process as in the holdUntilCrawlEnd in this case.
      /**
       * 这段注释解释了 holdUntilCrawlEnd 策略的工作原理，以及在不同情况下的处理方式
       *
       * 1. holdUntilCrawlEnd 策略:
       *    1) 在 holdUntilCrawlEnd 策略中，扫描器（scanner）完成优化步骤的结果不会立即发布给浏览器，
       *    而是等待到达指定点（即爬取结束）后才发布
       *    2) 这样可以确保在爬取过程中发现的新依赖项能够被捕捉到，并在最终发布给浏览器之前进行处理
       *
       * 2. 处理新依赖项:
       *    1) 如果在爬取过程中发现了新依赖项，则会重新进行一次优化运行（optimize run）以确保这些新依赖项被包含在内
       *    2) 如果没有发现新依赖项，则直接使用扫描器的优化结果
       *
       * 3. holdUntilCrawlEnd 为 false 的情况:
       *    1) 如果 holdUntilCrawlEnd 为 false，并且扫描和优化步骤在爬取结束后才完成，
       *    那么我们仍然会按照 holdUntilCrawlEnd 策略的处理方式来处理
       *    2) 我们会检查是否有新的依赖项，如果有则重新进行优化运行，如果没有则使用现有的优化结果
       */

      // 提取扫描结果
      const afterScanResult = optimizationResult.result;
      // 设置为 undefined 表示我们将使用这个结果
      optimizationResult = undefined;

      // 等待 afterScanResult 的异步操作完成，获取最终的 result。
      const result = await afterScanResult;
      // 设为 false，表示当前的处理过程已经结束
      currentlyProcessing = false;

      // 在爬取过程中发现的依赖项
      const crawlDeps = Object.keys(metadata.discovered);
      // 扫描器扫描出的优化依赖项
      const scanDeps = Object.keys(result.metadata.optimized);

      if (scanDeps.length === 0 && crawlDeps.length === 0) {
        // 如果扫描和爬取过程中都没有发现任何依赖项，输出调试信息表示没有发现依赖项
        debug?.(
          colors.green(
            `✨ no dependencies found by the scanner or crawling static imports`
          )
        );

        // 即使没有发现任何依赖项，我们仍然会提交结果，以确保在下次冷启动时扫描器不会再次运行。
        // 这对于没有依赖项的项目尤为重要。(避免在没有依赖项的项目中浪费资源重新运行扫描器)

        // 开始处理下一个发现的批次
        startNextDiscoveredBatch();
        // 随后运行优化器
        runOptimizer(result);
        return;
      }

      // 检查 needsInterop 不匹配:
      const needsInteropMismatch = findInteropMismatches(
        metadata.discovered,
        result.metadata.optimized
      );

      // 检查扫描器遗漏的依赖:
      const scannerMissedDeps = crawlDeps.some(
        // 通过检查 crawlDeps（爬取过程中发现的依赖）中是否有不在 scanDeps（扫描器优化的依赖）中的依赖，来判断扫描器是否遗漏了某些依赖
        (dep) => !scanDeps.includes(dep)
      );

      // 判断优化结果是否过时:
      const outdatedResult =
        needsInteropMismatch.length > 0 || scannerMissedDeps;

      if (outdatedResult) {
        // 表示优化结果过时，需要重新优化以避免完整的页面重载
        // 取消当前的扫描结果,，并执行新的优化以避免完全重新加载
        result.cancel();

        // 遍历扫描器发现的所有依赖
        for (const dep of scanDeps) {
          // 检查扫描器发现的依赖是否在爬取过程中也发现了。如果没有，则说明这是一个新依赖
          if (!crawlDeps.includes(dep)) {
            // 对于每一个新的依赖，调用 addMissingDep 函数将其添加到缺失的依赖中。
            addMissingDep(dep, result.metadata.optimized[dep].src!);
          }
        }

        // 处理扫描器遗漏的依赖:
        if (scannerMissedDeps) {
          debug?.(
            colors.yellow(
              `✨ new dependencies were found while crawling that weren't detected by the scanner`
            )
          );
        }
        debug?.(colors.green(`✨ re-running optimizer`));
        // 传入0,表示立即重新运行优化器：
        debouncedProcessing(0);
      } else {
        // 没有过时

        // 这条信息表明，扫描器找到了所有使用的依赖，并将使用扫描后的优化结果
        debug?.(
          colors.green(
            `✨ using post-scan optimizer result, the scanner found every used dependency`
          )
        );

        // 启动处理下一个发现的依赖批处理
        startNextDiscoveredBatch();

        // 运行优化器:
        runOptimizer(result);
      }
    } else if (!holdUntilCrawlEnd) {
      // 表示在爬取结束之前，优化结果已经发布给浏览器

      // The post-scanner optimize result has been released to the browser
      // If new deps have been discovered, issue a regular rerun of the
      // optimizer. A full page reload may still be avoided if the new
      // optimize result is compatible in this case
      if (newDepsDiscovered) {
        // 如果在爬取静态导入时发现了新的依赖

        debug?.(
          colors.green(
            `✨ new dependencies were found while crawling static imports, re-running optimizer`
          )
        );
        // 设置警告标志，表示有未包含在优化中的依赖
        warnAboutMissedDependencies = true;
        // 立即重新运行优化器
        debouncedProcessing(0);
      }
    } else {
      // 表示在爬取结束之前没有发布优化结果

      // 获取爬取过程中发现的所有依赖
      const crawlDeps = Object.keys(metadata.discovered);
      // 标记当前没有正在处理的任务
      currentlyProcessing = false;

      if (crawlDeps.length === 0) {
        // 如果没有发现任何依赖
        debug?.(
          colors.green(
            `✨ no dependencies found while crawling the static imports`
          )
        );
        // 标记第一次运行已被调用
        firstRunCalled = true;
      }

      // queue the first optimizer run, even without deps so the result is cached
      // 即使没有发现任何依赖，也将第一次优化器运行排队，以确保结果被缓存。
      debouncedProcessing(0);
    }
  }
}

/**
 * 函数的主要功能是检测和标记在 discovered 和 optimized 依赖信息中存在的模块间的互操作性不匹配问题
 * 主要是处理 esm 与 cjs 混用的情况
 * @param discovered 记录了所有发现的依赖项信息的对象
 * @param optimized 记录了所有优化后的依赖项信息的对象
 * @returns
 */
function findInteropMismatches(
  discovered: Record<string, OptimizedDepInfo>,
  optimized: Record<string, OptimizedDepInfo>
) {
  // 存储所有存在互操作性不匹配的依赖项的 ID
  const needsInteropMismatch = [];

  // 遍历发现的依赖项:
  for (const dep in discovered) {
    // 获取发现依赖项的信息
    const discoveredDepInfo = discovered[dep];
    // 获取优化后的信息
    const depInfo = optimized[dep];

    if (depInfo) {
      if (
        // 不为 undefined 即这个依赖项在发现时标记了互操作性需求
        discoveredDepInfo.needsInterop !== undefined &&
        // 检查 depInfo.needsInterop 是否与之相匹配,如果不匹配，则说明存在互操作性不匹配的情况
        depInfo.needsInterop !== discoveredDepInfo.needsInterop
      ) {
        // optimizeDeps.needsInterop: Vite 配置中的一个选项，用于指定哪些模块需要互操作性处理
        // 它告诉 Vite 对于某些依赖项，在优化过程中需要特别的处理，以确保它们能正确地与其他模块配合使用

        // 如果一个混合了 ESM 和 CJS 语法的模块没有被明确添加到 optimizeDeps.needsInterop 中，
        // Vite 可能不会应用必要的互操作性处理，这可能导致优化后的模块和原始模块之间的不一致。
        needsInteropMismatch.push(dep);
        debug?.(colors.cyan(`✨ needsInterop mismatch detected for ${dep}`));
      }
    }
  }
  return needsInteropMismatch;
}
