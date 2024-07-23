import path from "node:path";
import { performance } from "node:perf_hooks";
import colors from "picocolors";
import MagicString from "magic-string";
import type {
  ParseError as EsModuleLexerParseError,
  ExportSpecifier,
  ImportSpecifier,
} from "es-module-lexer";
import { init, parse as parseImports } from "es-module-lexer";
import { parse as parseJS } from "acorn";
import type { Node } from "estree";
import { findStaticImports, parseStaticImport } from "mlly";
import { makeLegalIdentifier } from "@rollup/pluginutils";
import type { ViteDevServer } from "..";
import {
  CLIENT_DIR,
  CLIENT_PUBLIC_PATH,
  DEP_VERSION_RE,
  FS_PREFIX,
  SPECIAL_QUERY_RE,
} from "../constants";
import {
  // debugHmr,
  // handlePrunedModules,
  lexAcceptedHmrDeps,
  lexAcceptedHmrExports,
  normalizeHmrUrl,
} from "../server/hmr";
import {
  createDebugger,
  fsPathFromUrl,
  generateCodeFrame,
  injectQuery,
  isBuiltin,
  isDataUrl,
  isDefined,
  isExternalUrl,
  isInNodeModules,
  isJSRequest,
  joinUrlSegments,
  moduleListContains,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  stripBase,
  stripBomTag,
  timeFrom,
  transformStableResult,
  urlRE,
} from "../utils";
import { getFsUtils } from "../fsUtils";
import { checkPublicFile } from "../publicDir";
import { getDepOptimizationConfig } from "../config";
import type { ResolvedConfig } from "../config";
import type { Plugin } from "../plugin";
import { shouldExternalizeForSSR } from "../ssr/ssrExternal";
import { getDepsOptimizer, optimizedDepNeedsInterop } from "../optimizer";
import {
  cleanUrl,
  unwrapId,
  withTrailingSlash,
  wrapId,
} from "../../shared/utils";
import { throwOutdatedRequest } from "./optimizedDeps";
import { isCSSRequest, isDirectCSSRequest } from "./css";
import { browserExternalId } from "./resolve";
import { serializeDefine } from "./define";
import { WORKER_FILE_ID } from "./worker";
import { getAliasPatternMatcher } from "./preAlias";

const debug = createDebugger("vite:import-analysis");

const clientDir = normalizePath(CLIENT_DIR);

const skipRE = /\.(?:map|json)(?:$|\?)/;
export const canSkipImportAnalysis = (id: string): boolean =>
  skipRE.test(id) || isDirectCSSRequest(id);

const optimizedDepChunkRE = /\/chunk-[A-Z\d]{8}\.js/;
const optimizedDepDynamicRE = /-[A-Z\d]{8}\.js/;

export const hasViteIgnoreRE = /\/\*\s*@vite-ignore\s*\*\//;

const urlIsStringRE = /^(?:'.*'|".*"|`.*`)$/;

const templateLiteralRE = /^\s*`(.*)`\s*$/;

interface UrlPosition {
  url: string;
  start: number;
  end: number;
}

export function isExplicitImportRequired(url: string): boolean {
  return !isJSRequest(url) && !isCSSRequest(url);
}

function extractImportedBindings(
  id: string,
  source: string,
  importSpec: ImportSpecifier,
  importedBindings: Map<string, Set<string>>
) {
  let bindings = importedBindings.get(id);
  if (!bindings) {
    bindings = new Set<string>();
    importedBindings.set(id, bindings);
  }

  const isDynamic = importSpec.d > -1;
  const isMeta = importSpec.d === -2;
  if (isDynamic || isMeta) {
    // this basically means the module will be impacted by any change in its dep
    bindings.add("*");
    return;
  }

  const exp = source.slice(importSpec.ss, importSpec.se);
  const [match0] = findStaticImports(exp);
  if (!match0) {
    return;
  }
  const parsed = parseStaticImport(match0);
  if (!parsed) {
    return;
  }
  if (parsed.namespacedImport) {
    bindings.add("*");
  }
  if (parsed.defaultImport) {
    bindings.add("default");
  }
  if (parsed.namedImports) {
    for (const name of Object.keys(parsed.namedImports)) {
      bindings.add(name);
    }
  }
}

/**
 * Server-only plugin that lexes, resolves, rewrites and analyzes url imports.
 *
 * - Imports are resolved to ensure they exist on disk
 *
 * - Lexes HMR accept calls and updates import relationships in the module graph
 *
 * - Bare module imports are resolved (by @rollup-plugin/node-resolve) to
 * absolute file paths, e.g.
 *
 *     ```js
 *     import 'foo'
 *     ```
 *     is rewritten to
 *     ```js
 *     import '/@fs//project/node_modules/foo/dist/foo.js'
 *     ```
 *
 * - CSS imports are appended with `.js` since both the js module and the actual
 * css (referenced via `<link>`) may go through the transform pipeline:
 *
 *     ```js
 *     import './style.css'
 *     ```
 *     is rewritten to
 *     ```js
 *     import './style.css.js'
 *     ```
 *
 *
 * 这个插件的主要功能是对 URL 导入（import）进行词法分析、解析、重写
 *
 * 1. 导入的解析：确保导入的文件在磁盘上存在
 * 这一步确保导入的模块在磁盘上实际存在。如果你在代码中导入了一个模块，
 * 插件会检查这个模块的路径是否在磁盘上存在，以防止引用不存在的模块导致错误。
 *
 * 2. 热模块替换（HMR）：词法分析 HMR 的 accept 调用，并在模块图中更新导入关系。
 * 词法分析（lexing）是将代码分解成最小的语法单元（tokens）
 * HMR是一种在运行时替换、添加或删除模块，而无需重新加载整个页面的技术
 * 这个插件会分析代码中的 HMR 接受调用，并在模块图中更新导入关系。这有助于在开发过程中高效地替换模块而不会影响页面的状态。
 *
 * 3. 裸模块导入的解析：将裸模块导入解析为绝对文件路径（由 @rollup-plugin/node-resolve 处理）
 * @example
 * import 'foo'   ---> import '/@fs//project/node_modules/foo/dist/foo.js'
 * 这种转换确保所有的导入路径都是明确且可解析的
 *
 * 4. CSS 导入的处理：：将 CSS 导入附加 .js 后缀，因为 JS 模块和实际的 CSS（通过 <link> 引用）都可能需要经过转换管道
 * @example
 * import './style.css'   ----> import './style.css.js'
 * 这样做是为了确保即使是 CSS 文件也可以被正确处理，并且可以在需要时进行进一步的转换或操作
 *
 */
export function importAnalysisPlugin(config: ResolvedConfig): Plugin {
  const { root, base } = config;
  // 获取文件系统工具
  const fsUtils = getFsUtils(config);

  /**客户端公共路径 */
  const clientPublicPath = path.posix.join(base, CLIENT_PUBLIC_PATH);
  /**表示是否启用部分热模块替换（HMR）功能 */
  const enablePartialAccept = config.experimental?.hmrPartialAccept;
  /**别名匹配器 */
  const matchAlias = getAliasPatternMatcher(config.resolve.alias);
  /**用于存储开发服务器实例 */
  let server: ViteDevServer;

  /**用于缓存非（SSR）环境变量字符串 */
  let _env: string | undefined;
  /**用于缓存（SSR）环境变量字符串 */
  let _ssrEnv: string | undefined;
  function getEnv(ssr: boolean) {
    if (!_ssrEnv || !_env) {
      // 检查 _ssrEnv 和 _env 是否已被初始化
      // 如果没有执行初始化，否则直接返回环境变量

      /**用于存储 import.meta.env 的键值对 */
      const importMetaEnvKeys: Record<string, any> = {};
      /**用于存储用户自定义的 import.meta.env 键值对 */
      const userDefineEnv: Record<string, any> = {};

      // 遍历 config.env 对象，将每个键值对添加到 importMetaEnvKeys 中
      for (const key in config.env) {
        importMetaEnvKeys[key] = JSON.stringify(config.env[key]);
      }

      // 遍历 config.define 对象，如果键以 import.meta.env. 开头，则将其添加到 userDefineEnv 中，并去掉前缀
      for (const key in config.define) {
        // non-import.meta.env.* is handled in `clientInjection` plugin
        if (key.startsWith("import.meta.env.")) {
          userDefineEnv[key.slice(16)] = config.define[key];
        }
      }

      const env = `import.meta.env = ${serializeDefine({
        ...importMetaEnvKeys,
        SSR: "__vite_ssr__",
        ...userDefineEnv,
      })};`;
      _ssrEnv = env.replace("__vite_ssr__", "true");
      _env = env.replace("__vite_ssr__", "false");
    }
    return ssr ? _ssrEnv : _env;
  }

  return {
    name: "vite:import-analysis",

    /**
     * 这个函数在服务器启动时调用，存储 Vite 服务器实例，以便在 transform 函数中使用
     * @param _server
     */
    configureServer(_server) {
      server = _server;
    },

    /**
     * 这里解析、重写和分析 URL 导入
     * @param source
     * @param importer
     * @param options
     * @returns
     */
    async transform(source, importer, options) {
      // 在真实应用中 server 变量总是有定义的，但在运行特定测试文件
      // src/node/server/__tests__/pluginContainer.spec.ts 时，server 变量会是未定义的
      // 这是因为测试环境和真实应用环境有区别，测试中可能没有启动或模拟完整的服务器实例
      if (!server) {
        return null;
      }

      const ssr = options?.ssr === true;

      // 检查是否可以跳过对 importer 的导入分析
      if (canSkipImportAnalysis(importer)) {
        debug?.(colors.dim(`[skipped] ${prettifyUrl(importer, root)}`));
        return null;
      }
      // 记录当前时间，用于性能分析
      const msAtStart = debug ? performance.now() : 0;
      // 等待初始化过程完成。init 可能是一个异步操作，确保在继续处理之前所有必要的初始化都已完成。
      await init;
      // 存储导入导出
      let imports!: readonly ImportSpecifier[];
      let exports!: readonly ExportSpecifier[];
      // 用于去除源码中的 BOM 标签
      source = stripBomTag(source);
      try {
        // 解析源码中的导入和导出
        [imports, exports] = parseImports(source);
      } catch (_e: unknown) {
        const e = _e as EsModuleLexerParseError;
        const { message, showCodeFrame } = createParseErrorInfo(
          importer,
          source
        );
        this.error(message, showCodeFrame ? e.idx : undefined);
      }

      // 获取依赖优化器
      const depsOptimizer = getDepsOptimizer(config, ssr);
      // 提取模块图
      const { moduleGraph } = server;
      // since we are already in the transform phase of the importer, it must
      // have been loaded so its entry is guaranteed in the module graph.
      // 从模块图中获取指定 ID（即 importer）的模块
      const importerModule = moduleGraph.getModuleById(importer)!;

      // 检查 importerModule 是否存在
      if (!importerModule) {
        // This request is no longer valid. It could happen for optimized deps
        // requests. A full reload is going to request this id again.
        // Throwing an outdated error so we properly finish the request with a
        // 504 sent to the browser.
        /**
         * 如果模块不存在，则表示请求不再有效，可能是由于优化依赖请求的原因导致的
         * 调用 throwOutdatedRequest(importer) 函数来处理这个过期的请求
         * 这个函数会抛出一个错误，通常会返回一个 504 错误到浏览器，表示请求超时或资源不可用
         *
         * 需要全量重新加载：
         * 系统将执行一次完全重新加载。这意味着浏览器将重新加载整个页面，从而重新请求所有的模块，
         * 包括之前无效的那个模块。这是为了确保模块图和依赖关系能够得到正确更新和处理。
         */
        throwOutdatedRequest(importer);
      }

      if (!imports.length && !(this as any)._addedImports) {
        // 当前模块是否没有导入 且 新的导入 属性不存在

        // 如果没有新的导入，当前模块不支持自我接受（self-accepting），即它不会处理自己的热更新（HMR）请求
        importerModule.isSelfAccepting = false;
        debug?.(
          `${timeFrom(msAtStart)} ${colors.dim(
            `[no imports] ${prettifyUrl(importer, root)}`
          )}`
        );
        // 返回原始源代码，不进行进一步处理
        return source;
      }

      /**指示是否需要处理热模块替换 */
      let hasHMR = false;
      /**指示当前模块是否支持自我接受 */
      let isSelfAccepting = false;
      /**是否存在环境变量 */
      let hasEnv = false;
      /**示是否需要注入查询帮助 */
      let needQueryInjectHelper = false;
      let s: MagicString | undefined;
      const str = () => s || (s = new MagicString(source));
      /**模块是否部分支持自我接受 */
      let isPartiallySelfAccepting = false;
      /**如果启用了部分接受（enablePartialAccept 为真），则初始化一个 Map 用于跟踪导入的绑定。否则，设置为 null */
      const importedBindings = enablePartialAccept
        ? new Map<string, Set<string>>()
        : null;
      /**将相对 URL 转换为绝对 URL */
      const toAbsoluteUrl = (url: string) =>
        path.posix.resolve(path.posix.dirname(importerModule.url), url);

      /**
       * 用于解析和规范化 URL 以适应构建和模块解析过程中的需求
       * @param url
       * @param pos
       * @param forceSkipImportAnalysis
       * @returns
       */
      const normalizeUrl = async (
        url: string,
        pos: number,
        forceSkipImportAnalysis: boolean = false
      ): Promise<[string, string]> => {
        // 移除 URL 中的基本路径部分（base），得到相对路径或简化的 URL
        url = stripBase(url, base);

        /**当前的导入文件 */
        let importerFile = importer;

        /**获取依赖优化配置 */
        const optimizeDeps = getDepOptimizationConfig(config, ssr);

        if (moduleListContains(optimizeDeps?.exclude, url)) {
          // 检查当前 URL 是否在排除的模块列表中

          // 如果在排除列表中，等待依赖优化器的扫描处理完成
          if (depsOptimizer) {
            await depsOptimizer.scanProcessing;

            // if the dependency encountered in the optimized file was excluded from the optimization
            // the dependency needs to be resolved starting from the original source location of the optimized file
            // because starting from node_modules/.vite will not find the dependency if it was not hoisted
            // (that is, if it is under node_modules directory in the package source of the optimized file)
            for (const optimizedModule of depsOptimizer.metadata.depInfoList) {
              if (!optimizedModule.src) continue; // Ignore chunks
              if (optimizedModule.file === importerModule.file) {
                importerFile = optimizedModule.src;
              }
            }
          }
        }

        /**
         * 解析 URL 到绝对路径或模块标识符
         * 这里调用了pluginContainer 身上的 resolve 方法
         */
        const resolved = await this.resolve(url, importerFile);

        if (!resolved || resolved.meta?.["vite:alias"]?.noResolved) {
          // 模块解析失败 或者 noResolved 为真，表示这是一个特定处理的别名，可能指示该模块没有被实际解析

          // 在ssr中，我们应该让node处理缺失的模块
          // 这意味着在 SSR 环境中，模块解析失败不会中断流程，允许 Node.js 处理这些缺失的模块。
          if (ssr) {
            return [url, url];
          }

          // fix#9534, prevent the importerModuleNode being stopped from propagating updates
          // 将当前 importerModule 的 isSelfAccepting 标记为 false，表示该模块不支持自我接受更新
          // 这是为了防止在 HMR（热模块替换）过程中，该模块停止传播更新
          importerModule.isSelfAccepting = false;
          // 将解析失败的模块加入到 moduleGraph._hasResolveFailedErrorModules 集合中，以便后续处理
          moduleGraph._hasResolveFailedErrorModules.add(importerModule);
          return this.error(
            `Failed to resolve import "${url}" from "${normalizePath(
              path.relative(process.cwd(), importerFile)
            )}". Does the file exist?`,
            pos
          );
        }

        // 如果解析结果是外部 URL，直接返回
        if (isExternalUrl(resolved.id)) {
          return [resolved.id, resolved.id];
        }

        /**判断 URL 是否为相对路径 */
        const isRelative = url[0] === ".";
        /**判断是否为自身模块导入 */
        const isSelfImport =
          !isRelative && cleanUrl(url) === cleanUrl(importer);

        // normalize all imports into resolved URLs
        // e.g. `import 'foo'` -> `import '/@fs/.../node_modules/foo/index.js'`
        /**
         * 这段代码负责将模块的导入路径规范化为解析后的 URL
         * 它确保导入的 URL 都转换成符合项目要求的绝对路径或其他有效的路径格式
         */
        // 检查解析后的 ID 是否以根路径开头
        if (resolved.id.startsWith(withTrailingSlash(root))) {
          // 移除根路径部分，使 URL 更简洁
          url = resolved.id.slice(root.length);
        } else if (
          // 处理优化的依赖项或存在于文件系统中的情况

          // 检查解析后的 ID 是否是优化的依赖项，如果是，可能不在文件系统中，所以需要特殊处理
          depsOptimizer?.isOptimizedDepFile(resolved.id) ||
          // vite-plugin-react isn't following the leading \0 virtual module convention.
          // This is a temporary hack to avoid expensive fs checks for React apps.
          // We'll remove this as soon we're able to fix the react plugins.
          /**
           * 这段注释涉及 Vite 在处理 React 插件时的一个临时解决方案
           * Vite 通过以 \0 开头的虚拟模块约定来处理虚拟模块（如某些插件生成的虚拟模块）
           * 这种约定通常用于识别和处理特殊的模块，比如插件生成的非实际文件
           * 然而，vite-plugin-react 插件没有遵循这个约定，因此需要处理这些模块的不同方式
           * 这是一个临时解决方案，用于避免对 React 应用进行昂贵的文件系统检查
           * Vite 的开发团队计划在未来修复 vite-plugin-react 插件以符合虚拟模块约定后，移除这个临时的处理逻辑
           */
          // 排除特定的虚拟模块（例如 @react-refresh）
          (resolved.id !== "/@react-refresh" &&
            // 如果解析的 ID 是绝对路径且文件系统中存在
            path.isAbsolute(resolved.id) &&
            fsUtils.existsSync(cleanUrl(resolved.id)))
        ) {
          /**
           * 优化后的dep文件（预构建过程中对依赖项做的缓存）可能还不存在于文件系统中，
           * 或者一个常规文件存在但不在根目录下:重写为绝对/@fs/ paths
           */
          url = path.posix.join(FS_PREFIX, resolved.id);
        } else {
          // 上述条件都不满足直接使用解析后的 ID 作为 URL
          url = resolved.id;
        }

        /**
         * 这里的代码处理的是如何确保导入的模块 URL 在浏览器中有效的问题
         * 如果解析后的模块 ID 不是有效的浏览器路径（即不是相对路径、绝对路径或有效的模块名称），
         * 就会添加一个前缀以使其有效。在转换完成后，前缀会被移除，以确保模块可以正常地传递到下一个处理步骤。
         */
        // 判断 URL 是否以 . 或 / 开头  ./ 和 ../ 表示相对路径，而 / 表示绝对路径
        // 如果 URL 既不是相对路径也不是绝对路径，说明它不是一个有效的浏览器导入路径。
        // 有效的浏览器导入路径应以 . 或 / 开头，或是有效的模块名称
        if (url[0] !== "." && url[0] !== "/") {
          // wrapId 是一个函数，用于为不符合浏览器导入规范的 URL 添加一个前缀，使其成为有效的导入规范符
          // 这通常是为了确保 URL 可以被浏览器识别并正确加载
          url = wrapId(resolved.id);
        }

        /**
         * 这段代码的目的是在非（SSR）环境中确保 URL 对浏览器是有效的，并进行一系列处理来优化模块的加载
         */
        if (!ssr) {
          // 对于非 JS/CSS 导入（例如某些特殊模块或资源），需要在 URL 后添加 ?import 查询参数。
          // 判断 URL 是否需要明确标记为导入，
          if (isExplicitImportRequired(url)) {
            url = injectQuery(url, "import");
          } else if (
            // URL 是相对路径或自模块虚拟导入
            (isRelative || isSelfImport) &&
            // 并且 URL 不包含版本查询
            !DEP_VERSION_RE.test(url)
          ) {
            // If the url isn't a request for a pre-bundled common chunk,
            // for relative js/css imports, or self-module virtual imports
            // (e.g. vue blocks), inherit importer's version query
            // do not do this for unknown type imports, otherwise the appended
            // query can break 3rd party plugin's extension checks.

            /**
             * 注释的内容解释了为什么需要处理版本查询参数：
             * 1. 非预打包公共块的请求: 代码块不适用于预打包的公共模块（例如，预处理的通用模块）请求
             *
             * 2. 相对的 js/css 导入: 对于相对路径的 JavaScript 或 CSS 导入，这种处理是有必要的。
             *
             * 3. 自模块虚拟导入: 对于自模块虚拟导入（例如，Vue 块），这种处理也很重要
             *
             * 4. 避免对未知类型的导入进行处理: 对于未知类型的导入，例如，某些第三方插件生成的模块
             * 附加查询参数可能会干扰第三方插件的扩展检查，这是因为这些插件可能依赖于特定的 URL 格式，
             * 如果 URL 被意外修改，则可能导致插件无法正确识别和处理模块。因此不对这些类型的导入进行处理
             *
             *
             * 为什么需要继承版本？
             * 在构建工具（如 Vite）中，模块 ID 可能包含版本查询参数，这有助于管理缓存和版本控制。
             * 为了保持模块的一致性和避免缓存问题，在处理导入时，需要将导入者的版本查询参数传递给当前的模块。
             * @example
             * 如果模块 A 导入了模块 B，而模块 B 已经附加了版本查询参数，则模块 A 在导入模块 B 时也应该带上相同的版本查询参数
             * 这有助于确保在开发过程中，模块始终是最新的，并且任何修改都会得到正确的处理
             */

            // 继承导入者的版本查询
            // 用于匹配模块导入中的版本查询部分。它会从导入者的 ID 中提取出版本查询参数（例如，?v=123456）
            const versionMatch = importer.match(DEP_VERSION_RE);
            if (versionMatch) {
              // versionMatch 存储了从导入者的 ID 中提取出的版本查询信息
              // 如果找到了匹配的版本信息，就会调用 injectQuery 函数，将版本查询参数附加到当前的 url 上
              url = injectQuery(url, versionMatch[1]);
            }
          }

          // check if the dep has been hmr updated. If yes, we need to attach
          // its last updated timestamp to force the browser to fetch the most
          // up-to-date version of this module.
          /**
           * 这段代码主要涉及到处理模块的 HMR（热模块替换）更新，并确保浏览器能够获取到最新版本的模块
           *
           * 检查模块是否进行了热模块替换（HMR）更新
           * 如果是，附加模块的最后更新时间戳到 URL，以强制浏览器获取最新版本的模块
           */
          try {
            // delay setting `isSelfAccepting` until the file is actually used (#7870)
            // We use an internal function to avoid resolving the url again
            /**
             * 使用一个内部函数（moduleGraph._ensureEntryFromUrl）来获取模块的 HMR 时间戳，可以避免重新解析 URL
             * 解析 URL 可能是一个昂贵的操作，特别是当涉及到文件系统访问或者复杂的路径转换时
             *
             * 内部函数可能会利用缓存或优化机制来快速获取模块的信息，
             * 而不是每次都从头开始解析。这种做法有助于减少计算开销和提高性能。
             */

            // 用于确保模块图中有模块的条目
            const depModule = await moduleGraph._ensureEntryFromUrl(
              // 从 URL 中提取模块 ID，前面我们提到了为了确保url的有效性，会在url添加特定的前缀，并且会在之后的处理移除改前缀
              // 这里就是移除前缀的地方
              unwrapId(url),
              ssr,
              canSkipImportAnalysis(url) || forceSkipImportAnalysis,
              resolved
            );

            // 模块的最后更新时间戳
            if (depModule.lastHMRTimestamp > 0) {
              // 表示模块已更新
              // 通过 injectQuery 函数将时间戳作为查询参数附加到 URL，以确保浏览器获取最新版本的模块
              url = injectQuery(url, `t=${depModule.lastHMRTimestamp}`);
            }
          } catch (e: any) {
            // 如果在解析模块时发生错误（例如，模块无法解析或不存在），
            // 捕获异常并将其位置（pos）附加到错误对象中，然后重新抛出错误。这可以帮助调试和跟踪问题。
            e.pos = pos;
            throw e;
          }

          /**
           * 在构建工具如 Vite 中，基础路径 (base) 是一个配置项，用于指定静态资源的基础路径。
           * 例如，如果你在项目中使用了静态文件（如图片、样式表等），
           * 这些文件的引用通常需要基于项目的基础路径来进行调整。这是为了确保在构建和部署过程中，静态文件能正确地被访问。
           */
          // 这段代码的目的是将基础路径 (base) 预pend到 URL 的前面，以生成一个完整的 URL
          // 在一开始的时候，我们将base从url中移除，以便简化，方便处理，这里我们将url恢复
          url = joinUrlSegments(base, url);
        }

        return [url, resolved.id];
      };

      // 在处理模块导入和导出时，Vite 需要跟踪和管理不同类型的数据。这些数组的定义是为了有效地存储和组织这些数据
      /**用于存储和跟踪每个导入的 URL，确保导入顺序正确 */
      const orderedImportedUrls = new Array<string | undefined>(imports.length);
      /**用于跟踪和管理每个导入 URL 的接受位置。这有助于处理热模块替换 (HMR) 时的模块更新 */
      const orderedAcceptedUrls = new Array<Set<UrlPosition> | undefined>(
        imports.length
      );
      /**用于存储和管理每个导入的接受导出，帮助处理模块之间的依赖关系和导出。 */
      const orderedAcceptedExports = new Array<Set<string> | undefined>(
        imports.length
      );

      await Promise.all(
        imports.map(async (importSpecifier, index) => {
          const {
            s: start,
            e: end,
            ss: expStart,
            se: expEnd,
            d: dynamicIndex,
            a: attributeIndex,
          } = importSpecifier;

          // #2083 User may use escape path,
          // so use imports[index].n to get the unescaped string
          let specifier = importSpecifier.n;

          const rawUrl = source.slice(start, end);

          // check import.meta usage
          if (rawUrl === "import.meta") {
            const prop = source.slice(end, end + 4);
            if (prop === ".hot") {
              hasHMR = true;
              const endHot = end + 4 + (source[end + 4] === "?" ? 1 : 0);
              if (source.slice(endHot, endHot + 7) === ".accept") {
                // further analyze accepted modules
                if (source.slice(endHot, endHot + 14) === ".acceptExports") {
                  const importAcceptedExports = (orderedAcceptedExports[index] =
                    new Set<string>());
                  lexAcceptedHmrExports(
                    source,
                    source.indexOf("(", endHot + 14) + 1,
                    importAcceptedExports
                  );
                  isPartiallySelfAccepting = true;
                } else {
                  const importAcceptedUrls = (orderedAcceptedUrls[index] =
                    new Set<UrlPosition>());
                  if (
                    lexAcceptedHmrDeps(
                      source,
                      source.indexOf("(", endHot + 7) + 1,
                      importAcceptedUrls
                    )
                  ) {
                    isSelfAccepting = true;
                  }
                }
              }
            } else if (prop === ".env") {
              hasEnv = true;
            }
            return;
          } else if (templateLiteralRE.test(rawUrl)) {
            // If the import has backticks but isn't transformed as a glob import
            // (as there's nothing to glob), check if it's simply a plain string.
            // If so, we can replace the specifier as a plain string to prevent
            // an incorrect "cannot be analyzed" warning.
            if (!(rawUrl.includes("${") && rawUrl.includes("}"))) {
              specifier = rawUrl.replace(templateLiteralRE, "$1");
            }
          }

          const isDynamicImport = dynamicIndex > -1;

          // strip import attributes as we can process them ourselves
          if (!isDynamicImport && attributeIndex > -1) {
            str().remove(end + 1, expEnd);
          }

          // static import or valid string in dynamic import
          // If resolvable, let's resolve it
          if (specifier !== undefined) {
            // skip external / data uri
            if (isExternalUrl(specifier) || isDataUrl(specifier)) {
              return;
            }
            // skip ssr external
            if (ssr && !matchAlias(specifier)) {
              if (shouldExternalizeForSSR(specifier, importer, config)) {
                return;
              }
              if (isBuiltin(specifier)) {
                return;
              }
            }
            // skip client
            if (specifier === clientPublicPath) {
              return;
            }

            // warn imports to non-asset /public files
            if (
              specifier[0] === "/" &&
              !(
                config.assetsInclude(cleanUrl(specifier)) ||
                urlRE.test(specifier)
              ) &&
              checkPublicFile(specifier, config)
            ) {
              throw new Error(
                `Cannot import non-asset file ${specifier} which is inside /public. ` +
                  `JS/CSS files inside /public are copied as-is on build and ` +
                  `can only be referenced via <script src> or <link href> in html. ` +
                  `If you want to get the URL of that file, use ${injectQuery(
                    specifier,
                    "url"
                  )} instead.`
              );
            }

            // normalize
            const [url, resolvedId] = await normalizeUrl(specifier, start);

            // record as safe modules
            // safeModulesPath should not include the base prefix.
            // See https://github.com/vitejs/vite/issues/9438#issuecomment-1465270409
            server?.moduleGraph.safeModulesPath.add(
              fsPathFromUrl(stripBase(url, base))
            );

            if (url !== specifier) {
              let rewriteDone = false;
              if (
                depsOptimizer?.isOptimizedDepFile(resolvedId) &&
                !optimizedDepChunkRE.test(resolvedId)
              ) {
                // for optimized cjs deps, support named imports by rewriting named imports to const assignments.
                // internal optimized chunks don't need es interop and are excluded

                // The browserHash in resolvedId could be stale in which case there will be a full
                // page reload. We could return a 404 in that case but it is safe to return the request
                const file = cleanUrl(resolvedId); // Remove ?v={hash}

                const needsInterop = await optimizedDepNeedsInterop(
                  depsOptimizer.metadata,
                  file,
                  config,
                  ssr
                );

                if (needsInterop === undefined) {
                  // Non-entry dynamic imports from dependencies will reach here as there isn't
                  // optimize info for them, but they don't need es interop. If the request isn't
                  // a dynamic import, then it is an internal Vite error
                  if (!optimizedDepDynamicRE.test(file)) {
                    config.logger.error(
                      colors.red(
                        `Vite Error, ${url} optimized info should be defined`
                      )
                    );
                  }
                } else if (needsInterop) {
                  debug?.(`${url} needs interop`);
                  interopNamedImports(
                    str(),
                    importSpecifier,
                    url,
                    index,
                    importer,
                    config
                  );
                  rewriteDone = true;
                }
              }
              // If source code imports builtin modules via named imports, the stub proxy export
              // would fail as it's `export default` only. Apply interop for builtin modules to
              // correctly throw the error message.
              else if (
                url.includes(browserExternalId) &&
                source.slice(expStart, start).includes("{")
              ) {
                interopNamedImports(
                  str(),
                  importSpecifier,
                  url,
                  index,
                  importer,
                  config
                );
                rewriteDone = true;
              }
              if (!rewriteDone) {
                const rewrittenUrl = JSON.stringify(url);
                const s = isDynamicImport ? start : start - 1;
                const e = isDynamicImport ? end : end + 1;
                str().overwrite(s, e, rewrittenUrl, {
                  contentOnly: true,
                });
              }
            }

            // record for HMR import chain analysis
            // make sure to unwrap and normalize away base
            const hmrUrl = unwrapId(stripBase(url, base));
            const isLocalImport = !isExternalUrl(hmrUrl) && !isDataUrl(hmrUrl);
            if (isLocalImport) {
              orderedImportedUrls[index] = hmrUrl;
            }

            if (enablePartialAccept && importedBindings) {
              extractImportedBindings(
                resolvedId,
                source,
                importSpecifier,
                importedBindings
              );
            }

            if (
              !isDynamicImport &&
              isLocalImport &&
              config.server.preTransformRequests
            ) {
              // pre-transform known direct imports
              // These requests will also be registered in transformRequest to be awaited
              // by the deps optimizer
              const url = removeImportQuery(hmrUrl);
              server.warmupRequest(url, { ssr });
            }
          } else if (!importer.startsWith(withTrailingSlash(clientDir))) {
            if (!isInNodeModules(importer)) {
              // check @vite-ignore which suppresses dynamic import warning
              const hasViteIgnore = hasViteIgnoreRE.test(
                // complete expression inside parens
                source.slice(dynamicIndex + 1, end)
              );
              if (!hasViteIgnore) {
                this.warn(
                  `\n` +
                    colors.cyan(importerModule.file) +
                    `\n` +
                    colors.reset(generateCodeFrame(source, start, end)) +
                    colors.yellow(
                      `\nThe above dynamic import cannot be analyzed by Vite.\n` +
                        `See ${colors.blue(
                          `https://github.com/rollup/plugins/tree/master/packages/dynamic-import-vars#limitations`
                        )} ` +
                        `for supported dynamic import formats. ` +
                        `If this is intended to be left as-is, you can use the ` +
                        `/* @vite-ignore */ comment inside the import() call to suppress this warning.\n`
                    )
                );
              }
            }

            if (!ssr) {
              if (
                !urlIsStringRE.test(rawUrl) ||
                isExplicitImportRequired(rawUrl.slice(1, -1))
              ) {
                needQueryInjectHelper = true;
                str().overwrite(
                  start,
                  end,
                  `__vite__injectQuery(${rawUrl}, 'import')`,
                  { contentOnly: true }
                );
              }
            }
          }
        })
      );

      const _orderedImportedUrls = orderedImportedUrls.filter(isDefined);
      const importedUrls = new Set(_orderedImportedUrls);
      // `importedUrls` will be mixed with watched files for the module graph,
      // `staticImportedUrls` will only contain the static top-level imports and
      // dynamic imports
      const staticImportedUrls = new Set(
        _orderedImportedUrls.map((url) => removeTimestampQuery(url))
      );
      const acceptedUrls = mergeAcceptedUrls(orderedAcceptedUrls);
      const acceptedExports = mergeAcceptedUrls(orderedAcceptedExports);

      // While we always expect to work with ESM, a classic worker is the only
      // case where it's not ESM and we need to avoid injecting ESM-specific code
      const isClassicWorker =
        importer.includes(WORKER_FILE_ID) && importer.includes("type=classic");

      if (hasEnv && !isClassicWorker) {
        // inject import.meta.env
        str().prepend(getEnv(ssr));
      }

      if (hasHMR && !ssr && !isClassicWorker) {
        // debugHmr?.(
        //   `${
        //     isSelfAccepting
        //       ? `[self-accepts]`
        //       : isPartiallySelfAccepting
        //       ? `[accepts-exports]`
        //       : acceptedUrls.size
        //       ? `[accepts-deps]`
        //       : `[detected api usage]`
        //   } ${prettifyUrl(importer, root)}`
        // );

        // inject hot context
        str().prepend(
          `import { createHotContext as __vite__createHotContext } from "${clientPublicPath}";` +
            `import.meta.hot = __vite__createHotContext(${JSON.stringify(
              normalizeHmrUrl(importerModule.url)
            )});`
        );
      }

      if (needQueryInjectHelper) {
        if (isClassicWorker) {
          str().append("\n" + __vite__injectQuery.toString());
        } else {
          str().prepend(
            `import { injectQuery as __vite__injectQuery } from "${clientPublicPath}";`
          );
        }
      }

      // normalize and rewrite accepted urls
      const normalizedAcceptedUrls = new Set<string>();
      for (const { url, start, end } of acceptedUrls) {
        const [normalized] = await moduleGraph.resolveUrl(
          toAbsoluteUrl(url),
          ssr
        );
        normalizedAcceptedUrls.add(normalized);
        str().overwrite(start, end, JSON.stringify(normalized), {
          contentOnly: true,
        });
      }

      // update the module graph for HMR analysis.
      // node CSS imports does its own graph update in the css-analysis plugin so we
      // only handle js graph updates here.
      // note that we want to handle .css?raw and .css?url here
      if (!isCSSRequest(importer) || SPECIAL_QUERY_RE.test(importer)) {
        // attached by pluginContainer.addWatchFile
        const pluginImports = (this as any)._addedImports as
          | Set<string>
          | undefined;
        if (pluginImports) {
          (
            await Promise.all(
              [...pluginImports].map((id) => normalizeUrl(id, 0, true))
            )
          ).forEach(([url]) => importedUrls.add(url));
        }
        // HMR transforms are no-ops in SSR, so an `accept` call will
        // never be injected. Avoid updating the `isSelfAccepting`
        // property for our module node in that case.
        if (ssr && importerModule.isSelfAccepting) {
          isSelfAccepting = true;
        }
        // a partially accepted module that accepts all its exports
        // behaves like a self-accepted module in practice
        if (
          !isSelfAccepting &&
          isPartiallySelfAccepting &&
          acceptedExports.size >= exports.length &&
          exports.every((e) => acceptedExports.has(e.n))
        ) {
          isSelfAccepting = true;
        }
        const prunedImports = await moduleGraph.updateModuleInfo(
          importerModule,
          importedUrls,
          importedBindings,
          normalizedAcceptedUrls,
          isPartiallySelfAccepting ? acceptedExports : null,
          isSelfAccepting,
          ssr,
          staticImportedUrls
        );
        if (hasHMR && prunedImports) {
          //   handlePrunedModules(prunedImports, server);
        }
      }

      debug?.(
        `${timeFrom(msAtStart)} ${colors.dim(
          `[${importedUrls.size} imports rewritten] ${prettifyUrl(
            importer,
            root
          )}`
        )}`
      );

      if (s) {
        return transformStableResult(s, importer, config);
      } else {
        return source;
      }
    },
  };
}

function mergeAcceptedUrls<T>(orderedUrls: Array<Set<T> | undefined>) {
  const acceptedUrls = new Set<T>();
  for (const urls of orderedUrls) {
    if (!urls) continue;
    for (const url of urls) acceptedUrls.add(url);
  }
  return acceptedUrls;
}

export function createParseErrorInfo(
  importer: string,
  source: string
): { message: string; showCodeFrame: boolean } {
  const isVue = importer.endsWith(".vue");
  const isJsx = importer.endsWith(".jsx") || importer.endsWith(".tsx");
  const maybeJSX = !isVue && isJSRequest(importer);
  const probablyBinary = source.includes(
    "\ufffd" /* unicode replacement character */
  );

  const msg = isVue
    ? `Install @vitejs/plugin-vue to handle .vue files.`
    : maybeJSX
    ? isJsx
      ? `If you use tsconfig.json, make sure to not set jsx to preserve.`
      : `If you are using JSX, make sure to name the file with the .jsx or .tsx extension.`
    : `You may need to install appropriate plugins to handle the ${path.extname(
        importer
      )} file format, or if it's an asset, add "**/*${path.extname(
        importer
      )}" to \`assetsInclude\` in your configuration.`;

  return {
    message:
      `Failed to parse source for import analysis because the content ` +
      `contains invalid JS syntax. ` +
      msg,
    showCodeFrame: !probablyBinary,
  };
}
// prettier-ignore
const interopHelper = (m: any) => m?.__esModule ? m : { ...(typeof m === 'object' && !Array.isArray(m) || typeof m === 'function' ? m : {}), default: m }

export function interopNamedImports(
  str: MagicString,
  importSpecifier: ImportSpecifier,
  rewrittenUrl: string,
  importIndex: number,
  importer: string,
  config: ResolvedConfig
): void {
  const source = str.original;
  const {
    s: start,
    e: end,
    ss: expStart,
    se: expEnd,
    d: dynamicIndex,
  } = importSpecifier;
  const exp = source.slice(expStart, expEnd);
  if (dynamicIndex > -1) {
    // rewrite `import('package')` to expose the default directly
    str.overwrite(
      expStart,
      expEnd,
      `import('${rewrittenUrl}').then(m => (${interopHelper.toString()})(m.default))` +
        getLineBreaks(exp),
      { contentOnly: true }
    );
  } else {
    const rawUrl = source.slice(start, end);
    const rewritten = transformCjsImport(
      exp,
      rewrittenUrl,
      rawUrl,
      importIndex,
      importer,
      config
    );
    if (rewritten) {
      str.overwrite(expStart, expEnd, rewritten + getLineBreaks(exp), {
        contentOnly: true,
      });
    } else {
      // #1439 export * from '...'
      str.overwrite(
        start,
        end,
        rewrittenUrl + getLineBreaks(source.slice(start, end)),
        {
          contentOnly: true,
        }
      );
    }
  }
}

// get line breaks to preserve line count for not breaking source maps
function getLineBreaks(str: string) {
  return str.includes("\n") ? "\n".repeat(str.split("\n").length - 1) : "";
}

type ImportNameSpecifier = { importedName: string; localName: string };

/**
 * Detect import statements to a known optimized CJS dependency and provide
 * ES named imports interop. We do this by rewriting named imports to a variable
 * assignment to the corresponding property on the `module.exports` of the cjs
 * module. Note this doesn't support dynamic re-assignments from within the cjs
 * module.
 *
 * Note that es-module-lexer treats `export * from '...'` as an import as well,
 * so, we may encounter ExportAllDeclaration here, in which case `undefined`
 * will be returned.
 *
 * Credits \@csr632 via #837
 */
export function transformCjsImport(
  importExp: string,
  url: string,
  rawUrl: string,
  importIndex: number,
  importer: string,
  config: ResolvedConfig
): string | undefined {
  const node = (
    parseJS(importExp, {
      ecmaVersion: "latest",
      sourceType: "module",
    }) as any
  ).body[0] as Node;

  // `export * from '...'` may cause unexpected problem, so give it a warning
  if (
    config.command === "serve" &&
    node.type === "ExportAllDeclaration" &&
    !node.exported
  ) {
    config.logger.warn(
      colors.yellow(
        `\nUnable to interop \`${importExp}\` in ${importer}, this may lose module exports. Please export "${rawUrl}" as ESM or use named exports instead, e.g. \`export { A, B } from "${rawUrl}"\``
      )
    );
  } else if (
    node.type === "ImportDeclaration" ||
    node.type === "ExportNamedDeclaration"
  ) {
    if (!node.specifiers.length) {
      return `import "${url}"`;
    }

    const importNames: ImportNameSpecifier[] = [];
    const exportNames: string[] = [];
    let defaultExports: string = "";
    for (const spec of node.specifiers) {
      if (
        spec.type === "ImportSpecifier" &&
        spec.imported.type === "Identifier"
      ) {
        const importedName = spec.imported.name;
        const localName = spec.local.name;
        importNames.push({ importedName, localName });
      } else if (spec.type === "ImportDefaultSpecifier") {
        importNames.push({
          importedName: "default",
          localName: spec.local.name,
        });
      } else if (spec.type === "ImportNamespaceSpecifier") {
        importNames.push({ importedName: "*", localName: spec.local.name });
      } else if (
        spec.type === "ExportSpecifier" &&
        spec.exported.type === "Identifier"
      ) {
        // for ExportSpecifier, local name is same as imported name
        // prefix the variable name to avoid clashing with other local variables
        const importedName = spec.local.name;
        // we want to specify exported name as variable and re-export it
        const exportedName = spec.exported.name;
        if (exportedName === "default") {
          defaultExports = makeLegalIdentifier(
            `__vite__cjsExportDefault_${importIndex}`
          );
          importNames.push({ importedName, localName: defaultExports });
        } else {
          const localName = makeLegalIdentifier(
            `__vite__cjsExport_${exportedName}`
          );
          importNames.push({ importedName, localName });
          exportNames.push(`${localName} as ${exportedName}`);
        }
      }
    }

    // If there is multiple import for same id in one file,
    // importIndex will prevent the cjsModuleName to be duplicate
    const cjsModuleName = makeLegalIdentifier(
      `__vite__cjsImport${importIndex}_${rawUrl}`
    );
    const lines: string[] = [`import ${cjsModuleName} from "${url}"`];
    importNames.forEach(({ importedName, localName }) => {
      if (importedName === "*") {
        lines.push(
          `const ${localName} = (${interopHelper.toString()})(${cjsModuleName})`
        );
      } else if (importedName === "default") {
        lines.push(
          `const ${localName} = ${cjsModuleName}.__esModule ? ${cjsModuleName}.default : ${cjsModuleName}`
        );
      } else {
        lines.push(`const ${localName} = ${cjsModuleName}["${importedName}"]`);
      }
    });
    if (defaultExports) {
      lines.push(`export default ${defaultExports}`);
    }
    if (exportNames.length) {
      lines.push(`export { ${exportNames.join(", ")} }`);
    }

    return lines.join("; ");
  }
}

// Copied from `client/client.ts`. Only needed so we can inline inject this function for classic workers.
function __vite__injectQuery(url: string, queryToInject: string): string {
  // skip urls that won't be handled by vite
  if (url[0] !== "." && url[0] !== "/") {
    return url;
  }

  // can't use pathname from URL since it may be relative like ../
  const pathname = url.replace(/[?#].*$/, "");
  const { search, hash } = new URL(url, "http://vitejs.dev");

  return `${pathname}?${queryToInject}${search ? `&` + search.slice(1) : ""}${
    hash || ""
  }`;
}
