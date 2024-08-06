import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import getEtag from "etag";
import MagicString from "magic-string";
import { init, parse as parseImports } from "es-module-lexer";
import type { PartialResolvedId, SourceDescription, SourceMap } from "rollup";
import colors from "picocolors";
import type { ModuleNode, ViteDevServer } from "..";
import {
  createDebugger,
  ensureWatchedFile,
  injectQuery,
  isObject,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  stripBase,
  timeFrom,
} from "../utils";
import { checkPublicFile } from "../publicDir";
// import { isDepsOptimizerEnabled } from "../config";
import {
  getDepsOptimizer,
  // initDevSsrDepsOptimizer
} from "../optimizer";
import { cleanUrl, unwrapId } from "../../shared/utils";
import {
  applySourcemapIgnoreList,
  extractSourcemapFromFile,
  injectSourcesContent,
} from "./sourcemap";
// import { isFileServingAllowed } from "./middlewares/static";
import { throwClosedServerError } from "./pluginContainer";

export const ERR_LOAD_URL = "ERR_LOAD_URL";
export const ERR_LOAD_PUBLIC_URL = "ERR_LOAD_PUBLIC_URL";

const debugLoad = createDebugger("vite:load");
const debugTransform = createDebugger("vite:transform");
const debugCache = createDebugger("vite:cache");

export interface TransformOptions {
  ssr?: boolean;
  html?: boolean;
}
export interface TransformResult {
  code: string;
  map: SourceMap | { mappings: "" } | null;
  etag?: string;
  deps?: string[];
  dynamicDeps?: string[];
}

/**
 * 用于处理请求并进行模块转换
 * @param url 要转换的模块的 URL
 * @param server Vite 服务器实例
 * @param options
 * @returns
 */
export function transformRequest(
  url: string,
  server: ViteDevServer,
  options: TransformOptions = {}
): Promise<TransformResult | null> {
  // 检查服务器是否处于重新启动状态，如果是且 ssr 选项未指定，则抛出错误
  if (server._restartPromise && !options.ssr) throwClosedServerError();

  // 根据 ssr 和 html 选项生成一个唯一的缓存键
  const cacheKey = (options.ssr ? "ssr:" : options.html ? "html:" : "") + url;

  /**
   * 模块可能在处理过程中无效化：
   *    场景：在发现缺少的依赖后重新处理预打包的依赖时，可能需要完全重新加载页面
   *    处理方式：保存当前时间戳，用于与最后一次无效化的时间进行比较，
   *    以确定是缓存转换结果还是将其丢弃为过期的
   *
   * 模块无效化的原因：
   *    1. 预打包新发现依赖：由于重新处理预打包的依赖，可能需要完全重新加载页面
   *    2. 配置更改后完全重新加载：配置更改后，可能需要完全重新加载页面
   *    3. 生成模块的文件发生变化：文件发生变化后，生成的模块可能无效化
   *    4. 虚拟模块的无效化：虚拟模块的无效化
   *
   * 处理流程：
   *    场景 1 和 2：在无效化后，浏览器重新加载页面时，会发出新的请求
   *    场景 3 和 4：由于热模块替换 (HMR) 的处理，可能不会立即发出新的请求
   *
   * 解决方法：
   *    无论是哪种情况，下次请求这个模块时，都应该重新处理
   *    时间戳比较：保存开始处理时的时间戳，并与模块最后无效化的时间戳进行比较
   *
   * 这些注释说明了处理模块转换时需要考虑的各种无效化场景，并解释了通过时间戳比较来确保模块在无效化后得到正确处理的方法
   * 这样可以确保转换结果的有效性，并在必要时重新处理模块，以保持系统的正确性和一致性
   */

  // 时间戳
  const timestamp = Date.now();

  // 检查是否有挂起的请求
  const pending = server._pendingRequests.get(cacheKey);
  if (pending) {
    // 检查模块是否在请求挂起期间被无效化

    // 调用 getModuleByUrl 检查模块是否存在
    return server.moduleGraph
      .getModuleByUrl(removeTimestampQuery(url), options.ssr)
      .then((module) => {
        // 检查模块无效化状态
        if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
          /**
           * 1. 如果 module 不存在，表示模块还没有被处理过，因此可以继续处理挂起的请求
           *
           * 2. 如果挂起请求的时间戳（pending.timestamp）晚于模块的最后无效化时间戳（module.lastInvalidationTimestamp）
           * 则表示挂起的请求仍然有效，可以安全地重用挂起请求的结果
           */
          return pending.request;
        } else {
          // 请求无效化处理：

          /**
           * 如果挂起请求的时间戳早于模块的最后无效化时间戳，表示在请求挂起期间，模块已经被无效化。
           * 调用 pending.abort() 中止挂起请求并清除缓存
           * 重新调用 transformRequest 执行新的转换请求
           */
          // Request 1 for module A     (pending.timestamp)
          // Invalidate module A        (module.lastInvalidationTimestamp)
          // Request 2 for module A     (timestamp)

          pending.abort();
          return transformRequest(url, server, options);
        }
      });
  }

  // 执行实际的转换操作
  const request = doTransform(url, server, options, timestamp);

  // 缓存管理
  // 避免在中止后清除未来请求的缓存
  let cleared = false;

  // 定义一个清除缓存的函数，并在请求完成后清除缓存
  const clearCache = () => {
    if (!cleared) {
      server._pendingRequests.delete(cacheKey);
      cleared = true;
    }
  };

  // 将当前请求缓存，以便在请求完成后可以清除缓存
  server._pendingRequests.set(cacheKey, {
    request,
    timestamp,
    abort: clearCache,
  });

  return request.finally(clearCache);
}

/**
 * 用于处理请求的模块转换
 * @param url 请求的模块 URL
 * @param server ViteDevServer 实例
 * @param options 转换选项
 * @param timestamp 当前时间戳，用于比较模块的无效化状态
 * @returns
 */
async function doTransform(
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number
) {
  // 移除时间戳查询参数
  url = removeTimestampQuery(url);

  const { config, pluginContainer } = server;
  const ssr = !!options.ssr;

  // 如果启用了 SSR 依赖优化器，则初始化它
  if (ssr && isDepsOptimizerEnabled(config, true)) {
    // await initDevSsrDepsOptimizer(config, server);
  }

  // 获取模块
  let module = await server.moduleGraph.getModuleByUrl(url, ssr);
  if (module) {
    // 如果模块存在，尝试使用缓存的转换结果
    const cached = await getCachedTransformResult(
      url,
      module,
      server,
      ssr,
      timestamp
    );
    if (cached) return cached;
  }

  const resolved = module
    ? undefined
    : (await pluginContainer.resolveId(url, undefined, { ssr })) ?? undefined;

  // 如果模块不存在，使用插件容器解析 ID，否则使用url
  const id = module?.id ?? resolved?.id ?? url;

  module ??= server.moduleGraph.getModuleById(id);
  if (module) {
    // 确保 URL 与模块 ID 关联。如果模块已经存在，这一步可以更新模块信息或者创建新的模块关联
    await server.moduleGraph._ensureEntryFromUrl(url, ssr, undefined, resolved);

    // 如果找到了缓存结果，直接返回，不再进行后续的加载和转换
    const cached = await getCachedTransformResult(
      url,
      module,
      server,
      ssr,
      timestamp
    );
    if (cached) return cached;
  }

  // 调用 loadAndTransform 函数加载并转换模块，这里是真正的模块转换
  const result = loadAndTransform(
    id,
    url,
    server,
    options,
    timestamp,
    module,
    resolved
  );

  if (!ssr) {
    // 注册客户端请求
    /**
     * 为什么要做这一步？
     *
     * 1. 减少重复处理：
     *      当客户端请求模块时，如果模块已经被优化处理过（例如已经被编译、压缩、拆分等），
     *      就不需要再次进行相同的处理，因为这些处理可能会消耗大量的计算资源和时间。
     *
     * 2. 提高性能：
     *      注册请求处理的目的是为了确保在未优化处理的情况下，只有第一个请求会执行加载和转换过程。
     *      对于后续的相同模块请求，直接返回已经处理好的结果，节省了重新处理的时间，从而提高了客户端的加载速度和响应性能。
     */
    // 获取依赖优化器实例
    const depsOptimizer = getDepsOptimizer(config, ssr);
    // // 如果依赖优化器存在且当前模块文件未被优化，则注册请求处理
    if (!depsOptimizer?.isOptimizedDepFile(id)) {
      // 注册请求处理函数。此函数将确保在模块请求过程中处理模块的转换结果

      // 这里的函数很重要，会在扫描完用户代码后在执行一次，这样就会依赖会commit，将临时目录重命名
      server._registerRequestProcessing(id, () => result);
    }
  }

  return result;
}

/**
 * 用于获取缓存的转换结果.
 *
 * @param url
 * @param module
 * @param server
 * @param ssr
 * @param timestamp
 * @returns
 */
async function getCachedTransformResult(
  url: string,
  module: ModuleNode,
  server: ViteDevServer,
  ssr: boolean,
  timestamp: number
) {
  const prettyUrl = debugCache ? prettifyUrl(url, server.config.root) : "";

  /**
   * 首先，通过 handleModuleSoftInvalidation 函数尝试对模块进行软失效处理。
   * 软失效处理是一种机制，用于检查模块是否因为某些变化而需要重新处理，但并不强制重新加载。
   * 如果成功进行了软失效处理，说明模块可能已经发生了变化，需要重新处理。
   * 如果成功处理了软失效，将返回处理后的结果，并打印调试信息。
   */
  const softInvalidatedTransformResult =
    module &&
    (await handleModuleSoftInvalidation(module, ssr, timestamp, server));
  if (softInvalidatedTransformResult) {
    debugCache?.(`[memory-hmr] ${prettyUrl}`);
    return softInvalidatedTransformResult;
  }

  // 如果没有进行软失效处理或者处理后没有得到有效的结果，接着检查模块是否有缓存的转换结果
  const cached =
    module && (ssr ? module.ssrTransformResult : module.transformResult);
  if (cached) {
    debugCache?.(`[memory] ${prettyUrl}`);
    return cached;
  }
}

/**
 * 这段代码实现了 Vite 开发服务器中模块加载和转换的核心流程
 * @param id
 * @param url
 * @param server
 * @param options
 * @param timestamp
 * @param mod
 * @param resolved
 * @returns
 */
async function loadAndTransform(
  id: string,
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number,
  mod?: ModuleNode,
  resolved?: PartialResolvedId
) {
  // 准备工作，获取配置、插件容器、模块图
  const { config, pluginContainer, moduleGraph } = server;
  const { logger } = config;
  const prettyUrl =
    debugLoad || debugTransform ? prettifyUrl(url, config.root) : "";
  const ssr = !!options.ssr;

  // 使用 cleanUrl 函数清理模块的 id，生成文件路径 file
  const file = cleanUrl(id);

  // 用于存储加载的模块代码
  let code: string | null = null;
  // 用于存储加载的源映射信息 sourcemap
  let map: SourceDescription["map"] = null;

  // 加载过程
  // 如果启用了调试加载，记录加载开始时间
  const loadStart = debugLoad ? performance.now() : 0;
  // 调用插件容器的 load 方法加载指定 id 的模块
  const loadResult = await pluginContainer.load(id, { ssr });
  if (loadResult == null) {
    // 如果是 HTML 请求并且没有加载结果，并且不是以 .html 结尾的文件，则跳过到单页应用 (SPA) 的回退处理。
    if (options.html && !id.endsWith(".html")) {
      return null;
    }
    // try fallback loading it from fs as string
    // if the file is a binary, there should be a plugin that already loaded it
    // as string
    // only try the fallback if access is allowed, skip for out of root url
    // like /service-worker.js or /api/users

    // 如果允许服务器端渲染 (ssr) 或文件服务允许
    // if (options.ssr || isFileServingAllowed(file, server)) {
    if (options.ssr || true) {
      try {
        // 取到文件内容
        code = await fsp.readFile(file, "utf-8");
        // 记录调试信息
        debugLoad?.(`${timeFrom(loadStart)} [fs] ${prettyUrl}`);
      } catch (e) {
        if (e.code !== "ENOENT") {
          if (e.code === "EISDIR") {
            e.message = `${e.message} ${file}`;
          }
          throw e;
        }
      }
      if (code != null) {
        // 确保文件被监视
        ensureWatchedFile(server.watcher, file, config.root);
      }
    }
    if (code) {
      try {
        // 从文件中提取源映射信息 source map
        const extracted = await extractSourcemapFromFile(code, file);
        if (extracted) {
          code = extracted.code;
          map = extracted.map;
        }
      } catch (e) {
        // source map 加载失败
        logger.warn(`Failed to load source map for ${file}.\n${e}`, {
          timestamp: true,
        });
      }
    }
  } else {
    // 存在加载结果
    debugLoad?.(`${timeFrom(loadStart)} [plugin] ${prettyUrl}`);
    if (isObject(loadResult)) {
      code = loadResult.code;
      map = loadResult.map;
    } else {
      code = loadResult;
    }
  }

  if (code == null) {
    // 表示无法从插件或文件系统中加载到有效的模块内容

    // 检查当前 url 是否属于公共文件
    const isPublicFile = checkPublicFile(url, config);

    /**
     * 根据检查结果，生成相应的错误消息
     *      如果是公共文件 (isPublicFile)，说明该文件将在构建期间直接复制而不经过插件转换，
     *      因此不应从源代码中导入，只能通过 HTML 标签引用。
     *
     *      否则，错误消息表示文件不存在或无法加载。
     */
    let publicDirName = path.relative(config.root, config.publicDir);
    if (publicDirName[0] !== ".") publicDirName = "/" + publicDirName;
    const msg = isPublicFile
      ? `This file is in ${publicDirName} and will be copied as-is during ` +
        `build without going through the plugin transforms, and therefore ` +
        `should not be imported from source code. It can only be referenced ` +
        `via HTML tags.`
      : `Does the file exist?`;

    // 获取导入者模块 (importerMod)，即导致加载失败的模块
    const importerMod: ModuleNode | undefined = server.moduleGraph.idToModuleMap
      .get(id)
      ?.importers.values()
      .next().value;
    const importer = importerMod?.file || importerMod?.url;
    // 构建错误对象 ，包括加载失败的详细信息和错误代码
    const err: any = new Error(
      `Failed to load url ${url} (resolved id: ${id})${
        importer ? ` in ${importer}` : ""
      }. ${msg}`
    );
    err.code = isPublicFile ? ERR_LOAD_PUBLIC_URL : ERR_LOAD_URL;

    // 抛出错误 (throw err)，中断加载流程并显示错误信息。
    throw err;
  }

  // 服务器重启检查，为了防止在服务器正在重启时继续处理客户端请求
  if (server._restartPromise && !ssr) throwClosedServerError();

  // 确保模块已经在模块图中注册
  mod ??= await moduleGraph._ensureEntryFromUrl(url, ssr, undefined, resolved);

  // 模块转换的核心逻辑
  // 记录转换开始的时间
  const transformStart = debugTransform ? performance.now() : 0;
  // 使用插件容器的 transform方法对code 进行转换
  const transformResult = await pluginContainer.transform(code, id, {
    inMap: map,
    ssr,
  });
  // 保存原始的code
  const originalCode = code;
  if (
    transformResult == null ||
    (isObject(transformResult) && transformResult.code == null)
  ) {
    // 表示没有应用任何转换，保持 code 不变。
    debugTransform?.(
      timeFrom(transformStart) + colors.dim(` [skipped] ${prettyUrl}`)
    );
  } else {
    // 应用了转换，更新 code 和 map 为 transformResult 的值
    debugTransform?.(`${timeFrom(transformStart)} ${prettyUrl}`);
    code = transformResult.code!;
    map = transformResult.map;
  }

  let normalizedMap: SourceMap | { mappings: "" } | null;
  if (typeof map === "string") {
    normalizedMap = JSON.parse(map);
  } else if (map) {
    normalizedMap = map as SourceMap | { mappings: "" };
  } else {
    normalizedMap = null;
  }

  if (normalizedMap && "version" in normalizedMap && mod.file) {
    // 存在有效的 normalizedMap，且模块具有文件 (mod.file)

    // 包含映射信息 (mappings)
    if (normalizedMap.mappings) {
      // 注入源内容
      await injectSourcesContent(normalizedMap, mod.file, logger);
    }

    // 构建源码映射文件的路径
    const sourcemapPath = `${mod.file}.map`;
    // 应用源映射忽略列表
    applySourcemapIgnoreList(
      normalizedMap,
      sourcemapPath,
      config.server.sourcemapIgnoreList,
      logger
    );

    // 如果模块文件路径是绝对路径
    if (path.isAbsolute(mod.file)) {
      let modDirname;

      // 遍历 normalizedMap.sources
      for (
        let sourcesIndex = 0;
        sourcesIndex < normalizedMap.sources.length;
        ++sourcesIndex
      ) {
        const sourcePath = normalizedMap.sources[sourcesIndex];
        if (sourcePath) {
          // 将源路径 (sourcePath) 转换为相对路径，以便调试器能够正确解析和显示
          if (path.isAbsolute(sourcePath)) {
            modDirname ??= path.dirname(mod.file);
            normalizedMap.sources[sourcesIndex] = path.relative(
              modDirname,
              sourcePath
            );
          }
        }
      }
    }
  }

  // 检查服务器状态，防止在服务器重启期间处理请求
  if (server._restartPromise && !ssr) throwClosedServerError();

  // 生成转换结果
  const result =
    ssr && !server.config.experimental.skipSsrTransform
      ? // 如果是 SSR 模式并且未设置跳过 SSR 转换，进行 ssr 转换
        await server.ssrTransform(code, normalizedMap, url, originalCode)
      : // 生成一个普通的转换结果对象
        ({
          code,
          map: normalizedMap,
          etag: getEtag(code, { weak: true }),
        } satisfies TransformResult);

  // 只有当模块在处理时没有失效时才缓存结果，因此如果它是过时的，下一次将重新处理它

  if (timestamp > mod.lastInvalidationTimestamp)
    // 只有当当前模块的最后一次无效化时间 (mod.lastInvalidationTimestamp) 小于当前处理开始时的时间戳 (timestamp) 时，才更新模块的转换结果缓存
    moduleGraph.updateModuleTransformResult(mod, result, ssr);

  return result;
}

async function handleModuleSoftInvalidation(
  mod: ModuleNode,
  ssr: boolean,
  timestamp: number,
  server: ViteDevServer
) {
  const transformResult = ssr
    ? mod.ssrInvalidationState
    : mod.invalidationState;

  // Reset invalidation state
  if (ssr) mod.ssrInvalidationState = undefined;
  else mod.invalidationState = undefined;

  // Skip if not soft-invalidated
  if (!transformResult || transformResult === "HARD_INVALIDATED") return;

  if (ssr ? mod.ssrTransformResult : mod.transformResult) {
    throw new Error(
      `Internal server error: Soft-invalidated module "${mod.url}" should not have existing transform result`
    );
  }

  let result: TransformResult;
  // For SSR soft-invalidation, no transformation is needed
  if (ssr) {
    result = transformResult;
  }
  // For client soft-invalidation, we need to transform each imports with new timestamps if available
  else {
    await init;
    const source = transformResult.code;
    const s = new MagicString(source);
    const [imports] = parseImports(source, mod.id || undefined);

    for (const imp of imports) {
      let rawUrl = source.slice(imp.s, imp.e);
      if (rawUrl === "import.meta") continue;

      const hasQuotes = rawUrl[0] === '"' || rawUrl[0] === "'";
      if (hasQuotes) {
        rawUrl = rawUrl.slice(1, -1);
      }

      const urlWithoutTimestamp = removeTimestampQuery(rawUrl);
      // hmrUrl must be derived the same way as importAnalysis
      const hmrUrl = unwrapId(
        stripBase(removeImportQuery(urlWithoutTimestamp), server.config.base)
      );
      for (const importedMod of mod.clientImportedModules) {
        if (importedMod.url !== hmrUrl) continue;
        if (importedMod.lastHMRTimestamp > 0) {
          const replacedUrl = injectQuery(
            urlWithoutTimestamp,
            `t=${importedMod.lastHMRTimestamp}`
          );
          const start = hasQuotes ? imp.s + 1 : imp.s;
          const end = hasQuotes ? imp.e - 1 : imp.e;
          s.overwrite(start, end, replacedUrl);
        }

        if (imp.d === -1 && server.config.server.preTransformRequests) {
          // pre-transform known direct imports
          server.warmupRequest(hmrUrl, { ssr });
        }

        break;
      }
    }

    // Update `transformResult` with new code. We don't have to update the sourcemap
    // as the timestamp changes doesn't affect the code lines (stable).
    const code = s.toString();
    result = {
      ...transformResult,
      code,
      etag: getEtag(code, { weak: true }),
    };
  }

  // Only cache the result if the module wasn't invalidated while it was
  // being processed, so it is re-processed next time if it is stale
  if (timestamp > mod.lastInvalidationTimestamp)
    server.moduleGraph.updateModuleTransformResult(mod, result, ssr);

  return result;
}
