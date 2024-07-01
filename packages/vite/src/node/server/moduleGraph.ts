import { extname } from "node:path";
import type { ModuleInfo, PartialResolvedId } from "rollup";
import { isDirectCSSRequest } from "../plugins/css";
import {
  normalizePath,
  removeImportQuery,
  removeTimestampQuery,
} from "../utils";
import { FS_PREFIX } from "../constants";
import { cleanUrl } from "../../shared/utils";
import type { TransformResult } from "./transformRequest";

export type ResolvedUrl = [
  url: string,
  resolvedId: string,
  meta: object | null | undefined
];

//在 Vite 中表示模块图中的一个节点
//模块节点用于跟踪和管理模块及其依赖关系，特别是在热模块替换（HMR）和服务器端渲染（SSR）上下文中
export class ModuleNode {
  /**
   * 公共服务的 URL 路径，以 / 开头
   * 例如："/src/main.js"
   */
  url: string;
  /**
   * 解析后的文件系统路径加上查询字符串
   */
  id: string | null = null;
  //文件系统路径（不包含查询字符串）
  file: string | null = null;
  //模块的类型，可能是 js 或 css
  type: "js" | "css";
  //模块的信息
  info?: ModuleInfo;
  //模块的元数据，可以是任意类型的对象
  meta?: Record<string, any>;
  //导入当前模块的模块集合
  importers = new Set<ModuleNode>();
  //客户端环境中导入的模块集合
  clientImportedModules = new Set<ModuleNode>();
  //SSR 环境中导入的模块集合
  ssrImportedModules = new Set<ModuleNode>();
  //接受 HMR 更新的依赖模块集合
  acceptedHmrDeps = new Set<ModuleNode>();
  //接受 HMR 更新的导出集合
  acceptedHmrExports: Set<string> | null = null;
  //导入的绑定集合
  importedBindings: Map<string, Set<string>> | null = null;
  //模块是否自我接受 HMR 更新
  isSelfAccepting?: boolean;
  //模块的转换结果
  transformResult: TransformResult | null = null;
  //在 SSR 环境中的转换结果
  ssrTransformResult: TransformResult | null = null;
  //在 SSR 环境中的模块实例
  ssrModule: Record<string, any> | null = null;
  //在 SSR 环境中的错误
  ssrError: Error | null = null;
  //最后一次 HMR 时间戳
  lastHMRTimestamp = 0;
  /**
   * 标记最后一次是否收到了 HMR（热模块替换）无效请求。
   * 如果有多个客户端同时发起 import.meta.hot.invalidate 请求，
   * 通过这个属性可以避免多次更新，确保只有一次更新动作被执行。
   * @internal
   */
  lastHMRInvalidationReceived = false;
  //记录最后一次模块无效化的时间戳。用于跟踪模块的无效化状态，辅助处理热更新相关逻辑。
  lastInvalidationTimestamp = 0;
  /**
   * 表示模块的无效化状态：
   * 默认情况下，如果模块没有被软/硬无效化，该值为 undefined。
   * 如果模块被软无效化，该值包含先前的 transformResult。
   * 如果模块被硬无效化，该值将被设置为 'HARD_INVALIDATED'。
   *
   * @internal
   */
  invalidationState: TransformResult | "HARD_INVALIDATED" | undefined;
  /**
   * 表示 SSR（服务器端渲染）环境中模块的无效化状态
   * @internal
   */
  ssrInvalidationState: TransformResult | "HARD_INVALIDATED" | undefined;
  /**
   * 存储代码中静态导入的模块 URL 集合
   *
   * 这些 URL 是直接在代码中静态导入的，与 importedModules 中动态导入的模块有所区别。
   * 在热更新过程中，只有静态导入的模块可以进行软无效化，而其他导入（例如监视的文件）需要进行硬无效化
   * @internal
   */
  staticImportedUrls?: Set<string>;

  /**
   * 控制是否立即设置 isSelfAccepting 属性，默认为 true。
   * 如果设置为 false，可以稍后再设置 isSelfAccepting 属性。
   * @param setIsSelfAccepting - set `false` to set `isSelfAccepting` later. e.g. #7870
   */
  constructor(url: string, setIsSelfAccepting = true) {
    this.url = url;
    this.type = isDirectCSSRequest(url) ? "css" : "js";
    if (setIsSelfAccepting) {
      this.isSelfAccepting = false;
    }
  }

  get importedModules(): Set<ModuleNode> {
    const importedModules = new Set(this.clientImportedModules);
    for (const module of this.ssrImportedModules) {
      importedModules.add(module);
    }
    //importedModules 包含了客户端渲染和ssr渲染
    return importedModules;
  }
}

/**
 * 用于管理项目中的模块依赖关系和转换结果。
 * 支持模块的动态解析和更新，同时提供了丰富的方法来操作和管理模块数据。
 */
export class ModuleGraph {
  //用于存储 URL 到模块、模块 ID 到模块、ETag 到模块的映射关系
  urlToModuleMap = new Map<string, ModuleNode>();
  idToModuleMap = new Map<string, ModuleNode>();
  etagToModuleMap = new Map<string, ModuleNode>();
  // 一个文件可能对应多个具有不同查询的模块
  //将文件映射到多个模块的集合
  fileToModulesMap = new Map<string, Set<ModuleNode>>();
  //存储安全模块路径的集合
  safeModulesPath = new Set<string>();

  //internal  内部映射
  /**
   * 未解析的 URL 到模块的映射，支持异步解析
   * @internal
   */
  _unresolvedUrlToModuleMap = new Map<
    string,
    Promise<ModuleNode> | ModuleNode
  >();

  /**
   * ssr未解析的 URL 到模块的映射，支持异步解析
   * @internal
   */
  _ssrUnresolvedUrlToModuleMap = new Map<
    string,
    Promise<ModuleNode> | ModuleNode
  >();

  //存储解析失败的模块集合
  /** @internal */
  _hasResolveFailedErrorModules = new Set<ModuleNode>();

  constructor(
    //接受一个 resolveId 函数作为参数，用于解析模块的部分解析 ID 或者 null。
    private resolveId: (
      url: string,
      ssr: boolean
    ) => Promise<PartialResolvedId | null>
  ) {}

  /**
   * 用于根据给定的原始 URL 获取对应的模块节点
   * @param rawUrl
   * @param ssr
   * @returns ModuleNode
   */
  async getModuleByUrl(
    rawUrl: string,
    ssr?: boolean
  ): Promise<ModuleNode | undefined> {
    //用于移除 URL 中的导入查询和时间戳查询，确保 URL 的干净版本用于后续处理。
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl));
    //用于从内部的未解析 URL 到模块的映射中查找给定的 URL
    const mod = this._getUnresolvedUrlToModule(rawUrl, ssr);
    //如果找到了对应的模块（可能是一个 ModuleNode 或者一个 Promise），直接返回。
    if (mod) {
      return mod;
    }

    //如果未能在缓存中找到模块，则调用 _resolveUrl 方法来解析原始的 URL
    const [url] = await this._resolveUrl(rawUrl, ssr);
    //使用解析后的 URL 在 urlToModuleMap 中查找对应的模块节点，并将其返回。
    return this.urlToModuleMap.get(url);
  }

  //通过id 得到模块节点
  getModuleById(id: string): ModuleNode | undefined {
    return this.idToModuleMap.get(removeTimestampQuery(id));
  }

  //通过文件 得到模块节点
  getModulesByFile(file: string): Set<ModuleNode> | undefined {
    return this.fileToModulesMap.get(file);
  }

  //处理文件变更
  onFileChange(file: string): void {
    const mods = this.getModulesByFile(file);
    if (mods) {
      //seen 用来记录已经处理过的模块
      const seen = new Set<ModuleNode>();
      mods.forEach((mod) => {
        //遍历每个模块 mod，并调用 this.invalidateModule(mod, seen) 方法对模块进行无效化处理。
        this.invalidateModule(mod, seen);
      });
    }
  }

  //处理文件删除事件
  onFileDelete(file: string): void {
    const mods = this.getModulesByFile(file);
    if (mods) {
      //遍历每个模块 mod
      mods.forEach((mod) => {
        //对于每个模块 mod，遍历其 importedModules 集合中的每个导入的模块 importedMod
        mod.importedModules.forEach((importedMod) => {
          //将当前模块 mod 从 importedMod 的导入者集合中移除。
          importedMod.importers.delete(mod);
        });
      });
    }
  }

  /**
   * 用来使模块失效的方法，主要用于处理模块更新或无效化的逻辑
   * 在处理动态导入、热模块替换（HMR）或静态分析时，模块失效（或称为失效处理）是一个重要的概念
   * 
   * 当应用程序中的模块被标记为失效时，它能够：
        确保相关的转换结果和状态被正确清理或标记为无效，以便下次请求时重新生成。
        递归处理所有依赖于该模块的其他模块，确保它们也能在需要时重新处理。
        管理和清除与错误解析相关的状态，以确保在重新处理时不会因先前的错误而受到影响。
   * 
   * @param mod 
   * @param seen 
   * @param timestamp 
   * @param isHmr 
   * @param softInvalidate 
   * @returns 
   */
  invalidateModule(
    mod: ModuleNode,
    seen: Set<ModuleNode> = new Set(),
    timestamp: number = Date.now(),
    isHmr: boolean = false,
    /** @internal */
    /**
     * softInvalidate  决定模块是软失效还是硬失效
     * 如果是软失效 (softInvalidate 为 true)，则尝试保留先前的转换结果 (transformResult) 或标记为硬失效。
     * 如果是硬失效，则强制标记为硬失效，这意味着模块需要重新处理和转换
     */
    softInvalidate = false
  ): void {
    const prevInvalidationState = mod.invalidationState;
    const prevSsrInvalidationState = mod.ssrInvalidationState;

    /**
     * 软失效：意味着模块可能需要更新，但并非所有的依赖都需要重新加载。
     * 在这种情况下，方法会尝试保留先前的转换结果（如 transformResult），
     * 以便在下一次请求时，仅更新导入模块的时间戳等信息。
     *
     * 硬失效：完全清除模块的转换结果，并标记为需要完全重新加载和处理。
     * 这是在模块结构或代码实现发生重大变化时使用的方式。
     */
    //失效状态管理
    if (softInvalidate) {
      mod.invalidationState ??= mod.transformResult ?? "HARD_INVALIDATED";
      mod.ssrInvalidationState ??= mod.ssrTransformResult ?? "HARD_INVALIDATED";
    }
    //如果硬失效，在复位为' undefined '之前，其他软失效都不起作用
    else {
      mod.invalidationState = "HARD_INVALIDATED";
      mod.ssrInvalidationState = "HARD_INVALIDATED";
    }

    //如果模块之前已经失效，且失效状态没有改变，则跳过更新模块
    if (
      seen.has(mod) &&
      prevInvalidationState === mod.invalidationState &&
      prevSsrInvalidationState === mod.ssrInvalidationState
    ) {
      return;
    }
    //将模块添加到失效里面
    seen.add(mod);

    // 时间戳管理
    /**
     * isHmr 参数用于标记是否是由热模块替换触发的失效。
     *  如果是，则更新与 HMR 相关的时间戳信息。
     *  否则，更新一般失效的时间戳，确保在处理模块时能够根据这些时间戳避免使用旧的缓存结果。
     */
    if (isHmr) {
      mod.lastHMRTimestamp = timestamp;
      mod.lastHMRInvalidationReceived = false;
    } else {
      mod.lastInvalidationTimestamp = timestamp;
    }

    //清理和重置
    /**
     * 不要使mod.info和mod.meta无效，因为它们是处理管道的一部分，
     * 使转换结果无效足以确保该模块在下次请求时被重新处理
     */
    //移除与模块关联的任何标识符（如 etag）以及已经缓存的转换结果。
    const etag = mod.transformResult?.etag;
    if (etag) this.etagToModuleMap.delete(etag);

    mod.transformResult = null;
    //将服务器端渲染相关的状态（如 ssrTransformResult、ssrModule 和 ssrError）重置为 null
    mod.ssrTransformResult = null;
    mod.ssrModule = null;
    mod.ssrError = null;

    //递归失效处理
    //对于每个导入当前模块的模块（即 importers），递归调用 invalidateModule 方法。
    mod.importers.forEach((importer) => {
      if (!importer.acceptedHmrDeps.has(mod)) {
        /**
         * 如果导入器静态导入当前模块，我们可以使导入器软失效，只更新导入时间戳。
         * 如果它不是静态导入的，例如watch_glob文件，
         * 我们只能在当前模块也被软失效的情况下软失效。软失效不需要触发导入器的重新加载和重新转换。
         */

        //如果导入者在静态分析中导入当前模块，可以选择仅软失效导入者，以避免不必要的完全重新加载。
        const shouldSoftInvalidateImporter =
          importer.staticImportedUrls?.has(mod.url) || softInvalidate;
        this.invalidateModule(
          importer,
          seen,
          timestamp,
          isHmr,
          shouldSoftInvalidateImporter
        );
      }
    });

    //清除任何已知的解析失败错误状态。这确保了即使模块之前可能存在解析错误，也能在重新处理时正确地处理模块。
    this._hasResolveFailedErrorModules.delete(mod);
  }

  invalidateAll(): void {
    const timestamp = Date.now();
    const seen = new Set<ModuleNode>();
    this.idToModuleMap.forEach((mod) => {
      this.invalidateModule(mod, seen, timestamp);
    });
  }

  /**
   * 用于更新模块的导入信息和相关的依赖关系.
   *
   * 根据模块更新的导入信息更新模块图。如果存在不再具有任何导入器的依赖项，则将它们作为Set返回。
   *
   * @param mod 要更新信息的模块节点
   * @param importedModules 模块导入的集合，可以是模块节点或字符串形式的模块路径
   * @param importedBindings 导入的绑定信息，如变量名映射到导入模块的集合
   * @param acceptedModules  接受的热模块替换依赖集合
   * @param acceptedExports  接受的热模块替换导出集合
   * @param isSelfAccepting  是否接受自身作为依赖
   * @param ssr 是否是服务器端渲染
   *
   * 用于指定在代码中静态导入的模块路径集合。在软失效情况下，这个参数通常是未定义的。
   * 这个参数的目的是用于优化处理，但如果未定义可能会导致更多的运行时处理
   * @param staticImportedUrls 静态导入的模块路径集合，用于软失效情况
   * @returns
   */
  async updateModuleInfo(
    mod: ModuleNode,
    importedModules: Set<string | ModuleNode>,
    importedBindings: Map<string, Set<string>> | null,
    acceptedModules: Set<string | ModuleNode>,
    acceptedExports: Set<string> | null,
    isSelfAccepting: boolean,
    ssr?: boolean,
    /** @internal */
    staticImportedUrls?: Set<string>
  ): Promise<Set<ModuleNode> | undefined> {
    //将模块的 isSelfAccepting 属性设置为传入的 isSelfAccepting 值，表示模块是否自身接受更新。
    mod.isSelfAccepting = isSelfAccepting;

    //根据 ssr 参数选择性地获取先前的导入模块集合，
    //分别存储在 mod.ssrImportedModules 或 mod.clientImportedModules 中。
    const prevImports = ssr
      ? mod.ssrImportedModules
      : mod.clientImportedModules;

    // 用于存储不再被导入的模块集合
    let noLongerImported: Set<ModuleNode> | undefined;

    // 用于存储异步解析模块的 Promise 数组
    let resolvePromises = [];
    //用于存储解析后的模块结果数组
    let resolveResults = new Array(importedModules.size);
    //用于追踪 resolveResults 的索引
    let index = 0;

    // 更新导入图
    //遍历 importedModules，对每个导入的模块进行处理
    for (const imported of importedModules) {
      const nextIndex = index++;
      if (typeof imported === "string") {
        //如果 imported 是字符串
        //ensureEntryFromUrl  解析该模块，并将当前模块 mod 添加到 dep.importers 中
        resolvePromises.push(
          this.ensureEntryFromUrl(imported, ssr).then((dep) => {
            dep.importers.add(mod);
            resolveResults[nextIndex] = dep;
          })
        );
      } else {
        //直接将 imported 添加到 resolveResults 中，并将 mod 添加到 imported.importers 中。
        imported.importers.add(mod);
        resolveResults[nextIndex] = imported;
      }
    }

    //如果存在待解析的 Promise，使用 Promise.all 等待所有异步解析操作完成。
    if (resolvePromises.length) {
      await Promise.all(resolvePromises);
    }

    //将更新后的模块导入集合 nextImports 分配给相应的
    //mod.ssrImportedModules 或 mod.clientImportedModules
    const nextImports = new Set(resolveResults);
    if (ssr) {
      mod.ssrImportedModules = nextImports;
    } else {
      mod.clientImportedModules = nextImports;
    }

    // 移除不再被导入的依赖模块
    //遍历先前的导入模块集合 prevImports。
    prevImports.forEach((dep) => {
      if (
        !mod.clientImportedModules.has(dep) &&
        !mod.ssrImportedModules.has(dep)
      ) {
        //如果某个模块 dep 不再在更新后的导入集合中，从其 importers 中删除 mod。
        dep.importers.delete(mod);
        if (!dep.importers.size) {
          // 如果删除后 dep.importers 为空，将其添加到 noLongerImported 集合中
          (noLongerImported || (noLongerImported = new Set())).add(dep);
        }
      }
    });

    // 更新接受的 HMR 依赖
    //同样的方式处理 acceptedModules，更新模块接受的 HMR 依赖
    resolvePromises = [];
    resolveResults = new Array(acceptedModules.size);
    index = 0;
    for (const accepted of acceptedModules) {
      const nextIndex = index++;
      if (typeof accepted === "string") {
        resolvePromises.push(
          this.ensureEntryFromUrl(accepted, ssr).then((dep) => {
            resolveResults[nextIndex] = dep;
          })
        );
      } else {
        resolveResults[nextIndex] = accepted;
      }
    }

    if (resolvePromises.length) {
      await Promise.all(resolvePromises);
    }

    mod.acceptedHmrDeps = new Set(resolveResults);

    //更新静态导入的 URL、HMR 导出和绑定信息
    mod.staticImportedUrls = staticImportedUrls;

    // update accepted hmr exports
    mod.acceptedHmrExports = acceptedExports;
    mod.importedBindings = importedBindings;
    //返回不再被导入的模块集合,供调用者进一步处理。
    return noLongerImported;
  }

  /**
   * 用于确保根据给定的 URL 获取或创建一个模块节点（ModuleNode），
   * 并在模块图中进行相应的映射和注册
   * @param rawUrl
   * @param ssr
   * @param setIsSelfAccepting
   * @returns
   */
  async ensureEntryFromUrl(
    rawUrl: string,
    ssr?: boolean,
    setIsSelfAccepting = true
  ): Promise<ModuleNode> {
    return this._ensureEntryFromUrl(rawUrl, ssr, setIsSelfAccepting);
  }

  /**
   * 内部方法
   * @internal
   */
  async _ensureEntryFromUrl(
    rawUrl: string,
    ssr?: boolean,
    setIsSelfAccepting = true,
    // 优化，避免解析相同的url两次，如果调用者已经做了
    resolved?: PartialResolvedId
  ): Promise<ModuleNode> {
    //移除 URL 中的导入查询参数和时间戳查询参数。
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl));

    //检查是否已经有对应于这个 rawUrl 的未解析模块。如果有，直接返回该模块。
    let mod = this._getUnresolvedUrlToModule(rawUrl, ssr);
    if (mod) {
      return mod;
    }

    const modPromise = (async () => {
      //使用 _resolveUrl 方法解析 rawUrl，获取最终的 URL、解析后的 ID 和元数据
      const [url, resolvedId, meta] = await this._resolveUrl(
        rawUrl,
        ssr,
        resolved
      );

      //检查 idToModuleMap 中是否已经有解析后的模块 ID
      mod = this.idToModuleMap.get(resolvedId);
      if (!mod) {
        //如果没有，则创建一个新的 ModuleNode 实例，并设置其属性和相关映射
        mod = new ModuleNode(url, setIsSelfAccepting);

        //如果有元数据，将其赋值给模块的 meta 属性
        if (meta) mod.meta = meta;

        //将 URL 和解析后的 ID 映射到新的模块节点
        this.urlToModuleMap.set(url, mod);
        mod.id = resolvedId;
        this.idToModuleMap.set(resolvedId, mod);

        //将文件路径映射到模块节点集合中
        const file = (mod.file = cleanUrl(resolvedId));
        let fileMappedModules = this.fileToModulesMap.get(file);
        if (!fileMappedModules) {
          fileMappedModules = new Set();
          this.fileToModulesMap.set(file, fileMappedModules);
        }
        fileMappedModules.add(mod);
      }
      //多个url可以映射到相同的模块和id，在这种情况下，确保我们将url注册到现有的模块
      else if (!this.urlToModuleMap.has(url)) {
        //如果 URL 映射中没有这个 URL，但模块已经存在，将 URL 映射到现有的模块节点。
        this.urlToModuleMap.set(url, mod);
      }
      //将未解析的 URL 映射到模块节点
      this._setUnresolvedUrlToModule(rawUrl, mod, ssr);
      return mod;
    })();

    /**
     * 需要将清理后的 URL 注册到模块节点的原因：为了可以短路（即快速跳过）重复解析同一个 URL
     *
     * 为什么要这样做？
     * 1. 避免重复解析
     *      1. 在模块图中，可能会多次遇到相同的 URL。如果每次都重新解析这个 URL，会导致性能下降和不必要的开销
     *      2. 通过将清理后的 URL 注册到模块节点，当下次遇到相同的 URL 时，可以直接使用已经解析过的模块节点，而不需要再次解析
     * 2. 优化性能
     *      1. 这种优化可以显著提高模块图的构建速度，尤其是在大型项目中，重复解析相同 URL 的情况会更加频繁
     * 3. 保持一致性
     *      1. 注册清理后的 URL 确保了 URL 和模块节点的一致性，不会因为 URL 的不同形式而导致多个不同的模块节点指向同一个模块
     */
    //将清理后的 URL 注册到模块，以便下次快速查找
    this._setUnresolvedUrlToModule(rawUrl, modPromise, ssr);
    return modPromise;
  }

  /**
   * 这段代码的目的是在模块图中创建一个仅文件的模块节点。对于某些依赖项（例如通过 @import 引用的 CSS 文件）
   * 它们没有自己的 URL，因为它们被内联到主 CSS 导入中。但它们仍需要在模块图中表示，以便在导入的 CSS 文件中触发 HMR（热模块替换）
   * @param file
   * @returns
   */
  createFileOnlyEntry(file: string): ModuleNode {
    // 标准化文件路径
    file = normalizePath(file);

    // 获取或创建文件映射模块集合
    let fileMappedModules = this.fileToModulesMap.get(file);
    if (!fileMappedModules) {
      fileMappedModules = new Set();
      this.fileToModulesMap.set(file, fileMappedModules);
    }

    // 为文件生成一个 URL
    const url = `${FS_PREFIX}${file}`;
    // 检查该文件是否已经有对应的模块节点
    for (const m of fileMappedModules) {
      if (m.url === url || m.id === file) {
        return m;
      }
    }

    // 创建新的模块节点
    const mod = new ModuleNode(url);
    mod.file = file;
    fileMappedModules.add(mod);
    return mod;
  }

  /**
   * 用于解析传入的 URL
   *
   * 对于传入的url，重要的是：
   * 1. 移除 HMR 时间戳查询 (?t=xxxx) 和 ?import 查询
   *    1. HMR 时间戳查询：在开发环境中，热模块替换（HMR）机制常常会在 URL 中附加一个时间戳查询参数，
   *    如 ?t=xxxx，用于强制浏览器重新加载模块。这个查询参数可能会影响 URL 的唯一性
   *    ，因此在解析 URL 之前需要移除
   *    2. ?import 查询参数：某些模块可能会在 URL 中附加 ?import 查询参数。
   *    这种查询参数通常用于表示模块的导入方式或其他特定的用途。
   *    类似地，这个参数也需要在解析 URL 之前移除，以确保 URL 的唯一性和一致性。
   *
   * 2. 解析扩展名使得带有或不带扩展名的 URL 都映射到相同的模块
   *    1. 解析扩展名：不同的 URL 可能表示相同的模块，例如 module.js 和 module。
   *    为了避免这种情况下出现重复加载或缓存问题，需要统一解析扩展名，
   *    使得带有或不带扩展名的 URL 都能够映射到相同的模块
   *    2. 确保一致性：通过解析扩展名，可以确保所有形式的 URL（无论是否带有扩展名）都映射到同一个模块节点。
   *    这有助于保持模块图的一致性，避免重复的模块实例。
   *
   * 总结：
   * 1. 移除不必要的查询参数，确保 URL 的唯一性。
   * 2. 解析扩展名，确保所有形式的 URL 都映射到同一个模块节点。
   * @param url
   * @param ssr
   * @returns
   */
  async resolveUrl(url: string, ssr?: boolean): Promise<ResolvedUrl> {
    // 1. 移除 HMR 时间戳查询 (?t=xxxx) 和 ?import 查询
    url = removeImportQuery(removeTimestampQuery(url));

    // 2. 尝试获取未解析的 URL 对应的模块
    const mod = await this._getUnresolvedUrlToModule(url, ssr);
    if (mod?.id) {
      return [mod.url, mod.id, mod.meta];
    }

    // 如果没有找到对应的模块，则调用 _resolveUrl 解析 URL
    return this._resolveUrl(url, ssr);
  }

  /**
   * 用于更新模块的转换结果（TransformResult）
   * 它处理两种情况：SSR（服务器端渲染）和客户端渲染
   * @param mod 表示需要更新的模块节点
   * @param result 类型为 TransformResult | null，表示新的转换结果，可能为空
   * @param ssr 布尔值，指示是否为服务器端渲染。
   */
  updateModuleTransformResult(
    mod: ModuleNode,
    result: TransformResult | null,
    ssr: boolean
  ): void {
    if (ssr) {
      //如果是ssr 渲染，则更新模块的 ssrTransformResult 属性为新的转换结果 result
      mod.ssrTransformResult = result;
    } else {
      //客户端渲染，处理 etag 的映射，确保在更新转换结果时维护正确的 etag 映射关系

      //获取当前模块的转换结果中的 etag（实体标签，通常用于缓存）
      const prevEtag = mod.transformResult?.etag;
      //如果存在之前的 etag，则从 etagToModuleMap 映射中删除该 etag
      if (prevEtag) this.etagToModuleMap.delete(prevEtag);

      //将模块的转换结果更新为新的 result。
      mod.transformResult = result;
      //如果新的 result 中存在 etag，则在 etagToModuleMap 中添加新的 etag 和模块的映射。
      if (result?.etag) this.etagToModuleMap.set(result.etag, mod);
    }
  }

  getModuleByEtag(etag: string): ModuleNode | undefined {
    return this.etagToModuleMap.get(etag);
  }

  /**
   * 用于根据 URL 从未解析的 URL 到模块节点的映射中获取相应的模块节点
   * @internal
   */
  _getUnresolvedUrlToModule(
    url: string,
    ssr?: boolean
  ): Promise<ModuleNode> | ModuleNode | undefined {
    return (
      ssr ? this._ssrUnresolvedUrlToModuleMap : this._unresolvedUrlToModuleMap
    ).get(url);
  }
  /**
   * 用于设置 未解析的URL 与模块节点的映射
   * @internal
   */
  _setUnresolvedUrlToModule(
    url: string,
    mod: Promise<ModuleNode> | ModuleNode,
    ssr?: boolean
  ): void {
    (ssr
      ? this._ssrUnresolvedUrlToModuleMap
      : this._unresolvedUrlToModuleMap
    ).set(url, mod);
  }

  /**
   * 用于解析模块的 URL 并返回解析后的信息
   * @param url 表示需要解析的模块 URL
   * @param ssr
   * @param alreadyResolved 表示已经解析的信息（如果有的话）
   * @returns
   *
   * @internal
   */
  async _resolveUrl(
    url: string,
    ssr?: boolean,
    alreadyResolved?: PartialResolvedId
  ): Promise<ResolvedUrl> {
    //resolveId 调用了一个插件系统或内部逻辑来解析模块路径。

    //如果 alreadyResolved 已经提供，则使用它，否则调用 this.resolveId 异步解析 url
    const resolved = alreadyResolved ?? (await this.resolveId(url, !!ssr));
    //获取解析后的 ID，如果 resolved 为空，则使用原始 url
    const resolvedId = resolved?.id || url;

    //检查 url 是否与 resolvedId 不同，并且 url 不包含 \0 且不以 virtual: 开头。
    if (
      url !== resolvedId &&
      !url.includes("\0") &&
      !url.startsWith(`virtual:`)
    ) {
      /**
       * extname 方法用于获取文件的扩展名
       * cleanUrl 方法用于移除 URL 中的查询字符串或哈希部分，只保留路径部分。
       */
      //如果 resolvedId 有扩展名，则检查并调整 url 以确保其以相同的扩展名结尾。
      const ext = extname(cleanUrl(resolvedId));
      if (ext) {
        const pathname = cleanUrl(url);
        if (!pathname.endsWith(ext)) {
          url = pathname + ext + url.slice(pathname.length);
        }
      }
    }
    return [url, resolvedId, resolved?.meta];
  }
}
