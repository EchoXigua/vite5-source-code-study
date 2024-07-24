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
  debugHmr,
  handlePrunedModules,
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

/**
 * 匹配的是类似 /chunk-ABCDEFGH.js 这样的文件名，这些文件通常是由 Vite 在构建过程中生成的静态依赖项
 * \/chunk-   匹配字符串 /chunk-，这里的 / 需要转义
 * [A-Z\d]{8}   匹配8个大写字母或数字。这个部分代表文件名中间的一段随机字符，这通常是为了防止文件名冲突和缓存问题
 * \.js    匹配文件后缀 .js，这里的 . 需要转义
 * @example
 * /chunk-ABCDEFGH.js   /chunk-12345678.js
 * 这些是静态优化依赖项文件
 */
const optimizedDepChunkRE = /\/chunk-[A-Z\d]{8}\.js/;

/**
 * 匹配的是类似 -ABCDEFGH.js 这样的文件名，这些文件通常是由 Vite 在构建过程中生成的动态依赖项。
 * -   匹配一个连字符 -
 * [A-Z\d]{8}    匹配8个大写字母或数字
 * \.js    匹配文件后缀 .js
 * @example
 * -ABCDEFGH.js   -12345678.js
 * 这些是动态优化依赖项文件
 */
const optimizedDepDynamicRE = /-[A-Z\d]{8}\.js/;

/**
 * 用于匹配代码中的  @vite-ignore 注释
 * @example
 */
//用于匹配代码中的 /* @vite-ignore */ 注释
//import(/* @vite-ignore */ modulePath); // 忽略警告
export const hasViteIgnoreRE = /\/\*\s*@vite-ignore\s*\*\//;

const urlIsStringRE = /^(?:'.*'|".*"|`.*`)$/;

/**匹配模板字面量,匹配以反引号（``）包围的字符串 */
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

      /**
       * 自接受：
       * 自接受模块可以在热更新时处理自己的更新，而不需要其他模块的干预。
       * 自接受机制允许在代码变更时只更新修改的部分，而不是重新加载整个页面，从而提高开发效率和用户体验。
       *
       * 1. 完全自接受
       * 一个完全自接受的模块在热更新时能够处理所有可能的更新情况，包括：
       * a) 导出更新：例如，模块导出的函数或对象发生了变化，该模块可以接受这些变化并更新自己
       * b) 依赖关系更新：例如，该模块的依赖项发生了变化，它能够重新加载和更新这些依赖项
       * 完全自接受的模块通常在 HMR 中非常独立，能够处理大多数情况而无需外部干预
       *
       * 2. 部分自接受
       * 一个部分自接受的模块在热更新时能够处理一些更新情况，但可能不是所有情况。例如：
       * a) 仅处理导出更新：如果仅有模块的导出发生变化，而不涉及依赖关系的更新，这类模块可能只处理导出更新
       * b) 仅处理某些更新：模块可能只能处理特定类型的变化，如 CSS 更改，而不能处理 JavaScript 逻辑的变化
       * 
       * 模块的自接受状态对 HMR 的行为有直接影响：
       * a) 完全自接受的模块可以在更新时独立处理自己的变化，可能会调用更新函数来应用新代码，而不需要重新加载整个页面
       * b) 部分自接受的模块可能需要其他模块的帮助来处理更新，或者只能处理特定类型的更新
       * 
       * 
       * 在 Vite 或类似的构建工具中，模块可以通过 import.meta.hot.accept() 来声明自己是自接受的
       * @example
       * if (import.meta.hot) {
            import.meta.hot.accept((newModule) => {
                // 处理模块更新
                update(newModule);
            });
         }
       */

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

      /**
       * 这一块代码主要是在处理导入（import）声明，特别是在构建过程中如何解析和规范化导入路径。
       * 它的核心目标是确保所有的导入路径都被正确地解析、转换和优化，
       * 以便 Vite 能够正确地处理模块依赖、支持热模块替换（HMR）以及处理 SSR（服务器端渲染）的要求。
       */
      await Promise.all(
        imports.map(async (importSpecifier, index) => {
          // 提取导入路径的相关信息
          const {
            s: start, // 导入的开始和结束位置
            e: end,
            ss: expStart, // 导入属性的开始和结束位置
            se: expEnd,
            d: dynamicIndex, //动态导入的索引
            a: attributeIndex, //属性索引
          } = importSpecifier;

          // #2083 User may use escape path,
          // so use imports[index].n to get the unescaped string
          // 获取导入路径的原始字符串
          let specifier = importSpecifier.n;
          // 从源代码中提取出这个路径的片段
          const rawUrl = source.slice(start, end);

          // 处理 import.meta
          if (rawUrl === "import.meta") {
            // 进一步检查其属性（如 .hot 和 .env）
            // .hot：表示热模块替换（HMR）相关的功能，需要进一步分析接受的模块和导出
            // .env：表示环境变量
            // 根据不同的属性，设置相应的标志（如 hasHMR 和 hasEnv）
            const prop = source.slice(end, end + 4);

            if (prop === ".hot") {
              // 这段代码的主要目的是处理热模块替换相关的导入情况
              // 表示当前代码中存在热模块替换相关的 import.meta.hot 使用
              hasHMR = true;
              // 计算了 .accept 属性的结束位置
              // 如果在 end + 4 位置处有一个问号 (?)，则 endHot 增加 1 以包含问号。这是为了正确处理 URL 查询字符串中可能的问号
              const endHot = end + 4 + (source[end + 4] === "?" ? 1 : 0);

              if (source.slice(endHot, endHot + 7) === ".accept") {
                // 分析 .accept 属性

                if (source.slice(endHot, endHot + 14) === ".acceptExports") {
                  // 表示模块接受了来自其他模块的导出

                  // 记录接受的导出
                  const importAcceptedExports = (orderedAcceptedExports[index] =
                    new Set<string>());

                  // 解析接受的导出并更新 importAcceptedExports
                  lexAcceptedHmrExports(
                    source,
                    source.indexOf("(", endHot + 14) + 1,
                    importAcceptedExports
                  );
                  // 表示该模块部分自接受
                  isPartiallySelfAccepting = true;
                } else {
                  // 不是 .acceptExports

                  // 记录接受的模块 URL
                  const importAcceptedUrls = (orderedAcceptedUrls[index] =
                    new Set<UrlPosition>());
                  if (
                    // 解析接受的模块 URL 并更新 importAcceptedUrls
                    lexAcceptedHmrDeps(
                      source,
                      source.indexOf("(", endHot + 7) + 1,
                      importAcceptedUrls
                    )
                  ) {
                    // 表示该模块完全自接受
                    isSelfAccepting = true;
                  }
                }
              }
            } else if (prop === ".env") {
              hasEnv = true;
            }
            return;
          } else if (templateLiteralRE.test(rawUrl)) {
            // 这段代码的目的是在处理模块导入时对模板字面量进行特别处理

            // If the import has backticks but isn't transformed as a glob import
            // (as there's nothing to glob), check if it's simply a plain string.
            // If so, we can replace the specifier as a plain string to prevent
            // an incorrect "cannot be analyzed" warning.
            /**
             * 1. 处理纯字符串的模板字面量：
             * 有时候，开发者可能会使用模板字面量来表示固定的路径，但实际上没有动态插值
             * 这种情况下，代码将这些模板字面量处理为普通字符串，从而简化处理过程
             *
             * 2. 防止错误的警告：
             * 如果不处理这种情况，可能会导致错误的分析警告，特别是在动态导入和路径解析的上下文中
             * 这段代码通过将模板字面量替换为纯字符串，避免了这些警告，确保路径可以被正确解析
             *
             */

            // 检查模板字面量中是否包含 ${}（用于插入表达式的部分）
            // 如果不包含（即模板字面量中没有插值表达式），那么可以认为它是一个纯字符串
            if (!(rawUrl.includes("${") && rawUrl.includes("}"))) {
              // 将反引号去除，只保留模板字面量中的字符串内容
              specifier = rawUrl.replace(templateLiteralRE, "$1");
            }
          }

          // 说明该导入语句是动态导入
          const isDynamicImport = dynamicIndex > -1;

          // strip import attributes as we can process them ourselves
          // 处理导入语句中的动态导入和导入属性
          // 动态导入（例如 import('path')）与静态导入不同，动态导入的路径在运行时才会被确定，因此不需要移除任何属性
          // 对于静态导入，导入属性（如 import('path', { attributes }) 中的 { attributes }）可能不需要处理，
          // 因为 Vite 或其他工具会在后续处理中对这些属性进行处理。因此，这部分代码的目的是将这些不需要的导入属性从导入语句中移除，简化处理流程。
          if (!isDynamicImport && attributeIndex > -1) {
            // 当前导入不是动态导入但存在导入属性
            // 导入属性 例如 import('path', { attributes })
            str().remove(end + 1, expEnd);
          }

          //如果定义了，说明这是一个有效的导入路径
          if (specifier !== undefined) {
            // 跳过外部链接或数据 URL:
            if (isExternalUrl(specifier) || isDataUrl(specifier)) {
              return;
            }
            // 跳过 SSR 外部模块:
            if (ssr && !matchAlias(specifier)) {
              // 在(SSR) 模式下如果模块不是别名匹配且应该外部化，则跳过处理。
              if (shouldExternalizeForSSR(specifier, importer, config)) {
                return;
              }
              // 如果是内置模块，也跳过处理
              if (isBuiltin(specifier)) {
                return;
              }
            }
            // 跳过客户端公共路径:
            if (specifier === clientPublicPath) {
              return;
            }

            // warn imports to non-asset /public files
            // 以 / 开头，但不符合assets配置，也不是 URL 正则表达式匹配的 URL，并且是公共文件，则抛出错误
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

            // 获取规范化后的 URL 和解析 ID
            const [url, resolvedId] = await normalizeUrl(specifier, start);

            // record as safe modules
            // safeModulesPath should not include the base prefix.
            // See https://github.com/vitejs/vite/issues/9438#issuecomment-1465270409
            // 记录安全模块路径，用于后续的模块图分析
            server?.moduleGraph.safeModulesPath.add(
              fsPathFromUrl(stripBase(url, base))
            );

            // 这段代码的主要目的是在处理模块导入时，特别是优化依赖和内置模块的导入时，对导入路径进行必要的重写和处理
            if (url !== specifier) {
              // 检查 URL 是否变化
              // 如果 url 与 specifier 不同，意味着需要对 url 进行处理或重写

              /**初始化重写标记 */
              let rewriteDone = false;
              if (
                // resolvedId 是一个优化的依赖文件
                depsOptimizer?.isOptimizedDepFile(resolvedId) &&
                // 不符合内部优化块的正则
                !optimizedDepChunkRE.test(resolvedId)
              ) {
                // for optimized cjs deps, support named imports by rewriting named imports to const assignments.
                // internal optimized chunks don't need es interop and are excluded
                /**
                 * 1. 优化后的 CommonJS 依赖项：这些是经过优化的依赖项，通常是从 node_modules 中提取出来并转换为 ES 模块格式
                 *
                 * 2. 命名导入重写：由于 CommonJS 模块通常使用 module.exports 和 require 导出和导入，
                 * 所以需要将这些导入重写为 ES 模块的 const 赋值格式，以便支持命名导入
                 *
                 * 3. 内部优化的块：这些是已经经过优化且不需要再处理为 ES 模块的内部块，它们不需要 ES 互操作（ES interop）
                 */

                // The browserHash in resolvedId could be stale in which case there will be a full
                // page reload. We could return a 404 in that case but it is safe to return the request
                /**
                 * 1. 浏览器哈希（browserHash）：这是一个用来标识文件版本的哈希值，用于缓存控制。如果哈希值过期，可能会导致资源无法正确加载
                 * 2. 完全页面重新加载：当哈希值过期时，浏览器会重新加载整个页面，以确保加载的是最新版本的资源
                 * 3. 返回 404 和请求安全性：在哈希值过期时，可以返回一个 404 错误表示资源未找到，
                 * 但这样做会导致用户体验不佳。直接返回请求是一个更安全的选择，确保资源能够正常加载。
                 */

                // 去掉 resolvedId 中的 ?v={hash}
                const file = cleanUrl(resolvedId); // Remove ?v={hash}

                // 检查是否需要处理 CommonJS 模块与 ES 模块的兼容性
                const needsInterop = await optimizedDepNeedsInterop(
                  depsOptimizer.metadata,
                  file,
                  config,
                  ssr
                );

                // 这段代码处理的是在优化依赖项时，判断是否需要进行 ES 互操作（interop）
                if (needsInterop === undefined) {
                  // Non-entry dynamic imports from dependencies will reach here as there isn't
                  // optimize info for them, but they don't need es interop. If the request isn't
                  // a dynamic import, then it is an internal Vite error
                  /**
                   * 1. needsInterop 未定义：这意味着在依赖项优化信息中，没有找到该文件是否需要 ES 互操作的信息
                   * 2. 非入口动态导入：这些是依赖项中的动态导入，它们不是模块的入口点，所以没有优化信息
                   * 3. 优化依赖项的动态正则表达式（optimizedDepDynamicRE）：这是一个正则表达式，
                   * 用于匹配动态导入的优化依赖项文件名。如果 file 不匹配该正则表达式，则记录一个错误日志，指出优化信息应该被定义
                   */

                  if (!optimizedDepDynamicRE.test(file)) {
                    config.logger.error(
                      colors.red(
                        `Vite Error, ${url} optimized info should be defined`
                      )
                    );
                  }
                } else if (needsInterop) {
                  // 记录一个调试日志，表示 url 需要互操作
                  debug?.(`${url} needs interop`);
                  // 处理命名导入的互操作
                  // 这个函数处理命名导入的互操作，将 CommonJS 模块的命名导入转换为适当的 ES 模块导入形式
                  interopNamedImports(
                    str(),
                    importSpecifier,
                    url,
                    index,
                    importer,
                    config
                  );
                  //   并标记 rewriteDone 为真，说明重写了
                  rewriteDone = true;
                }
              }
              // If source code imports builtin modules via named imports, the stub proxy export
              // would fail as it's `export default` only. Apply interop for builtin modules to
              // correctly throw the error message.

              /**
               * 这一段代码主要是处理在源代码中以命名导入（named imports）的方式导入内置模块
               * 因为这些内置模块通常只通过 export default 进行导出，所以如果以命名导入的方式导入它们，
               * 将会导致代理导出失败。因此需要应用一些互操作性处理（interop），以正确地抛出错误消息。
               * @example
               * import { something } from 'builtin-module';
               * 这将会失败，因为 'builtin-module' 只导出了 `default`
               */
              else if (
                // 导入的 url 包含这个标识符，那么就说明这是一个内置模块
                url.includes(browserExternalId) &&
                // source.slice(expStart, start) 用于获取导入语句的具体部分
                // includes("{") 检查导入语句中是否包含 {，即检查是否是命名导入
                // 例如，import { something } from 'module' 中包含 {
                source.slice(expStart, start).includes("{")
              ) {
                // 处理命名导入的互操作性
                interopNamedImports(
                  str(), // 用于代码操作的字符串处理对象
                  importSpecifier, // 导入的具体规范对象，包含导入的详细信息
                  url, //导入的 URL
                  index, // 当前导入语句在源代码中的索引
                  importer, //导入者文件的路径
                  config // Vite 的配置对象
                );

                // 表示互操作性处理已经完成，不需要再进行其他处理
                rewriteDone = true;
              }
              if (!rewriteDone) {
                // 在确定不需要互操作性处理（interop）后，重新编写（重写）导入的 URL，以确保它们能够在运行时正确解析和加载

                // 确保 url 在重写时正确地包含在代码中，防止特殊字符导致语法错误
                const rewrittenUrl = JSON.stringify(url);

                // 计算重写操作的起始位置,如果是动态导入起始位置为 start；否则，为 start - 1
                // 这是因为静态导入在 start 位置之前有一个引号（" 或 '），需要包括在重写范围内，而动态导入不需要
                const s = isDynamicImport ? start : start - 1;

                // 计算重写操作的结束位置,如果是动态导入，结束位置为 end；否则，为 end + 1
                // 同理，静态导入在 end 位置之后有一个引号（" 或 '），需要包括在重写范围内，而动态导入不需要
                const e = isDynamicImport ? end : end + 1;

                // 将导入语句从位置 s 到位置 e 之间的内容替换为 rewrittenUrl
                // 选项 { contentOnly: true } 指定只替换内容而不影响其他部分

                /**
                 * 这里就是真正给裸导入做替换的地方
                 * @example
                 * import vue from 'vue' ----- > import vue from 'rewrittenUrl'
                 *
                 * import vue from '/node_modules/.vite/deps/vue.js?v=535dbf73'
                 */
                str().overwrite(s, e, rewrittenUrl, {
                  contentOnly: true,
                });
              }
            }

            // record for HMR import chain analysis
            // make sure to unwrap and normalize away base
            /**
             * 这段代码的主要作用是记录模块导入链以用于热模块替换（HMR）分析，
             * 并提取导入绑定（imported bindings）以便进行部分接受（partial accept）
             */

            // stripBase 移除基本路径，unwrapId移除特殊处理的前缀
            // 目的是标准化 url，确保它不包含任何基础路径信息，从而简化后续处理
            const hmrUrl = unwrapId(stripBase(url, base));
            // 判断 hmrUrl 是否是本地导入
            // 如果 hmrUrl 既不是外部 URL 也不是数据 URL，则认为它是本地导入
            // 本地导入指的是那些在本地文件系统中存在的模块，而非远程或内联的数据
            const isLocalImport = !isExternalUrl(hmrUrl) && !isDataUrl(hmrUrl);
            if (isLocalImport) {
              // 将 hmrUrl 记录在 orderedImportedUrls 数组的对应索引位置，以便后续 HMR 分析使用
              // 这有助于跟踪模块的导入链，确保在模块发生变化时能够正确地处理相关的依赖模块
              orderedImportedUrls[index] = hmrUrl;
            }

            // 提取导入绑定
            if (enablePartialAccept && importedBindings) {
              // 检查是否启用了部分接受功能 且 存在导入绑定信息

              // 提取导入绑定
              extractImportedBindings(
                resolvedId, //解析后的模块 ID
                source, //模块源代码
                importSpecifier, //导入说明符（包含导入的详细信息，如起始位置、结束位置等）
                importedBindings //导入绑定信息
              );
              /**
               * 这个步骤的目的是从源代码中提取导入的变量和函数，以便在 HMR 更新时能够有选择性地接受某些更新
               *
               * 在 Vite 的热模块替换（HMR）机制中，需要能够跟踪模块的导入链，
               * 以便在模块更新时能够正确处理相关的依赖模块。这段代码通过记录本地导入的模块 URL 来实现这一点。
               *
               * 此外，部分接受功能允许开发者只接受某些特定部分的模块更新，而不是全部重新加载。
               * 这在大型应用程序中非常有用，可以显著减少重新加载的时间和资源消耗，提高开发体验。
               * @example
               * main.js:
               * import { foo } from './module.js';
               * console.log(foo);
               *
               * module.js:
               * export const foo = 'bar';
               *
               * 如果 module.js 更新了，Vite 需要知道 main.js 导入了 module.js，
               * 以便在 module.js 发生变化时，能够正确地更新 main.js 中的相关部分，而不是重新加载整个页面
               *
               * 通过记录导入链和提取导入绑定，Vite 能够实现更细粒度的模块热替换，提高开发效率和用户体验
               */
            }

            // 这段代码的主要功能是预转换已知的直接导入请求，以便优化依赖项的处理
            if (
              // 不是动态导入
              !isDynamicImport &&
              // 是本地导入
              isLocalImport &&
              // 检查是否配置了预转换请求
              config.server.preTransformRequests
            ) {
              // 只有在以上三个条件同时满足时，才会执行预转换请求

              // pre-transform known direct imports
              // These requests will also be registered in transformRequest to be awaited
              // by the deps optimizer

              /**
               * 通过预转换已知的直接导入，可以在依赖项优化器中提前注册这些请求，
               * 从而在模块发生变化时能够更快地处理这些请求，减少延迟，提高性能。
               */

              // 去除 hmrUrl 中的导入查询参数
              const url = removeImportQuery(hmrUrl);

              // 预热请求
              /**
               * 这种预热机制旨在提前加载和处理一些模块，以减少首次访问时的延迟，提升开发体验和效率。
               * 当 Vite 预热一个请求时，它会提前加载并处理该模块。这意味着在开发者实际访问该模块之前，
               * Vite 已经准备好了相关的资源。
               */
              server.warmupRequest(url, { ssr });
            }

            // 检查 importer 是否在 Vite 的客户端目录之外
          } else if (!importer.startsWith(withTrailingSlash(clientDir))) {
            // 这段代码在 Vite 中处理动态导入时的逻辑，特别是对无法被 Vite 解析的动态导入进行警告和处理

            //  importer 不在 node_modules 中，会生成警告
            if (!isInNodeModules(importer)) {
              const hasViteIgnore = hasViteIgnoreRE.test(
                source.slice(dynamicIndex + 1, end)
              );

              // 如果动态导入的表达式中没有使用 /* @vite-ignore */ 注释（用于忽略警告），则生成一个警告
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
              // 在非 SSR 环境中，检查 rawUrl 是否符合特定格式
              if (
                // 如果 URL 不是一个字符串
                !urlIsStringRE.test(rawUrl) ||
                // 需要显式导入
                isExplicitImportRequired(rawUrl.slice(1, -1))
              ) {
                // 需要注入一个查询帮助函数
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

      /**
       * 这段代码处理了几个不同的 URL 集合，并确定了模块的工作模式
       * 它主要用于处理和分析模块的导入情况，并根据不同的条件进行处理
       */

      /**过滤出已定义的 URL */
      const _orderedImportedUrls = orderedImportedUrls.filter(isDefined);
      /**过滤后的url 去重处理 */
      const importedUrls = new Set(_orderedImportedUrls);
      // `importedUrls` will be mixed with watched files for the module graph,
      // `staticImportedUrls` will only contain the static top-level imports and
      // dynamic imports
      /**
       * 这段注释解释了 importedUrls 和 staticImportedUrls 的用途和区别
       *
       * importedUrls：
       * 作用：importedUrls 包含了所有导入的 URL。这些 URL 包括了来自模块的静态导入和动态导入
       * 用途：这些 URL 将会被与模块图中的被监视文件混合。这意味着这些 URL 可能会被进一步处理或跟踪，
       * 以便在模块图中建立关系，并进行相关的构建和优化操作
       *
       * staticImportedUrls：
       * 作用：staticImportedUrls 仅包含静态的顶层导入和动态导入的 URL。具体来说，这个集合不包括那些可能在其他地方被用作路径的 URL
       * 用途：这个集合用于处理静态导入和动态导入的情况。例如，在处理动态导入的代码时，可以只关注这些 URL，
       * 而不必考虑其他可能会被忽略的 URL。这样可以确保仅对相关的导入 URL 进行进一步的操作，比如模块重写、查询注入等。
       *
       * 区别：
       * importedUrls 可能会被用于建立模块图，以确保所有模块和它们的依赖项都被正确跟踪和处理。这通常涉及到分析和优化整个项目中的文件依赖关系。
       *
       * staticImportedUrls 可以用于优化和处理静态导入和动态导入，这些通常是编译和构建过程中的重要部分。
       * 通过专注于这些 URL，工具可以更有效地处理和优化模块依赖，进行静态分析、动态导入重写等操作。
       */

      /**仅包含静态导入和动态导入的 URL，去除了时间戳查询参数 */
      const staticImportedUrls = new Set(
        _orderedImportedUrls.map((url) => removeTimestampQuery(url))
      );

      /**
       * 将 orderedAcceptedUrls 和 orderedAcceptedExports 中的被接受的 URL 和导出合并到单个集合中，以便在后续处理过程中使用
       *
       * orderedAcceptedUrls:
       * 这是一个包含被接受的 URL 的数组。在模块热替换过程中，
       * 当一个模块的某些依赖被接受（即部分自接受或完全自接受）时，这些 URL 会被记录下来
       *
       * orderedAcceptedExports:
       * 这是一个包含被接受的导出的数组。类似于被接受的 URL，这些导出是在模块热替换过程中被记录的
       */
      const acceptedUrls = mergeAcceptedUrls(orderedAcceptedUrls);
      /**
       * 在模块系统中，模块可以有多种导出方式，比如命名导出和默认导出。
       * 被接受的导出和模块的总导出是针对这些导出的不同处理情况。
       * @example
       * 假设有一个模块 module.js，它包含多个导出：
       * export const foo = 'foo';
       * export const bar = 'bar';
       * export default 'defaultExport';
       *
       * 在这个模块中，foo 和 bar 是命名导出，defaultExport 是默认导出。这个模块的总导出就是 foo, bar 和 defaultExport。
       *
       * 在 HMR 机制中，一个模块可能会部分地接受其导出，即只接受某些特定的导出而不接受全部
       * 例如，一个模块可能只接受 foo 的更新而不接受 bar 和 defaultExport 的更新
       *
       * 假设在 HMR 过程中，module.js 进行了更新，Vite 会检查哪些导出被接受，哪些没有被接受
       * const acceptedExports = new Set(['foo']); // 被接受的导出
       * const exports = [{ n: 'foo' }, { n: 'bar' }, { n: 'defaultExport' }]; // 模块的总导出
       *
       * 模块的总导出：这是模块中所有导出的集合，包括命名导出和默认导出
       * 被接受的导出：这是 HMR 过程中实际接受的导出集合。这可能是模块总导出的一个子集
       */
      const acceptedExports = mergeAcceptedUrls(orderedAcceptedExports);

      // While we always expect to work with ESM, a classic worker is the only
      // case where it's not ESM and we need to avoid injecting ESM-specific code
      /**
       * 这段注释解释了在某些情况下，特别是处理传统的 Web Worker 时，构建工具需要避免注入 ES 模块（ESM）特有的代码
       *
       * ESM：一种现代的 JavaScript 模块系统，支持 import 和 export 语法，广泛应用于前端开发和 Node.js 环境
       * Classic Worker：传统的 Web Worker，使用 importScripts 进行模块导入，
       * 而不是使用 ESM 的 import 和 export。它们在一些旧的浏览器或特定的环境中仍然被使用
       */

      // 确定当前的 importer 是否为经典工作线程。经典工作线程通常指的是使用经典 JavaScript 工作线程 API 的文件，
      // 它们不支持 ESM（ES 模块）语法，因此需要避免注入 ESM 特定的代码
      const isClassicWorker =
        importer.includes(WORKER_FILE_ID) && importer.includes("type=classic");

      // 检查是否需要注入环境变量，并在特定条件下将这些变量注入到代码中
      if (hasEnv && !isClassicWorker) {
        // inject import.meta.env
        // 在源代码的开头插入代码
        str().prepend(getEnv(ssr));
      }

      // 这段代码用于在支持热模块替换（HMR）的情况下注入 HMR 上下文到代码中
      if (hasHMR && !ssr && !isClassicWorker) {
        // isClassicWorker为false 表示当前不是经典 Worker（经典 Worker 不支持 HMR）

        debugHmr?.(
          `${
            isSelfAccepting
              ? `[self-accepts]`
              : isPartiallySelfAccepting
              ? `[accepts-exports]`
              : acceptedUrls.size
              ? `[accepts-deps]`
              : `[detected api usage]`
          } ${prettifyUrl(importer, root)}`
        );

        // 代码将注入 HMR 上下文到源代码中
        // inject hot context
        // 在源代码的开头插入内容
        str().prepend(
          `import { createHotContext as __vite__createHotContext } from "${clientPublicPath}";` +
            `import.meta.hot = __vite__createHotContext(${JSON.stringify(
              normalizeHmrUrl(importerModule.url)
            )});`
        );
      }

      // 这段代码负责根据不同情况注入 injectQuery 函数，该函数用于处理动态导入中的查询参数
      if (needQueryInjectHelper) {
        if (isClassicWorker) {
          // 在 Vite 中，经典 worker 不使用 ES 模块，因此需要特殊处理
          // 直接将 __vite__injectQuery 函数的实现代码追加到代码末尾
          // 这样做是因为经典 worker 不支持 ES 模块导入
          str().append("\n" + __vite__injectQuery.toString());
        } else {
          // 不是经典 worker，则通过 ES 模块的方式导入 injectQuery 函数
          //  将导入语句添加到代码的开头
          str().prepend(
            `import { injectQuery as __vite__injectQuery } from "${clientPublicPath}";`
          );
        }
      }

      /**
       * 这段代码的主要作用是标准化并重写接受的 URLs
       * 这在 HMR 中尤为重要，因为在模块被部分接受（部分自接受）或完全接受（完全自接受）时，
       * Vite 需要确保这些模块的 URL 是标准化的并且能被正确解析。
       *
       */
      /**用于存储标准化后的 URL，URL唯一 */
      const normalizedAcceptedUrls = new Set<string>();
      // 遍历 acceptedUrls 数组，对每个 URL 进行标准化处理
      for (const { url, start, end } of acceptedUrls) {
        // 将url 转为绝对路径，然后进行标准化
        const [normalized] = await moduleGraph.resolveUrl(
          toAbsoluteUrl(url),
          ssr
        );
        // 添加到集合中
        normalizedAcceptedUrls.add(normalized);
        // 将源代码中的原始 URL 替换为标准化后的 URL
        str().overwrite(start, end, JSON.stringify(normalized), {
          contentOnly: true,
        });
      }

      // update the module graph for HMR analysis.
      // node CSS imports does its own graph update in the css-analysis plugin so we
      // only handle js graph updates here.
      // note that we want to handle .css?raw and .css?url here
      /**
       * 更新模块图以进行 HMR 分析
       * CSS 导入在 css-analysis 插件中自行处理其图更新，所以这里只处理 JavaScript 的图更新。
       * 需要注意的是，这里也要处理 .css?raw 和 .css?url 类型的导入
       */

      // 这段代码的主要目的是更新模块的信息，并根据需要处理模块热替换

      // 检查导入的模块是否是 CSS 请求或者是否符合特定的查询条件
      if (!isCSSRequest(importer) || SPECIAL_QUERY_RE.test(importer)) {
        // attached by pluginContainer.addWatchFile
        /**
         * 这段注释指出，这部分代码处理的是通过 pluginContainer.addWatchFile 方法附加的导入
         * _addedImports 集合中包含了插件通过 addWatchFile 方法添加的文件路径
         *
         * 在 Vite 插件系统中，插件可以使用 addWatchFile 方法来添加一些文件，这些文件会被 Vite 监视，
         * 以便在这些文件发生变化时触发热更新或其他处理逻辑。_addedImports 集合正是用来记录这些通过 addWatchFile 方法添加的文件路径
         *
         * _addedImports 是用来存储插件通过 addWatchFile 方法新添加的导入路径的集合
         */

        // 这段代码是处理插件附加的导入。它的目的是将插件附加的导入规范化并添加到 importedUrls 集合中
        const pluginImports = (this as any)._addedImports as
          | Set<string>
          | undefined;
        if (pluginImports) {
          (
            await Promise.all(
              // 使用扩展运算符 ... 将 Set 转换为数组
              // 对每个导入路径调用 normalizeUrl 函数进行规范化
              [...pluginImports].map((id) => normalizeUrl(id, 0, true))
            )
          )
            // 将规范化后的路径添加到 importedUrls 集合
            .forEach(([url]) => importedUrls.add(url));
        }
        // HMR transforms are no-ops in SSR, so an `accept` call will
        // never be injected. Avoid updating the `isSelfAccepting`
        // property for our module node in that case.
        /**
         * 1. 在 SSR 环境下，HMR 变换是无效操作（no-ops）。也就是说，在 SSR 模式中，HMR 不会对模块进行任何变换
         * 这是因为 SSR 通常在服务端执行，不需要像客户端那样动态更新模块
         *
         * 2. 因此，在 SSR 环境下，accept 调用永远不会被注入到模块中
         * 在客户端环境中，HMR 可能会注入一个 accept 调用，用于处理模块更新，但在 SSR 中这不会发生
         *
         * 3. 因此，在这种情况下，不需要更新我们模块节点的 isSelfAccepting 属性
         * isSelfAccepting 属性表示模块是否自接受更新。
         * 在 SSR 环境下，因为不会注入 accept 调用，所以这个属性不需要更新
         *
         * 这个注释的目的是提醒开发者，在 SSR 环境下，不需要处理 HMR 相关的逻辑，从而避免不必要的操作
         */
        if (ssr && importerModule.isSelfAccepting) {
          // 如果在 SSR 环境中，并且模块是自接受的（即它能够处理自己的热更新），则将 isSelfAccepting 设置为 true
          isSelfAccepting = true;
        }
        // a partially accepted module that accepts all its exports
        // behaves like a self-accepted module in practice
        /**
         * 我们再来回顾一下在vite的hmr中，一个模块可以有不同的接受方式
         * 1. 完全自接受（self-accepting）：模块本身能够处理自身的更新，不需要任何外部干预。
         * 2. 部分自接受（partially self-accepting）：模块本身无法完全处理自身的更新，
         * 但它可以处理部分的更新，比如只接受某些导出的部分
         * 3. 完全不接受（not accepting）：模块无法处理自身的更新，需要重新加载整个模块或整个页面
         */

        // 处理部分自接受模块
        if (
          // 当前模块还不是完全自接受的
          !isSelfAccepting &&
          // 当前模块是部分自接受的
          isPartiallySelfAccepting &&
          // 被接受的导出数量大于或等于模块的总导出数量;这里不理解其意思可以看 acceptedExports的 注释
          acceptedExports.size >= exports.length &&
          // 模块的每一个导出都在被接受的导出列表中
          exports.every((e) => acceptedExports.has(e.n))
        ) {
          // 如果一个部分自接受的模块，实际上接受了它所有的导出（即所有导出都在 acceptedExports 中），
          // 那么它在行为上就和一个完全自接受的模块没有区别
          // 因此，可以将这个部分自接受的模块标记为完全自接受
          isSelfAccepting = true;
        }

        // 这一段代码的核心是更新模块图并处理裁剪掉的导入
        // 模块图是用于跟踪模块之间依赖关系的数据结构
        const prunedImports = await moduleGraph.updateModuleInfo(
          importerModule, // 当前模块，即导入了其他模块的模块
          importedUrls, // 已导入模块的 URL 集合
          importedBindings, // 已导入模块的绑定
          normalizedAcceptedUrls, // 标准化后的被接受的模块 URL 集合
          isPartiallySelfAccepting ? acceptedExports : null, // 如果是部分自接受模块，则传递被接受的导出
          isSelfAccepting, // 是否为完全自接受模块
          ssr, // 是否为服务器端渲染模式
          staticImportedUrls // 静态导入模块的 URL 集合
        );
        // 返回的 prunedImports 是当前模块中裁剪掉的导入。这些导入可能由于模块更新或其他原因被移除
        if (hasHMR && prunedImports) {
          // 存在裁剪掉的导入，则调用 handlePrunedModules 方法进行处理
          handlePrunedModules(prunedImports, server);
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
        // 检查 s 是否被赋值为 MagicString 实例，也就是有没有进行过源代码的转换处理
        // 需要进一步处理并返回变换后的结果
        return transformStableResult(s, importer, config);
      } else {
        // 意味着没有源代码进行任何变换，直接返回原始的 source
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
