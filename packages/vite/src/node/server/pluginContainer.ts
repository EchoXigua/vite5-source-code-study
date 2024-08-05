/**
 * This file is refactored into TypeScript based on
 * https://github.com/preactjs/wmr/blob/main/packages/wmr/src/lib/rollup-plugin-container.js
 */

/**
https://github.com/preactjs/wmr/blob/master/LICENSE

MIT License

Copyright (c) 2020 The Preact Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import fs from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseAst as rollupParseAst } from "rollup/parseAst";
import type {
  AsyncPluginHooks,
  CustomPluginOptions,
  EmittedFile,
  FunctionPluginHooks,
  InputOptions,
  LoadResult,
  MinimalPluginContext,
  ModuleInfo,
  ModuleOptions,
  NormalizedInputOptions,
  OutputOptions,
  ParallelPluginHooks,
  PartialNull,
  PartialResolvedId,
  ResolvedId,
  RollupError,
  RollupLog,
  PluginContext as RollupPluginContext,
  SourceDescription,
  SourceMap,
  TransformResult,
} from "rollup";
import type { RawSourceMap } from "@ampproject/remapping";
/**
 * TraceMap 用于创建或处理源映射的跟踪信息
 *
 * originalPositionFor 用于从源映射中获取指定位置的原始代码位置信息。
 * 它允许将转换后的代码位置映射回原始源代码中的位置
 */
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import MagicString from "magic-string";
import type { FSWatcher } from "chokidar";
import colors from "picocolors";
import type { Plugin } from "../plugin";
import {
  // combineSourcemaps,
  createDebugger,
  ensureWatchedFile,
  // generateCodeFrame,
  isExternalUrl,
  isObject,
  normalizePath,
  // numberToPos,
  prettifyUrl,
  rollupVersion,
  timeFrom,
} from "../utils";
import { FS_PREFIX } from "../constants";
import type { ResolvedConfig } from "../config";
import { createPluginHookUtils, getHookHandler } from "../plugins";
import { cleanUrl, unwrapId } from "../../shared/utils";
import { buildErrorMessage } from "./middlewares/error";
import type { ModuleGraph, ModuleNode } from "./moduleGraph";

const noop = () => {};

export const ERR_CLOSED_SERVER = "ERR_CLOSED_SERVER";

export function throwClosedServerError(): never {
  const err: any = new Error(
    "The server is being restarted or closed. Request is outdated"
  );
  err.code = ERR_CLOSED_SERVER;
  // This error will be caught by the transform middleware that will
  // send a 504 status code request timeout
  throw err;
}

export interface PluginContainerOptions {
  cwd?: string;
  output?: OutputOptions;
  modules?: Map<string, { info: ModuleInfo }>;
  writeFile?: (name: string, source: string | Uint8Array) => void;
}

export interface PluginContainer {
  options: InputOptions;
  getModuleInfo(id: string): ModuleInfo | null;
  buildStart(options: InputOptions): Promise<void>;
  resolveId(
    id: string,
    importer?: string,
    options?: {
      attributes?: Record<string, string>;
      custom?: CustomPluginOptions;
      skip?: Set<Plugin>;
      ssr?: boolean;
      /**
       * @internal
       */
      scan?: boolean;
      isEntry?: boolean;
    }
  ): Promise<PartialResolvedId | null>;
  transform(
    code: string,
    id: string,
    options?: {
      inMap?: SourceDescription["map"];
      ssr?: boolean;
    }
  ): Promise<{ code: string; map: SourceMap | { mappings: "" } | null }>;
  load(
    id: string,
    options?: {
      ssr?: boolean;
    }
  ): Promise<LoadResult | null>;
  watchChange(
    id: string,
    change: { event: "create" | "update" | "delete" }
  ): Promise<void>;
  close(): Promise<void>;
}

type PluginContext = Omit<
  RollupPluginContext,
  // not documented
  "cache"
>;

// Vite插件容器的创建函数，用于处理Vite插件的生命周期钩子，如resolveId、load、transform等
export async function createPluginContainer(
  config: ResolvedConfig,
  moduleGraph?: ModuleGraph,
  watcher?: FSWatcher
): Promise<PluginContainer> {
  const {
    plugins,
    logger,
    root,
    build: { rollupOptions },
  } = config;

  // 获取按钩子排序的插件
  const { getSortedPluginHooks, getSortedPlugins } =
    createPluginHookUtils(plugins);

  // 下面定义了几个用于调试的工具以及一个记录解析结果的对象

  // 用于记录解析的结果，以避免重复调试输出
  const seenResolves: Record<string, true | undefined> = {};

  // 用于调试 Vite 的解析过程
  const debugResolve = createDebugger("vite:resolve");
  // 用于调试插件的解析过程
  const debugPluginResolve = createDebugger("vite:plugin-resolve", {
    //只有在调试特定命名空间（"vite"）时才会启用此调试器。
    onlyWhenFocused: "vite:plugin",
  });
  // 用于调试插件的转换过程
  const debugPluginTransform = createDebugger("vite:plugin-transform", {
    onlyWhenFocused: "vite:plugin",
  });

  // 通常用于过滤特定的 sourcemap 组合调试信息
  const debugSourcemapCombineFilter =
    process.env.DEBUG_VITE_SOURCEMAP_COMBINE_FILTER;

  // 用于调试 sourcemap 的组合过程
  const debugSourcemapCombine = createDebugger("vite:sourcemap-combine", {
    onlyWhenFocused: true,
  });

  // ---------------------------------------------------------------------------

  // 用于存储需要监视的文件路径，使用 Set 结构是为了确保每个文件路径是唯一的
  // 在插件的生命周期内，当某些文件需要被监视时，会将这些文件路径添加到 watchFiles 中
  // 这些文件路径可能会在文件发生变化时触发相应的处理逻辑
  const watchFiles = new Set<string>();

  /**
   *  load() '钩子中的_addedFiles被保存在这里，以便可以在' transform() '钩子中重用
   *
   *
   * 用于存储模块节点（ModuleNode）与它们在 load 钩子中添加的导入（_addedImports）之间的映射关系
   * 当某个模块在 load 钩子中加载时，可能会添加一些导入文件，这些导入文件会被保存到 _addedImports 中
   * 在 transform 钩子中，需要再次使用这些导入文件来进行一些转换或其他操作
   * 通过 moduleNodeToLoadAddedImports，可以在 transform 钩子中方便地访问到这些导入文件
   *
   */
  const moduleNodeToLoadAddedImports = new WeakMap<
    ModuleNode,
    Set<string> | null
  >();

  // 用于插件上下文
  const minimalContext: MinimalPluginContext = {
    meta: {
      rollupVersion,
      watchMode: true, //表示是否处于监视模式
    },
    debug: noop,
    info: noop,
    warn: noop,
    // @ts-expect-error noop
    error: noop,
  };

  // 用于在服务模式下警告不兼容的方法
  function warnIncompatibleMethod(method: string, plugin: string) {
    logger.warn(
      colors.cyan(`[plugin:${plugin}] `) +
        colors.yellow(
          `context method ${colors.bold(
            `${method}()`
          )} is not supported in serve mode. This plugin is likely not vite-compatible.`
        )
    );
  }

  /**
   * 用于并行执行插件钩子函数。
   * 根据钩子函数的 sequential 属性决定是否需要顺序执行。此函数确保在执行多个插件钩子时，
   * 可以最大化并行化，以提高性能，同时也能够处理需要顺序执行的特殊钩子。
   *
   * @param hookName 钩子名称
   * @param context 一个函数，接收一个插件对象，返回钩子函数执行时的上下文。
   * @param args 一个函数，接收一个插件对象，返回钩子函数所需的参数。
   */
  async function hookParallel<H extends AsyncPluginHooks & ParallelPluginHooks>(
    hookName: H,
    context: (plugin: Plugin) => ThisType<FunctionPluginHooks[H]>,
    args: (plugin: Plugin) => Parameters<FunctionPluginHooks[H]>
  ): Promise<void> {
    // 初始化并行任务的 Promise 列表
    const parallelPromises: Promise<unknown>[] = [];

    // 遍历排序后的插件列表
    for (const plugin of getSortedPlugins(hookName)) {
      // 如果关闭，不要在这里抛出，这样buildEnd和closeBundle钩子就可以完成运行

      // 检查插件是否有对应的钩子函数：
      const hook = plugin[hookName];
      if (!hook) continue;

      // 获取钩子函数的处理函数
      const handler: Function = getHookHandler(hook);
      // 判断钩子函数是否需要顺序执行：
      if ((hook as { sequential?: boolean }).sequential) {
        // 设置了 sequential 则等待所有的并行任务完成
        await Promise.all(parallelPromises);
        // 清空并行任务列表
        parallelPromises.length = 0;
        // 顺序执行当前钩子函数
        await handler.apply(context(plugin), args(plugin));
      } else {
        // 将钩子函数添加到并行任务列表中：
        parallelPromises.push(handler.apply(context(plugin), args(plugin)));
      }
    }
    // 等待所有并行任务完成
    await Promise.all(parallelPromises);
  }

  // 模块信息代理
  const ModuleInfoProxy: ProxyHandler<ModuleInfo> = {
    get(info: any, key: string) {
      if (key in info) {
        return info[key];
      }
      // 特殊处理 then 属性，以避免在异步函数中返回 ModuleInfo 时出错。
      if (key === "then") {
        return undefined;
      }
      // 当访问不存在的属性时抛出错误。
      throw Error(
        `[vite] The "${key}" property of ModuleInfo is not supported.`
      );
    },
  };

  // 定义一个冻结的空对象，作为 moduleInfo.meta 的默认值
  const EMPTY_OBJECT = Object.freeze({});

  // 从 moduleGraph 获取模块信息
  function getModuleInfo(id: string) {
    const module = moduleGraph?.getModuleById(id);
    if (!module) {
      return null;
    }
    if (!module.info) {
      // 如果模块存在但 info 属性不存在，创建一个 ModuleInfo 代理并赋值给 module.info。
      module.info = new Proxy(
        { id, meta: module.meta || EMPTY_OBJECT } as ModuleInfo,
        ModuleInfoProxy
      );
    }
    return module.info;
  }

  /**
   * 更新模块的 meta 信息
   * @param id
   * @param param1
   */
  function updateModuleInfo(id: string, { meta }: { meta?: object | null }) {
    if (meta) {
      const moduleInfo = getModuleInfo(id);
      if (moduleInfo) {
        moduleInfo.meta = { ...moduleInfo.meta, ...meta };
      }
    }
  }

  /**
   * 更新特定模块的 _addedImports 属性
   * @param id
   * @param ctx
   */
  function updateModuleLoadAddedImports(id: string, ctx: Context) {
    const module = moduleGraph?.getModuleById(id);
    if (module) {
      moduleNodeToLoadAddedImports.set(module, ctx._addedImports);
    }
  }

  /**
   * 我们应该为每个异步钩子管道创建一个新的上下文，
   * 以便可以以一种并发安全的方式跟踪该管道中的活动插件。使用类使创建新上下文更有效
   */

  // 用于处理插件的生命周期钩子和模块的加载、解析
  class Context implements PluginContext {
    meta = minimalContext.meta; // 插件上下文的元信息
    ssr = false; // 标志是否为服务器端渲染
    _scan = false; // 扫描标志
    _activePlugin: Plugin | null; // 当前活动的插件
    _activeId: string | null = null; // 当前活动的模块 ID
    _activeCode: string | null = null; // 当前活动的模块代码
    _resolveSkips?: Set<Plugin>; // 跳过解析的插件集合
    _addedImports: Set<string> | null = null; // 已添加的导入集合

    // 初始化 Context 实例时，可以指定初始插件。
    constructor(initialPlugin?: Plugin) {
      this._activePlugin = initialPlugin || null;
    }

    // 解析代码字符串并返回 AST
    parse(code: string, opts: any) {
      return rollupParseAst(code, opts);
    }

    /**
     * 异步解析模块 ID，支持自定义属性和插件跳过逻辑
     * @param id 要解析的模块 ID
     * @param importer 导入此模块的模块 ID
     * @param options 可选参数对象
     * @returns
     */
    async resolve(
      id: string,
      importer?: string,
      options?: {
        attributes?: Record<string, string>; //记录模块的相关属性
        custom?: CustomPluginOptions; //自定义插件选项
        isEntry?: boolean; // 此模块是否为入口模块
        skipSelf?: boolean; // 是否跳过当前插件的解析
      }
    ) {
      // 用于指示解析过程中应跳过的插件
      let skip: Set<Plugin> | undefined;
      if (options?.skipSelf !== false && this._activePlugin) {
        // 跳过当前插件
        skip = new Set(this._resolveSkips);
        skip.add(this._activePlugin);
      }

      // 进行实际的模块解析
      let out = await container.resolveId(id, importer, {
        attributes: options?.attributes,
        custom: options?.custom,
        isEntry: !!options?.isEntry,
        skip,
        ssr: this.ssr,
        scan: this._scan,
      });

      // 处理解析结果，是字符串，将其转换为对象 { id: out }，否则直接返回
      if (typeof out === "string") out = { id: out };
      return out as ResolvedId | null;
    }

    /**
     * 用于处理模块加载过程，包括解析模块、更新模块信息、执行模块代码转换等
     * @param options
     * @returns
     */
    async load(
      options: {
        id: string; //要加载的模块 ID
        resolveDependencies?: boolean; // 指示是否解析模块依赖
      } & Partial<PartialNull<ModuleOptions>>
    ): Promise<ModuleInfo> {
      // 确保模块已存在于模块图中。如果模块不存在，则添加它
      // unwrapId 解包模块 ID
      await moduleGraph?.ensureEntryFromUrl(unwrapId(options.id), this.ssr);
      // 尽管并非所有选项都适用于加载单个文件，但仍然可以更新支持的模块信息属性

      // 更新模块mete信息
      updateModuleInfo(options.id, options);

      // 加载模块，container.load 方法，加载指定 ID 的模块
      const loadResult = await container.load(options.id, { ssr: this.ssr });

      // 如果结果是对象，则提取 code 属性，否则直接使用 loadResult 作为代码。
      const code =
        typeof loadResult === "object" ? loadResult?.code : loadResult;
      if (code != null) {
        // 如果加载的代码不为空，对代码进行转换
        await container.transform(code, options.id, { ssr: this.ssr });
      }

      // 获取模块信息
      const moduleInfo = this.getModuleInfo(options.id);

      /**
       * 由于调用了 ensureEntryFromUrl，这种情况不应该发生
       * 但是 1. 我们的类型不能保证这一点
       *      2. moduleGraph 可能没有被提供（虽然在这种情况下，我们不应该有插件调用这个 load 方法）
       */
      if (!moduleInfo)
        // 检查模块信息是否为空。如果为空，抛出错误，指示模块加载失败
        throw Error(`Failed to load module with id ${options.id}`);

      // 返回模块信息
      return moduleInfo;
    }

    /**
     * 获取模块信息
     * @param id
     * @returns
     */
    getModuleInfo(id: string) {
      return getModuleInfo(id);
    }

    /**
     * 获取所有模块 ID
     * @returns
     */
    getModuleIds() {
      return moduleGraph
        ? moduleGraph.idToModuleMap.keys()
        : Array.prototype[Symbol.iterator](); // 迭代器
    }

    /**
     *  添加监视文件并更新 _addedImports 集合
     * @param id
     */
    addWatchFile(id: string) {
      watchFiles.add(id);
      (this._addedImports || (this._addedImports = new Set())).add(id);
      if (watcher) ensureWatchedFile(watcher, id, root);
    }

    /**
     * 获取所有监视文件
     * @returns
     */
    getWatchFiles() {
      return [...watchFiles];
    }

    // 这些方法不支持，在调用时发出警告
    emitFile(assetOrFile: EmittedFile) {
      warnIncompatibleMethod(`emitFile`, this._activePlugin!.name);
      return "";
    }

    setAssetSource() {
      warnIncompatibleMethod(`setAssetSource`, this._activePlugin!.name);
    }

    getFileName() {
      warnIncompatibleMethod(`getFileName`, this._activePlugin!.name);
      return "";
    }

    // 用于发出警告信息
    warn(
      e: string | RollupLog | (() => string | RollupLog),
      position?: number | { column: number; line: number }
    ) {
      const err = formatError(
        typeof e === "function" ? e() : e,
        position,
        this
      );
      const msg = buildErrorMessage(
        err,
        [colors.yellow(`warning: ${err.message}`)],
        false
      );
      logger.warn(msg, {
        clear: true,
        timestamp: true,
      });
    }

    // 用于抛出错误
    error(
      e: string | RollupError,
      position?: number | { column: number; line: number }
    ): never {
      // error thrown here is caught by the transform middleware and passed on
      // the the error middleware.
      throw formatError(e, position, this);
    }

    debug = noop;
    info = noop;
  }

  /**
   * 用于格式化和增强错误对象的信息,生成一个更详细和友好的错误报告
   *
   * @param e 错误消息）或 RollupError 对象
   * @param position 一个数字或一个包含 column 和 line 属性的对象，表示错误位置
   * @param ctx 一个 Context 对象，包含当前插件的上下文信息
   * @returns
   */
  function formatError(
    e: string | RollupError,
    position: number | { column: number; line: number } | undefined,
    ctx: Context
  ) {
    // 如果 e 是字符串，则创建一个新的 Error 对象，否则是一个 RollupError 对象
    const err = (typeof e === "string" ? new Error(e) : e) as RollupError;

    // 如果错误对象已经有 pluginCode 属性，则直接返回错误对象
    // 这意味着插件可能已经调用了 this.error 方法，不需要进一步处理
    if (err.pluginCode) {
      return err; // The plugin likely called `this.error`
    }

    // 设置当权活动的的插件名字和id|
    if (ctx._activePlugin) err.plugin = ctx._activePlugin.name;
    if (ctx._activeId && !err.id) err.id = ctx._activeId;

    // 处理错误位置和代码帧
    if (ctx._activeCode) {
      err.pluginCode = ctx._activeCode;

      // 获取错误位置，优先使用 position 参数，其次是错误对象的 pos 或 position 属性
      const pos = position ?? err.pos ?? (err as any).position;

      if (pos != null) {
        // 将位置转换为行列格式
        let errLocation;
        try {
          // 数字位置转换为行列位置。如果转换失败，记录错误并抛出异常
          errLocation = numberToPos(ctx._activeCode, pos);
        } catch (err2) {
          logger.error(
            colors.red(
              `Error in error handler:\n${err2.stack || err2.message}\n`
            ),
            // print extra newline to separate the two errors
            { error: err2 }
          );
          throw err;
        }

        // 置错误对象的 loc 属性
        err.loc = err.loc || {
          file: err.id,
          ...errLocation,
        };
        // 生成代码帧
        err.frame = err.frame || generateCodeFrame(ctx._activeCode, pos);
      } else if (err.loc) {
        // CSS预处理器可能会报告包含文件中的错误

        // 错误对象已有 loc 属性，但没有代码帧，则尝试读取文件并生成代码帧
        if (!err.frame) {
          let code = ctx._activeCode;
          if (err.loc.file) {
            err.id = normalizePath(err.loc.file);
            try {
              code = fs.readFileSync(err.loc.file, "utf-8");
            } catch {}
          }
          err.frame = generateCodeFrame(code, err.loc);
        }
      } else if ((err as any).line && (err as any).column) {
        // 如果错误对象有行列信息，但没有 loc 属性，则设置 loc 属性，并生成代码帧
        err.loc = {
          file: err.id,
          line: (err as any).line,
          column: (err as any).column,
        };
        err.frame = err.frame || generateCodeFrame(ctx._activeCode, err.loc);
      }

      // 处理 sourcemap
      if (
        ctx instanceof TransformContext &&
        typeof err.loc?.line === "number" &&
        typeof err.loc?.column === "number"
      ) {
        const rawSourceMap = ctx._getCombinedSourcemap();
        if (rawSourceMap && "version" in rawSourceMap) {
          // 尝试通过 sourcemap 找到原始位置
          const traced = new TraceMap(rawSourceMap as any);
          // 使用 originalPositionFor 从 sourcemap 中找到原始位置，并更新错误对象的位置信息
          const { source, line, column } = originalPositionFor(traced, {
            line: Number(err.loc.line),
            column: Number(err.loc.column),
          });
          if (source && line != null && column != null) {
            err.loc = { file: source, line, column };
          }
        }
      }
    } else if (err.loc) {
      if (!err.frame) {
        let code = err.pluginCode;
        if (err.loc.file) {
          err.id = normalizePath(err.loc.file);
          if (!code) {
            try {
              code = fs.readFileSync(err.loc.file, "utf-8");
            } catch {}
          }
        }
        if (code) {
          err.frame = generateCodeFrame(`${code}`, err.loc);
        }
      }
    }

    // 清理位置属性
    if (
      typeof err.loc?.column !== "number" &&
      typeof err.loc?.line !== "number" &&
      !err.loc?.file
    ) {
      // 错误对象的 loc 属性中没有行列信息且没有文件，则删除 loc 属性
      delete err.loc;
    }

    return err;
  }

  /**
   * 一个用于代码转换的上下文
   */
  class TransformContext extends Context {
    filename: string; //文件名
    originalCode: string; //原始代码
    originalSourcemap: SourceMap | null = null; // 初始的 SourceMap，默认为 null
    sourcemapChain: NonNullable<SourceDescription["map"]>[] = []; //存储一系列的 SourceMap
    combinedMap: SourceMap | { mappings: "" } | null = null; //合并后的 SourceMap 或一个表示空映射的对象，默认为 null。

    constructor(id: string, code: string, inMap?: SourceMap | string) {
      // 调用父类 Context 的构造函数
      super();
      this.filename = id;
      this.originalCode = code;
      if (inMap) {
        if (debugSourcemapCombine) {
          // @ts-expect-error inject name for debug purpose
          inMap.name = "$inMap";
        }
        this.sourcemapChain.push(inMap);
      }
      // Inherit `_addedImports` from the `load()` hook
      const node = moduleGraph?.getModuleById(id);
      if (node) {
        this._addedImports = moduleNodeToLoadAddedImports.get(node) ?? null;
      }
    }

    // 合并 SourceMap 的私有方法
    _getCombinedSourcemap() {
      if (
        debugSourcemapCombine &&
        debugSourcemapCombineFilter &&
        this.filename.includes(debugSourcemapCombineFilter)
      ) {
        debugSourcemapCombine("----------", this.filename);
        debugSourcemapCombine(this.combinedMap);
        debugSourcemapCombine(this.sourcemapChain);
        debugSourcemapCombine("----------");
      }

      let combinedMap = this.combinedMap;
      // { mappings: '' }
      if (
        combinedMap &&
        !("version" in combinedMap) &&
        combinedMap.mappings === ""
      ) {
        this.sourcemapChain.length = 0;
        return combinedMap;
      }

      for (let m of this.sourcemapChain) {
        if (typeof m === "string") m = JSON.parse(m);
        if (!("version" in (m as SourceMap))) {
          // { mappings: '' }
          if ((m as SourceMap).mappings === "") {
            combinedMap = { mappings: "" };
            break;
          }
          // empty, nullified source map
          combinedMap = null;
          break;
        }
        if (!combinedMap) {
          const sm = m as SourceMap;
          // sourcemap should not include `sources: [null]` (because `sources` should be string) nor
          // `sources: ['']` (because `''` means the path of sourcemap)
          // but MagicString generates this when `filename` option is not set.
          // Rollup supports these and therefore we support this as well
          if (sm.sources.length === 1 && !sm.sources[0]) {
            combinedMap = {
              ...sm,
              sources: [this.filename],
              sourcesContent: [this.originalCode],
            };
          } else {
            combinedMap = sm;
          }
        } else {
          combinedMap = combineSourcemaps(cleanUrl(this.filename), [
            m as RawSourceMap,
            combinedMap as RawSourceMap,
          ]) as SourceMap;
        }
      }
      if (combinedMap !== this.combinedMap) {
        this.combinedMap = combinedMap;
        this.sourcemapChain.length = 0;
      }
      return this.combinedMap;
    }

    // 获取合并后的 SourceMap 的公共方法
    getCombinedSourcemap() {
      const map = this._getCombinedSourcemap();
      if (!map || (!("version" in map) && map.mappings === "")) {
        return new MagicString(this.originalCode).generateMap({
          includeContent: true,
          hires: "boundary",
          source: cleanUrl(this.filename),
        });
      }
      return map;
    }
  }

  // 示当前服务器是否已关闭
  let closed = false;
  // 用于存储正在处理的钩子函数的 Promise 对象
  const processesing = new Set<Promise<any>>();
  // 跟踪钩子承诺，以便我们可以在关闭服务器时等待它们全部完成

  /**
   * 用于处理可能是 Promise 的钩子函数结果，并在 Promise 结束后进行清理
   * @param maybePromise
   * @returns
   */
  function handleHookPromise<T>(maybePromise: undefined | T | Promise<T>) {
    if (!(maybePromise as any)?.then) {
      return maybePromise;
    }
    const promise = maybePromise as Promise<T>;
    processesing.add(promise);
    return promise.finally(() => processesing.delete(promise));
  }

  /**
   * 用于管理插件的不同生命周期和处理过程
   *
   * container 对象是一个插件容器，封装了所有与 Rollup 构建过程相关的异步操作和钩子。
   * 它通过并行处理钩子和管理异步操作的状态来确保插件可以协同工作，并在需要时进行适当的清理和处理
   */
  const container: PluginContainer = {
    // 用于处理 rollupOptions 并依次调用排序后的 options 钩子
    options: await (async () => {
      let options = rollupOptions;
      for (const optionsHook of getSortedPluginHooks("options")) {
        if (closed) throwClosedServerError();
        options =
          // 每个钩子函数通过 handleHookPromise 进行处理，确保可以等待其完成或直接返回原始 options。
          (await handleHookPromise(
            optionsHook.call(minimalContext, options)
          )) || options;
      }
      return options;
    })(),

    getModuleInfo,

    /**
     * 并行执行所有 buildStart 钩子
     */
    async buildStart() {
      await handleHookPromise(
        hookParallel(
          "buildStart",
          (plugin) => new Context(plugin),
          () => [container.options as NormalizedInputOptions]
        )
      );
    },

    /**
     * 用于解析模块的 ID
     * 通过遍历已排序的插件列表，依次调用每个插件的 resolveId 方法，
     * 直到找到第一个成功解析的模块 ID 或确定无法解析为止
     *
     * @param rawId 要解析的原始模块 ID
     * @param importer 导入者的路径，默认为 root 目录下的 index.html
     * @param options 解析选项的对象
     * @returns
     */
    async resolveId(rawId, importer = join(root, "index.html"), options) {
      const skip = options?.skip;
      const ssr = options?.ssr;
      const scan = !!options?.scan;

      // 用于在解析过程中传递和管理状态信息
      const ctx = new Context();
      ctx.ssr = !!ssr;
      ctx._scan = scan;
      ctx._resolveSkips = skip;

      // 调试和性能监控: 如果开启了 debugResolve，则记录解析开始时间 resolveStart
      const resolveStart = debugResolve ? performance.now() : 0;
      let id: string | null = null;
      const partial: Partial<PartialResolvedId> = {};

      // 获取已排序的 resolveId 插件列表
      for (const plugin of getSortedPlugins("resolveId")) {
        // 对每个插件进行迭代处理

        // 如果服务器关闭且不是服务端渲染模式，则抛出错误
        if (closed && !ssr) throwClosedServerError();

        // 如果插件不包含 resolveId 方法或在跳过列表中，则继续下一个插件
        if (!plugin.resolveId) continue;
        if (skip?.has(plugin)) continue;

        // 将当前插件标记为活动插件
        ctx._activePlugin = plugin;

        // 记录当前插件解析开始时间
        const pluginResolveStart = debugPluginResolve ? performance.now() : 0;
        // 获取插件的 resolveId 处理函数 handler
        const handler = getHookHandler(plugin.resolveId);
        // 通过 handleHookPromise 等待其完成
        const result = await handleHookPromise(
          handler.call(ctx as any, rawId, importer, {
            attributes: options?.attributes ?? {},
            custom: options?.custom,
            isEntry: !!options?.isEntry,
            ssr,
            scan,
          })
        );
        if (!result) continue;

        if (typeof result === "string") {
          // 字符串类型，则直接将其作为解析后的 id
          id = result;
        } else {
          // 获取id，并合并到 partial 对象中
          id = result.id;
          Object.assign(partial, result);
        }

        // 记录解析成功的信息
        debugPluginResolve?.(
          timeFrom(pluginResolveStart),
          plugin.name,
          prettifyUrl(id, root)
        );

        // resolveId() is hookFirst - first non-null result is returned.

        // 终止迭代，因为 resolveId 钩子按顺序返回第一个非空结果
        break;
      }

      // 开启了debug 解析，且解析前后的 rawId 和 id 不相同，不是FS_PREFIX开头，则记录解析信息
      if (debugResolve && rawId !== id && !rawId.startsWith(FS_PREFIX)) {
        const key = rawId + id;
        // avoid spamming
        if (!seenResolves[key]) {
          // 记录当前已经被解析了
          seenResolves[key] = true;
          debugResolve(
            `${timeFrom(resolveStart)} ${colors.cyan(rawId)} -> ${colors.dim(
              id
            )}`
          );
        }
      }

      if (id) {
        // 成功解析出 id，则将其规范化并添加到 partial.id 中
        partial.id = isExternalUrl(id) ? id : normalizePath(id);
        // 返回 partial 对象作为部分解析的结果。
        return partial as PartialResolvedId;
      } else {
        return null;
      }
    },

    /**
     * 用于加载指定模块 id 的内容
     * 通过遍历已排序的插件列表，依次调用每个插件的 load 方法，
     * 直到找到第一个成功加载的结果或确定加载失败为止
     *
     * @param id
     * @param options
     * @returns
     */
    async load(id, options) {
      const ssr = options?.ssr;
      const ctx = new Context();
      ctx.ssr = !!ssr;

      // 获取已排序的 load 插件列表
      for (const plugin of getSortedPlugins("load")) {
        // 如果服务器已关闭且不是服务端渲染模式，则抛出错误
        if (closed && !ssr) throwClosedServerError();

        // 如果插件不包含 load 方法，则继续下一个插件
        if (!plugin.load) continue;
        // 将当前插件标记为活动插件
        ctx._activePlugin = plugin;
        // 获取插件的 load 处理函数
        const handler = getHookHandler(plugin.load);
        // 通过 handleHookPromise 等待其完成
        const result = await handleHookPromise(
          handler.call(ctx as any, id, { ssr })
        );

        if (result != null) {
          if (isObject(result)) {
            // 更新模块信息
            updateModuleInfo(id, result);
          }

          // 更新加载的模块导入信息
          updateModuleLoadAddedImports(id, ctx);
          return result;
        }
      }

      // 如果没有任何插件成功返回加载结果，则调用 updateModuleLoadAddedImports(id, ctx)
      // 更新加载的模块导入信息，并返回 null 表示加载失败。
      updateModuleLoadAddedImports(id, ctx);
      return null;
    },

    /**
     * 用于对指定的模块代码进行转换
     * @param code 要转换的模块代码
     * @param id 要转换的模块 ID
     * @param options 主要关注源映射 inMap 和服务端渲染标志 ssr
     * @returns
     */
    async transform(code, id, options) {
      const inMap = options?.inMap;
      const ssr = options?.ssr;
      const ctx = new TransformContext(id, code, inMap as SourceMap);
      ctx.ssr = !!ssr;

      // 获取已排序的 transform 插件列表
      for (const plugin of getSortedPlugins("transform")) {
        // 果服务器已关闭且不是服务端渲染模式，则抛出错误
        if (closed && !ssr) throwClosedServerError();
        // 如果插件不包含 transform 方法，则继续下一个插件
        if (!plugin.transform) continue;

        // 将当前插件标记为活动插件，并设置模块id 和代码
        ctx._activePlugin = plugin;
        ctx._activeId = id;
        ctx._activeCode = code;

        // 如果启用了debug 插件转换，记录当前插件转换开始的时间戳
        const start = debugPluginTransform ? performance.now() : 0;
        let result: TransformResult | string | undefined;

        // 获取插件的 transform 处理函数
        const handler = getHookHandler(plugin.transform);
        try {
          // 通过 handleHookPromise 等待其完成
          result = await handleHookPromise(
            handler.call(ctx as any, code, id, { ssr })
          );
        } catch (e) {
          ctx.error(e);
        }

        // 如果转换结果为空，则继续下一个插件
        if (!result) continue;

        debugPluginTransform?.(
          timeFrom(start),
          plugin.name,
          prettifyUrl(id, root)
        );

        if (isObject(result)) {
          if (result.code !== undefined) {
            // 更新 code 变量为新的代码。
            code = result.code;
            if (result.map) {
              if (debugSourcemapCombine) {
                // 在调试模式下记录插件名称。
                // @ts-expect-error inject plugin name for debug purpose
                result.map.name = plugin.name;
              }

              // 添加到 ctx.sourcemapChain 中
              ctx.sourcemapChain.push(result.map);
            }
          }

          // 更新模块信息
          updateModuleInfo(id, result);
        } else {
          // 转换结果是字符串类型，则更新 code 变量为新的代码
          code = result;
        }
      }

      // 返回一个包含转换后的 code 和合并后源映射 ctx._getCombinedSourcemap() 的对象
      return {
        code,
        map: ctx._getCombinedSourcemap(),
      };
    },

    async watchChange(id, change) {
      const ctx = new Context();
      await hookParallel(
        "watchChange",
        () => ctx,
        () => [id, change]
      );
    },

    /**
     * 用于关闭整个构建过程或捆绑过程的插件容器
     *
     * close 方法负责安全地关闭插件容器，包括等待所有处理中的异步操作完成，
     * 并在关闭过程中执行必要的钩子函数以完成清理工作。这种设计确保了在关闭应用程序或服务时，
     * 所有相关的资源释放和状态管理都能够得到正确处理，从而保证整个系统的稳定性和可靠性
     * @returns
     */
    async close() {
      // 如果已经是关闭状态，则直接返回，避免重复关闭
      if (closed) return;

      //  closed 变量设置为 true，表示开始关闭操作
      closed = true;

      // 等待所有处理中的 Promise 完成,这里也解释了为什么上面的函数都通过 handleHookPromise 等待其完成，目的就在这里
      await Promise.allSettled(Array.from(processesing));
      const ctx = new Context();

      // 并行执行两个钩子函数
      await hookParallel(
        "buildEnd", //在构建结束时执行的钩子
        () => ctx,
        () => []
      );
      await hookParallel(
        "closeBundle", //在捆绑结束时执行的钩子
        () => ctx,
        () => []
      );
    },
  };

  return container;
}
