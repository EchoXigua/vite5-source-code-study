import fs from "node:fs";
import path from "node:path";
import colors from "picocolors";
import type { PartialResolvedId } from "rollup";
import { exports, imports } from "resolve.exports";
import { hasESMSyntax } from "mlly";

import type { Plugin } from "../plugin";
import {
  CLIENT_ENTRY,
  DEFAULT_EXTENSIONS,
  DEFAULT_MAIN_FIELDS,
  DEP_VERSION_RE,
  ENV_ENTRY,
  FS_PREFIX,
  OPTIMIZABLE_ENTRY_RE,
  SPECIAL_QUERY_RE,
} from "../constants";
import {
  bareImportRE,
  createDebugger,
  deepImportRE,
  fsPathFromId,
  getNpmPackageName,
  injectQuery,
  isBuiltin,
  isDataUrl,
  isExternalUrl,
  isFilePathESM,
  isInNodeModules,
  isNonDriveRelativeAbsolutePath,
  isObject,
  isOptimizable,
  isTsRequest,
  normalizePath,
  safeRealpathSync,
  tryStatSync,
} from "../utils";
import { optimizedDepInfoFromFile, optimizedDepInfoFromId } from "../optimizer";
import type { DepsOptimizer } from "../optimizer";
import type { SSROptions } from "..";
import { commonFsUtils } from "../fsUtils";
import type { FsUtils } from "../fsUtils";
import {
  cleanUrl,
  isWindows,
  slash,
  withTrailingSlash,
} from "../../shared/utils";
import {
  findNearestMainPackageData,
  findNearestPackageData,
  loadPackageData,
  resolvePackageData,
} from "../packages";
import type { PackageCache, PackageData } from "../packages";

const normalizedClientEntry = normalizePath(CLIENT_ENTRY);
const normalizedEnvEntry = normalizePath(ENV_ENTRY);

const debug = createDebugger("vite:resolve-details", {
  onlyWhenFocused: true,
});

const ERR_RESOLVE_PACKAGE_ENTRY_FAIL = "ERR_RESOLVE_PACKAGE_ENTRY_FAIL";

// special id for paths marked with browser: false
// https://github.com/defunctzombie/package-browser-field-spec#ignore-a-module
export const browserExternalId = "__vite-browser-external";
// special id for packages that are optional peer deps
export const optionalPeerDepId = "__vite-optional-peer-dep";

const subpathImportsPrefix = "#";

/**以单词字符开头 */
const startsWithWordCharRE = /^\w/;

export interface ResolveOptions {
  /**
   * @default ['browser', 'module', 'jsnext:main', 'jsnext']
   */
  mainFields?: string[];
  conditions?: string[];
  /**
   * @default ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']
   */
  extensions?: string[];
  dedupe?: string[];
  /**
   * @default false
   */
  preserveSymlinks?: boolean;
}

export interface InternalResolveOptions extends Required<ResolveOptions> {
  root: string;
  isBuild: boolean;
  isProduction: boolean;
  ssrConfig?: SSROptions;
  packageCache?: PackageCache;
  fsUtils?: FsUtils;
  /**
   * src code mode also attempts the following:
   * - resolving /xxx as URLs
   * - resolving bare imports from optimized deps
   */
  asSrc?: boolean;
  tryIndex?: boolean;
  tryPrefix?: string;
  preferRelative?: boolean;
  isRequire?: boolean;
  // #3040
  // when the importer is a ts module,
  // if the specifier requests a non-existent `.js/jsx/mjs/cjs` file,
  // should also try import from `.ts/tsx/mts/cts` source file as fallback.
  isFromTsImporter?: boolean;
  tryEsmOnly?: boolean;
  // True when resolving during the scan phase to discover dependencies
  scan?: boolean;
  // Appends ?__vite_skip_optimization to the resolved id if shouldn't be optimized
  ssrOptimizeCheck?: boolean;
  // Resolve using esbuild deps optimization
  getDepsOptimizer?: (ssr: boolean) => DepsOptimizer | undefined;
  shouldExternalize?: (id: string, importer?: string) => boolean | undefined;

  /**
   * Set by createResolver, we only care about the resolved id. moduleSideEffects
   * and other fields are discarded so we can avoid computing them.
   * @internal
   */
  idOnly?: boolean;
}

/**
 * 用于创建一个 Vite 插件，该插件处理模块解析逻辑
 * 返回的插件对象包含两个钩子：resolveId 和 load
 * resolveId 钩子处理模块 ID 的解析，包括处理虚拟模块、相对路径、外部 URL 和裸包导入等
 * load 钩子用于处理浏览器外部模块和可选的 Peer 依赖模块
 * @param resolveOptions
 * @returns
 */
export function resolvePlugin(resolveOptions: InternalResolveOptions): Plugin {
  const {
    root,
    isProduction,
    asSrc,
    ssrConfig,
    preferRelative = false,
  } = resolveOptions;

  const {
    target: ssrTarget,
    noExternal: ssrNoExternal,
    external: ssrExternal,
  } = ssrConfig ?? {};

  // In unix systems, absolute paths inside root first needs to be checked as an
  // absolute URL (/root/root/path-to-file) resulting in failed checks before falling
  // back to checking the path as absolute. If /root/root isn't a valid path, we can
  // avoid these checks. Absolute paths inside root are common in user code as many
  // paths are resolved by the user. For example for an alias.
  /**
   * 这段注释解释了在 Unix 系统中处理绝对路径的一些注意事项
   *
   * 1. Unix系统中的绝对路径检查：在 Unix 系统中，如果一个路径是绝对路径（例如 /root/root/path-to-file），
   * 首先需要检查它是否是一个绝对 URL。这是因为某些情况下，这样的路径可能被解释为 URL，而不是文件系统路径。
   *
   * 2. 失败检查和回退处理：当检查绝对 URL 失败时，才会回退到检查该路径是否为绝对文件系统路径。
   * 这种处理方式确保了路径解析的正确性，但也可能导致一些不必要的检查。
   *
   * 3. 优化检查：如果可以确定 /root/root 不是一个有效的路径，就可以跳过这些检查，从而优化路径解析过程。
   * 这是因为如果根目录内的绝对路径无效，就没有必要进行这些检查，可以直接检查路径是否为绝对文件系统路径。
   *
   * 4. 用户代码中的绝对路径：在用户代码中，绝对路径非常常见，尤其是用户自行解析路径的时候。
   * 例如，当用户使用别名（alias）时，常常会生成绝对路径。
   * 检查根目录是否在根目录内部，这是为了处理 Unix 系统中的绝对路径。
   */
  const rootInRoot = tryStatSync(path.join(root, root))?.isDirectory() ?? false;

  return {
    name: "vite:resolve",

    async resolveId(id, importer, resolveOpts) {
      /**
       * 如果 id 以 \0 开头，或者以 virtual: 或 /virtual: 开头，则不进行进一步处理，直接返回。
       * 这些通常是虚拟模块，或者是直接注入到 HTML/客户端代码中的特殊模块。
       */
      if (
        id[0] === "\0" ||
        id.startsWith("virtual:") ||
        // When injected directly in html/client code
        id.startsWith("/virtual:")
      ) {
        return;
      }

      // 判断是否为SSR
      const ssr = resolveOpts?.ssr === true;

      /**
       * 延迟获取依赖优化器 depsOptimizer，因为优化器是在开发服务器监听期间创建的
       */
      const depsOptimizer = resolveOptions.getDepsOptimizer?.(ssr);

      // 如果 id 以 browserExternalId 开头，则直接返回该 id。
      // browserExternalId 用于标识浏览器环境中的外部模块。
      if (id.startsWith(browserExternalId)) {
        return id;
      }

      // 确定目标环境是否为 Web
      const targetWeb = !ssr || ssrTarget === "webworker";

      /**
       * 检查 resolveOpts 中是否包含 node-resolve 自定义选项，并且 isRequire 是否为 true
       * 这是由 @rollup/plugin-commonjs 插件传递的，用于区分 CommonJS 的 require
       */
      const isRequire: boolean =
        resolveOpts?.custom?.["node-resolve"]?.isRequire ?? false;

      // end user can configure different conditions for ssr and client.
      // falls back to client conditions if no ssr conditions supplied
      /**获取 SSR 的解析条件 */
      const ssrConditions =
        // 如果 ssrConfig 中定义了 resolve.conditions，则使用该条件；否则使用默认的解析条件
        resolveOptions.ssrConfig?.resolve?.conditions ||
        resolveOptions.conditions;

      /**构建内部解析选项对象 options */
      const options: InternalResolveOptions = {
        // 是否为 require 调用、解析选项、扫描选项，以及条件选项
        isRequire,
        ...resolveOptions,
        scan: resolveOpts?.scan ?? resolveOptions.scan,
        conditions: ssr ? ssrConditions : resolveOptions.conditions,
      };

      /**解析子路径导入 */
      const resolvedImports = resolveSubpathImports(
        id,
        importer,
        options,
        targetWeb
      );

      // 如果返回结果存在，更新 id
      if (resolvedImports) {
        id = resolvedImports;

        if (resolveOpts.custom?.["vite:import-glob"]?.isSubImportsPattern) {
          // 这个选项用于处理导入全局模式的子路径模式
          // vite:import-glob 选项有 isSubImportsPattern 属性，则直接返回解析后的 id
          return id;
        }
      }

      // 如果存在 importer（导入者），进行进一步检查
      if (importer) {
        if (
          // 如果导入者是一个 TypeScript 请求
          isTsRequest(importer) ||
          resolveOpts.custom?.depScan?.loader?.startsWith("ts")
        ) {
          // 这用于标识当前模块是从 TypeScript 文件中导入的。
          options.isFromTsImporter = true;
        } else {
          // 获取导入者模块的信息，并检查其 meta.vite.lang 属性
          const moduleLang = this.getModuleInfo(importer)?.meta?.vite?.lang;

          // 如果存在该属性且表示 TypeScript，则将 options.isFromTsImporter 设置为 true
          options.isFromTsImporter =
            moduleLang && isTsRequest(`.${moduleLang}`);
        }
      }

      let res: string | PartialResolvedId | undefined;

      /**
       * 解决预打包依赖请求，这些请求可以通过 tryFileResolve 或 /fs/ 解析，
       * 但这些文件可能还不存在，因为我们可能正处于依赖重新处理的中间
       */
      // 预打包依赖请求：处理预打包依赖的 URL
      if (asSrc && depsOptimizer?.isOptimizedDepUrl(id)) {
        // 是优化依赖的 URL，则继续处理

        // 如果 id 以 FS_PREFIX 开头，使用 fsPathFromId(id) 函数获取优化路径；否则，将 id 转换为标准化路径
        const optimizedPath = id.startsWith(FS_PREFIX)
          ? fsPathFromId(id)
          : normalizePath(path.resolve(root, id.slice(1)));

        // 返回优化路径
        return optimizedPath;
      }

      // 显式文件系统路径以 /@fs/* 开头
      if (asSrc && id.startsWith(FS_PREFIX)) {
        res = fsPathFromId(id);
        /**
         * 这些路径已经解析过，不需要再解析，即使 res 不存在也要返回，
         * 因为 /@fs/ 是显式路径，如果文件不存在则应该是 404 错误
         */
        debug?.(`[@fs] ${colors.cyan(id)} -> ${colors.dim(res)}`);
        return ensureVersionQuery(res, id, options, depsOptimizer);
      }

      // /foo -> /fs-root/foo
      // URL路径：处理以 / 开头的 URL 路径，将其解析为文件系统路径
      if (
        asSrc &&
        id[0] === "/" &&
        // rootInRoot 为真或 id 不是以 root 开头，继续处理
        (rootInRoot || !id.startsWith(withTrailingSlash(root)))
      ) {
        // 将 id 转换为文件系统路径
        const fsPath = path.resolve(root, id.slice(1));
        if ((res = tryFsResolve(fsPath, options))) {
          debug?.(`[url] ${colors.cyan(id)} -> ${colors.dim(res)}`);
          return ensureVersionQuery(res, id, options, depsOptimizer);
        }
      }

      // 处理相对路径
      if (
        // 这部分代码是为了识别并处理相对路径和某些特殊情况（如 HTML 文件中的导入）
        // .开头说明是相对路径
        id[0] === "." ||
        // preferRelative 为真 或 importer 以 .html 结尾(html 里面导入的)
        ((preferRelative || importer?.endsWith(".html")) &&
          //以单词字符开头
          startsWithWordCharRE.test(id))
      ) {
        // 获取基准路径, 获取导入者的路径,如果没有则使用当前工作目录
        const basedir = importer ? path.dirname(importer) : process.cwd();
        // 相对于 basedir 的文件系统路径
        const fsPath = path.resolve(basedir, id);

        // 将文件系统路径标准化
        const normalizedFsPath = normalizePath(fsPath);

        // 处理优化的依赖文件：
        if (depsOptimizer?.isOptimizedDepFile(normalizedFsPath)) {
          /**
           * 如果标准化后的路径是优化依赖文件，处理如下
           * 1. 这些优化文件可能尚未存在于磁盘上，因此解析为完整路径
           * 2. 如果当前不是构建阶段，并且路径中不包含版本信息，则注入当前 browserHash 版本
           */
          if (
            !resolveOptions.isBuild &&
            !DEP_VERSION_RE.test(normalizedFsPath)
          ) {
            const browserHash = optimizedDepInfoFromFile(
              depsOptimizer.metadata,
              normalizedFsPath
            )?.browserHash;
            if (browserHash) {
              // 返回带版本信息的路径
              return injectQuery(normalizedFsPath, `v=${browserHash}`);
            }
          }
          // 返回标准化后的路径
          return normalizedFsPath;
        }

        // 处理浏览器字段映射：
        if (
          targetWeb &&
          options.mainFields.includes("browser") &&
          // 尝试进行浏览器映射
          (res = tryResolveBrowserMapping(fsPath, importer, options, true))
        ) {
          return res;
        }

        // 尝试文件系统解析：
        if ((res = tryFsResolve(fsPath, options))) {
          // 解析成功后，确保路径包含版本信息，并打印调试信息
          res = ensureVersionQuery(res, id, options, depsOptimizer);
          debug?.(`[relative] ${colors.cyan(id)} -> ${colors.dim(res)}`);

          /**
           * 如果这不是从.html文件导入的脚本，则包括副作用提示，以便在构建期间正确地对未使用的代码进行树摇。
           */

          // 处理模块副作用：
          if (
            // 不是仅解析 ID 且不是扫描模式并且是构建阶段且导入者不是以 .html 结尾
            !options.idOnly &&
            !options.scan &&
            options.isBuild &&
            !importer?.endsWith(".html")
          ) {
            // 查找最近的包数据，获取包的副作用信息
            const resPkg = findNearestPackageData(
              path.dirname(res),
              options.packageCache
            );
            if (resPkg) {
              return {
                id: res,
                moduleSideEffects: resPkg.hasSideEffects(res),
              };
            }
          }
          return res;
        }
      }

      // 处理驱动器相对路径（仅限 Windows）
      // 首先判断是否在 Windows 平台并且 id 以 / 开头
      if (isWindows && id[0] === "/") {
        // 基准路径获取
        const basedir = importer ? path.dirname(importer) : process.cwd();
        const fsPath = path.resolve(basedir, id);
        // 尝试使用 tryFsResolve 函数解析文件系统路径
        if ((res = tryFsResolve(fsPath, options))) {
          // 如果解析成功，打印调试信息
          debug?.(`[drive-relative] ${colors.cyan(id)} -> ${colors.dim(res)}`);
          // 确保解析后的路径包含版本信息并返回
          return ensureVersionQuery(res, id, options, depsOptimizer);
        }
      }

      // 处理绝对文件系统路径
      if (
        // 判断 id 是否为非驱动器相对的绝对路径
        isNonDriveRelativeAbsolutePath(id) &&
        // 尝试直接解析 id 为文件系统路径
        (res = tryFsResolve(id, options))
      ) {
        // 如果解析成功，打印调试信息
        debug?.(`[fs] ${colors.cyan(id)} -> ${colors.dim(res)}`);
        // 确保解析后的路径包含版本信息并返回
        return ensureVersionQuery(res, id, options, depsOptimizer);
      }

      // 处理外部 URL
      // 判断 id 是否为外部 URL
      if (isExternalUrl(id)) {
        return options.idOnly ? id : { id, external: true };
      }

      // 数据uri: pass through(这只发生在构建期间，将由专用插件处理)
      // 处理数据 URI
      if (isDataUrl(id)) {
        return null;
      }

      // 处理裸包导入，执行 Node 解析
      // 首先判断 id 是否匹配裸包导入的正则表达式 bareImportRE
      if (bareImportRE.test(id)) {
        // 判断是否应该外部化此模块
        const external = options.shouldExternalize?.(id, importer);

        if (
          // 如果模块不应该外部化
          !external &&
          // 是源文件
          asSrc &&
          // 存在依赖优化器并
          depsOptimizer &&
          // 不是扫描模式
          !options.scan &&
          // 试优化解析此模块
          (res = await tryOptimizedResolve(
            depsOptimizer,
            id,
            importer,
            options.preserveSymlinks,
            options.packageCache
          ))
        ) {
          // 如果优化解析成功，返回解析结果
          return res;
        }

        // 尝试浏览器映射解析
        if (
          targetWeb &&
          options.mainFields.includes("browser") &&
          // 则尝试浏览器映射解析
          (res = tryResolveBrowserMapping(
            id,
            importer,
            options,
            false,
            external
          ))
        ) {
          return res;
        }

        // 尝试 Node 解析
        if (
          (res = tryNodeResolve(
            id,
            importer,
            options,
            targetWeb,
            depsOptimizer,
            ssr,
            external
          ))
        ) {
          return res;
        }

        // 处理 Node 内置模块
        // 判断 id 是否为 Node 内置模块
        if (isBuiltin(id)) {
          if (ssr) {
            // ssr 模式下的处理

            if (
              targetWeb &&
              ssrNoExternal === true &&
              // if both noExternal and external are true, noExternal will take the higher priority and bundle it.
              // only if the id is explicitly listed in external, we will externalize it and skip this error.
              /**
               * 如果noExternal和external都为真，则noExternal将获得更高的优先级并将其绑定。
               * 只有当id在external中显式列出时，我们才会将其外部化并跳过此错误。
               *
               *
               * 1. 当配置中同时设置了 noExternal 和 external 为 true 时，noExternal 的优先级更高。
               * 也就是说，即使 external 选项也为 true，noExternal 选项会导致模块被打包（bundle）在最终输出中。
               * noExternal 配置项通常用于指示哪些模块应该被打包在最终的构建中，而不是作为外部模块。
               * 它通常用于确保某些依赖始终被打包进输出文件中，避免在运行时从外部获取。
               *
               * 2. 只有当 id 明确地列在 external 配置中时，模块才会被外部化（externalized）。
               * 外部化意味着该模块不会被打包到输出中，而是作为外部依赖存在
               * 如果 id 在 external 配置中被列出，那么即使有冲突，模块会按照外部化的配置进行处理，不会抛出错误。
               *
               */
              (ssrExternal === true || !ssrExternal?.includes(id))
            ) {
              let message = `Cannot bundle Node.js built-in "${id}"`;
              if (importer) {
                message += ` imported from "${path.relative(
                  process.cwd(),
                  importer
                )}"`;
              }
              message += `. Consider disabling ssr.noExternal or remove the built-in dependency.`;
              this.error(message);
            }

            return options.idOnly
              ? id
              : { id, external: true, moduleSideEffects: false };
          } else {
            // 不是 SSR 模式
            if (!asSrc) {
              // 如果不是源文件，打印调试信息
              debug?.(
                `externalized node built-in "${id}" to empty module. ` +
                  `(imported by: ${colors.white(colors.dim(importer))})`
              );
            } else if (isProduction) {
              // 如果是生产模式，打印警告信息
              this.warn(
                `Module "${id}" has been externalized for browser compatibility, imported by "${importer}". ` +
                  `See https://vitejs.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.`
              );
            }

            return isProduction
              ? browserExternalId
              : `${browserExternalId}:${id}`;
          }
        }
      }

      debug?.(`[fallthrough] ${colors.dim(id)}`);
    },

    load(id) {
      // 处理浏览器外部化模块
      // 如果是，表示该模块在浏览器环境下被外部化了（即，不会被打包进最终的客户端代码中）
      if (id.startsWith(browserExternalId)) {
        if (isProduction) {
          // 在生产环境中，外部化的模块会被替换成一个空对象 {}。
          // 这意味着即使尝试访问这些模块的内容，它们会被替换为空对象，没有实际的代码或数据
          return `export default {}`;
        } else {
          // 在开发环境中，如果尝试访问外部化的模块，返回的代码将创建一个 Proxy 对象，这个对象会拦截所有的属性访问请求，并抛出错误
          // 错误消息中包含模块的 ID，并指出该模块已被外部化，不能在客户端代码中访问
          // 这个处理是为了帮助开发人员诊断为什么模块不可用
          id = id.slice(browserExternalId.length + 1);
          return `\
export default new Proxy({}, {
  get(_, key) {
    throw new Error(\`Module "${id}" has been externalized for browser compatibility. Cannot access "${id}.\${key}" in client code.  See https://vitejs.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.\`)
  }
})`;
        }
      }
      // 处理可选的对等依赖
      if (id.startsWith(optionalPeerDepId)) {
        if (isProduction) {
          return `export default {}`;
        } else {
          // 在开发环境中，代码将抛出一个错误，说明无法解析指定的对等依赖 peerDep，并指明它是由 parentDep 引入的。
          // 错误消息提示开发人员检查这些依赖是否已安装
          const [, peerDep, parentDep] = id.split(":");
          return `throw new Error(\`Could not resolve "${peerDep}" imported by "${parentDep}". Is it installed?\`)`;
        }
      }
    },
  };
}

export type InternalResolveOptionsWithOverrideConditions =
  InternalResolveOptions & {
    /**
     * @internal
     */
    overrideConditions?: string[];
  };

/**
 * 这个函数的目的是尝试解析一个模块路径，以便在构建工具（如 Vite）中进行依赖解析和优化。
 * 它处理了多种情况，包括处理深度导入、自引用、包的查找、优化依赖的处理等
 * @param id // 模块的标识符，例如 "react" 或 "./utils"
 * @param importer // 导入该模块的文件路径
 * @param options // 解析选项
 * @param targetWeb  // 是否面向 web
 * @param depsOptimizer // 依赖优化器
 * @param ssr
 * @param externalize // 是否将模块标记为外部模块
 * @param allowLinkedExternal // 是否允许链接外部模块
 * @returns
 */
export function tryNodeResolve(
  id: string,
  importer: string | null | undefined,
  options: InternalResolveOptionsWithOverrideConditions,
  targetWeb: boolean,
  depsOptimizer?: DepsOptimizer,
  ssr: boolean = false,
  externalize?: boolean,
  allowLinkedExternal: boolean = true
): PartialResolvedId | undefined {
  // 获取根目录、是否去重、是否构建中、是否保留符号链接和包缓存
  const { root, dedupe, isBuild, preserveSymlinks, packageCache } = options;

  // 正则表达式检查模块是否是深度导入（例如 "my-lib/foo"），并获取包名
  const deepMatch = id.match(deepImportRE);
  // 包名不包含后缀，修改它们以支持通过查询导入包(例如:从'normalize.css?inline'导入CSS ')
  const pkgId = deepMatch ? deepMatch[1] || deepMatch[2] : cleanUrl(id);

  // 基本路径确定
  let basedir: string;
  if (dedupe?.includes(pkgId)) {
    // 如果包名在 dedupe 列表中，使用根目录作为基本路径
    basedir = root;
  } else if (
    // 检查 importer 是否为绝对路径，并确定其目录
    importer &&
    path.isAbsolute(importer) &&
    // CSS处理为导入器添加了 "*"
    (importer[importer.length - 1] === "*" || fs.existsSync(cleanUrl(importer)))
  ) {
    basedir = path.dirname(importer);
  } else {
    basedir = root;
  }

  // 检查是否为自引用依赖项
  let selfPkg = null;
  if (!isBuiltin(id) && !id.includes("\0") && bareImportRE.test(id)) {
    // 不是node 内置模块 并且 不包含特殊字符 \0（虚拟路径） 并且为裸导入（即不以 ./、../ 或 / 开头的模块导入）

    // 检查它是否为自引用深度
    // 查找最近的 package.json 数据
    const selfPackageData = findNearestPackageData(basedir, packageCache);
    selfPkg =
      // 如果找到了且该包有 exports 字段，并且其 name 与 pkgId 相符合
      // 则将 selfPkg 设置为找到的包数据，否则设置为 null
      selfPackageData?.data.exports && selfPackageData?.data.name === pkgId
        ? selfPackageData
        : null;
  }

  // 解析包数据
  const pkg =
    selfPkg ||
    // selfPkg不为null 则 解析指定 pkgId 的包数据
    resolvePackageData(pkgId, basedir, preserveSymlinks, packageCache);
  if (!pkg) {
    // 处理未找到的包情况
    /**
     * 这里源码解释了在导入模块未找到的情况下，如何处理可选的对等依赖。
     * 这种处理方式是为了在某些情况下仍然能够继续构建，而不是因为一个可选的依赖项缺失而导致整个构建过程失败
     *
     * 对等依赖（Peer Dependencies）：这些是你的项目希望由用户自己提供的依赖项。
     * 例如，如果你构建一个插件系统，你可能希望插件本身不要包含某些公共库（如 React），而是要求用户在使用插件时自己安装这些库
     *
     * 可选的对等依赖：这些是对等依赖中的一种类型，即这些依赖是可选的。
     * 缺少它们不会阻止你的项目运行，但如果存在，将会提供额外的功能
     *
     */
    if (
      // 检查是否位于根目录之外（basedir !== root），因为根目录通常没有对等依赖
      basedir !== root &&
      // 再次确认 id 不是内置模块
      !isBuiltin(id) &&
      // 不包含特殊字符 \0
      !id.includes("\0") &&
      // 确认是裸导入
      bareImportRE.test(id)
    ) {
      // 查找最近的包含 name 字段的 package.json 数据
      const mainPkg = findNearestMainPackageData(basedir, packageCache)?.data;
      if (mainPkg) {
        // 获取 npm 包名
        const pkgName = getNpmPackageName(id);
        if (
          // 包名存在
          pkgName != null &&
          // mainPkg 的 peerDependencies 中包含 pkgName
          mainPkg.peerDependencies?.[pkgName] &&
          // mainPkg 的 peerDependenciesMeta 中的 pkgName 标记为可选，
          mainPkg.peerDependenciesMeta?.[pkgName]?.optional
        ) {
          // 则返回特定的 id 对象：
          return {
            id: `${optionalPeerDepId}:${id}:${mainPkg.name}`,
          };
        }
      }
    }
    return;
  }

  /**
   * 用于解析模块 ID 的函数，根据是否是深度导入（deep import），使用不同的解析函数
   * resolveDeepImport：处理深度导入（如导入某个包内部的特定文件）
   * resolvePackageEntry：处理包的入口文件解析
   */
  const resolveId = deepMatch ? resolveDeepImport : resolvePackageEntry;
  /**表示未解析的模块 ID，如果是深度导入，则会修正路径（加上相对路径） */
  const unresolvedId = deepMatch ? "." + id.slice(pkgId.length) : id;

  // 保存解析后的结果
  let resolved: string | undefined;
  try {
    // 尝试解析 unresolvedId
    resolved = resolveId(unresolvedId, pkg, targetWeb, options);
  } catch (err) {
    if (!options.tryEsmOnly) {
      throw err;
    }
  }

  // 如果第一次解析失败且 options.tryEsmOnly 为真，再次尝试解析
  if (!resolved && options.tryEsmOnly) {
    // 这次解析使用了默认的 mainFields 和 extensions 选项，并将 isRequire 设为false。
    resolved = resolveId(unresolvedId, pkg, targetWeb, {
      ...options,
      isRequire: false,
      mainFields: DEFAULT_MAIN_FIELDS,
      extensions: DEFAULT_EXTENSIONS,
    });
  }

  // 如果仍未解析成功，则直接返回 undefined
  if (!resolved) {
    return;
  }

  /**
   * 在特定条件下调用该函数来处理解析后的模块 ID
   * @param resolved
   * @returns
   */
  const processResult = (resolved: PartialResolvedId) => {
    if (!externalize) {
      return resolved;
    }

    // 检查是否允许外部化链接的包
    // 不要使用外部符号链接包
    if (!allowLinkedExternal && !isInNodeModules(resolved.id)) {
      // resolved.id 不在 node_modules 中，则直接返回 resolved 对象。
      // 这一步是为了避免外部化链接的包
      return resolved;
    }

    // 检查文件扩展名
    const resolvedExt = path.extname(resolved.id);
    // 不要外部非js的导入
    if (
      resolvedExt &&
      resolvedExt !== ".js" &&
      resolvedExt !== ".mjs" &&
      resolvedExt !== ".cjs"
    ) {
      // 扩展名不是 JavaScript 文件（.js, .mjs, .cjs），则返回 resolved 对象，不进行外部化
      return resolved;
    }

    // 处理深度导入
    let resolvedId = id;
    // 如果是深度导入 且 包没有 exports 字段 且  id 的扩展名与 resolved.id 的扩展名不同，则调整 resolvedId
    if (deepMatch && !pkg?.data.exports && path.extname(id) !== resolvedExt) {
      // 这里主要处理深度导入的情况。

      // id date-fns/locale
      // resolve.id ...date-fns/esm/locale/index.js
      // 例如，date-fns/locale 可能解析为 ...date-fns/esm/locale/index.js
      const index = resolved.id.indexOf(id);
      if (index > -1) {
        resolvedId = resolved.id.slice(index);
        debug?.(
          `[processResult] ${colors.cyan(id)} -> ${colors.dim(resolvedId)}`
        );
      }
    }

    // 设置 id 为 resolvedId，并标记 external 为 true，表示外部化处理
    return { ...resolved, id: resolvedId, external: true };
  };

  if (
    // options.idOnly 为 false，表示不只是解析 ID，需要完整的解析信息
    !options.idOnly &&
    // 不处于扫描模式，处于构建模式且没有 depsOptimizer
    // externalize  表示是否需要将模块标记为外部化
    ((!options.scan && isBuild && !depsOptimizer) || externalize)
  ) {
    // 调用 processResult 的目的是为了在构建时能够更好地进行 tree-shaking
    return processResult({
      id: resolved,
      // 模块的副作用信息，用于 Rollup 的 tree-shaking
      moduleSideEffects: pkg.hasSideEffects(resolved),
    });
  }

  if (
    // 表示不需要进行 SSR 优化检查
    !options.ssrOptimizeCheck &&
    // 表示解析的模块不在 node_modules 中（可能是链接的模块）
    (!isInNodeModules(resolved) || // linked
      // 表示没有依赖优化器
      !depsOptimizer || // 在侦听服务器之前进行解析
      // 表示当前处于初始 esbuild 扫描阶段
      options.scan)
  ) {
    // 这意味着在这些情况下，不需要进一步处理模块 ID，只需返回解析结果
    return { id: resolved };
  }

  // 如果我们到达这里，这是一个有效的深度导入，没有被优化。
  /**isJsType 用于判断模块是否为可优化的 JavaScript 类型 */
  const isJsType = depsOptimizer
    ? isOptimizable(resolved, depsOptimizer.options)
    : OPTIMIZABLE_ENTRY_RE.test(resolved);

  // 获取优化器选项
  let exclude = depsOptimizer?.options.exclude;
  let include = depsOptimizer?.options.include;
  if (options.ssrOptimizeCheck) {
    // 从 SSR 配置中获取 exclude 和 include
    exclude = options.ssrConfig?.optimizeDeps?.exclude;
    include = options.ssrConfig?.optimizeDeps?.include;
  }

  // 决定是否跳过优化
  const skipOptimization =
    // 如果不进行 SSR 优化检查且优化器禁用自动发现，则跳过优化
    (!options.ssrOptimizeCheck && depsOptimizer?.options.noDiscovery) ||
    // 如果模块不是可优化的 JavaScript 类型，则跳过优化
    !isJsType ||
    // 如果 importer 存在且在 node_modules 中，则跳过优化
    (importer && isInNodeModules(importer)) ||
    // pkgId 在 exclude 列表中，则跳过优化
    exclude?.includes(pkgId) ||
    //  id 在 exclude 列表中，则跳过优化
    exclude?.includes(id) ||
    // resolved 匹配特殊查询正则表达式，则跳过优化
    SPECIAL_QUERY_RE.test(resolved) ||
    /**
     * 在开发模式下进行 SSR 时，如果发现未优化的依赖，我们没有办法重新加载模块图。
     * 因此，我们需要在这里跳过优化。只有那些在配置中明确列出的依赖才会被优化。
     *
     * 1. 开发模式下的 SSR：在开发模式下进行 SSR 时，模块依赖图的重新加载是一个问题。
     * 如果在开发过程中发现了未优化的依赖，我们无法即时重新加载依赖图，这会导致模块无法正确处理或加载。
     *
     * 2. 跳过优化：为了避免这种问题，我们选择跳过这些未优化的依赖。这样可以保证在开发过程中，
     * 依赖图不会被意外重新加载，从而导致问题。
     *
     * 3. 配置中的优化：在这种情况下，只有那些在配置文件中明确列出的依赖会被优化。
     * 这些依赖是开发者明确指定需要优化的，避免了自动发现带来的问题。
     *
     */
    // 如果不进行 SSR 优化检查且不是构建模式且为 SSR，则跳过优化
    (!options.ssrOptimizeCheck && !isBuild && ssr) ||
    /**
     * 在默认情况下，SSR 仅优化那些非外部的 CommonJS (CJS) 依赖
     * 1. 非外部依赖：在 SSR 环境中，我们只优化那些不是外部 (external) 的依赖。
     * 外部依赖通常是指那些在 node_modules 中的模块，它们不会被打包到最终的输出中，而是保持外部引用。
     *
     * 2. CJS 依赖：默认情况下，我们只优化 CommonJS 格式的依赖。
     * 这是因为 CommonJS 是 Node.js 的标准模块格式，在 SSR 环境中更为常见
     *
     * 3. 优化目标：优化这些依赖可以提高 SSR 的性能，但默认情况下，我们限制优化的范围，
     * 避免对外部依赖进行不必要的处理。
     */

    // 在 SSR 模式下，如果模块是 ESM 格式文件且未包含在 include 列表中，则跳过优化
    (ssr &&
      isFilePathESM(resolved, options.packageCache) &&
      !(include?.includes(pkgId) || include?.includes(id)));

  // 检查当前是否在进行 SSR 优化检查
  if (options.ssrOptimizeCheck) {
    return {
      // 如果需要跳过优化，则在 resolved 路径中注入 __vite_skip_optimization 查询参数，表示这个依赖跳过优化
      // 否则直接返回resolved （解析后的id）
      id: skipOptimization
        ? injectQuery(resolved, `__vite_skip_optimization`)
        : resolved,
    };
  }

  //  跳过优化处理
  if (skipOptimization) {
    // 表示当前依赖被排除在优化之外

    /**
     * 如果不是在构建阶段 (!isBuild)，则为这些 npm 依赖注入一个版本查询参数，以便浏览器能够缓存它们而无需重新验证
     * 这样做的目的是为了已知的 JavaScript 类型，但避免对预打包依赖的外部文件引入重复模块
     */
    if (!isBuild) {
      const versionHash = depsOptimizer!.metadata.browserHash;
      if (versionHash && isJsType) {
        resolved = injectQuery(resolved, `v=${versionHash}`);
      }
    }
  } else {
    //  处理未优化的依赖

    // this is a missing import, queue optimize-deps re-run and
    // get a resolved its optimized info
    /**
     * 源码在这里解释了在遇到未找到的导入依赖时，Vite 的处理流程
     *
     * Missing import (未找到的导入): 这是一个未找到的导入依赖。
     * 这种情况发生在当前模块依赖的某个包没有被找到或者未被正确解析。
     *
     * Queue optimize-deps re-run (队列优化依赖重新运行): 这段代码会将这个未找到的导入依赖加入到需要重新运行依赖优化的队列中。
     * 这样可以确保在后续的优化过程中，这个依赖能够被正确处理。
     *
     * Get a resolved its optimized info (获取已解析的优化信息): 在将未找到的依赖加入到优化队列后，
     * 会获取并返回这个依赖的优化信息。这包括获取优化后的依赖路径，以便后续正确使用优化后的依赖。
     */

    // 注册一个未找到的导入依赖，这会触发依赖优化
    const optimizedInfo = depsOptimizer!.registerMissingImport(id, resolved);
    // 使用 depsOptimizer 获取优化后的依赖 ID，这个 ID 是在优化过程中生成的，可以确保导入依赖被正确解析和使用。
    // 将优化后的依赖 ID 赋值给 resolved，以便在后续使用这个优化后的路径
    resolved = depsOptimizer!.getOptimizedDepId(optimizedInfo);
  }

  // 这段代码的目的是在构建过程中处理模块的副作用信息，以便 Rollup 可以更好地执行 tree-shaking
  // idOnly 为 false 且scan 为 false，isBuild为 true
  if (!options.idOnly && !options.scan && isBuild) {
    // 检查 idOnly 选项是否为 false。这意味着我们不仅仅是解析模块 ID，还需要解析更多信息
    // 检查 scan 选项是否为 false。这意味着当前不是在进行扫描操作（例如依赖分析）
    // 检查当前是否处于构建阶段。如果是构建阶段，我们需要确保所有副作用信息都能正确处理

    return {
      id: resolved,
      // 这行代码会检查这个模块是否有副作用，并将其作为 moduleSideEffects 属性返回
      // hasSideEffects 这个方法用于判断一个模块是否有副作用
      // 它会检查 package.json 文件中的 sideEffects 字段
      // 如果一个模块被标记为有副作用，那么即使在代码中未被引用，Rollup 也不会移除它
      moduleSideEffects: pkg.hasSideEffects(resolved),
    };
  } else {
    // 即不在构建阶段，或者只需要解析 ID，或者正在进行扫描操作
    // 那么仅返回解析后的模块 ID
    return { id: resolved! };
  }
}

/**
 * 用于解析深层次的模块导入
 * @param id 需要解析的模块 ID
 * @param param1
 * @param targetWeb
 * @param options
 * @returns
 */
function resolveDeepImport(
  id: string,
  {
    // 缓存相关的操作
    webResolvedImports,
    setResolvedCache,
    getResolvedCache,
    dir, // 包所在的目录
    data, // 包的元数据，包括 package.json 中的信息
  }: PackageData,
  targetWeb: boolean, // 是否为 Web 目标进行解析
  options: InternalResolveOptions // 解析选项
): string | undefined {
  // 首先检查缓存中是否已有解析结果，如果有则直接返回
  const cache = getResolvedCache(id, targetWeb);
  if (cache) {
    return cache;
  }

  let relativeId: string | undefined | void = id;
  // 从包的元数据中提取 exports 和 browser 字段
  const { exports: exportsField, browser: browserField } = data;

  // map relative based on exports data
  // 处理根据 exports 字段解析模块路径的问题
  if (exportsField) {
    // 检查 exports 字段是否存在并且是对象（非数组）
    if (isObject(exportsField) && !Array.isArray(exportsField)) {
      // resolve without postfix (see #7098)
      // 拆分文件和后缀
      const { file, postfix } = splitFileAndPostfix(relativeId);
      // 解析导出路径
      const exportsId = resolveExportsOrImports(
        data,
        file,
        options,
        targetWeb,
        "exports"
      );

      if (exportsId !== undefined) {
        // exportsId 被解析成功，则将 relativeId 设置为 exportsId 加上之前的 postfix
        relativeId = exportsId + postfix;
      } else {
        // 解析失败则赋值为 undefined，交给后续处理
        relativeId = undefined;
      }
    } else {
      // 如果 exportsField 不是对象或是数组，则直接将 relativeId 设置为 undefined
      relativeId = undefined;
    }

    // 上面的代码的主要功能是根据包的 package.json 文件中的 exports 字段来解析模块路径

    // 如果 relativeId 未定义，抛出错误，提示该子路径未在 exports 字段中定义
    if (!relativeId) {
      throw new Error(
        `Package subpath '${relativeId}' is not defined by "exports" in ` +
          `${path.join(dir, "package.json")}.`
      );
    }
  } else if (
    // 处理在目标为 web 的环境中使用 browser 字段（并且该字段是一个对象）进行模块解析的情况
    targetWeb &&
    options.mainFields.includes("browser") &&
    isObject(browserField)
  ) {
    // 解决没有后缀的情况（参见 #7098）

    // 拆分文件和后缀 如foo/bar.js 将被拆分为 file: "foo/bar" 和 postfix: ".js"
    const { file, postfix } = splitFileAndPostfix(relativeId);
    // 使用 browserField 映射文件路径
    const mapped = mapWithBrowserField(file, browserField);
    if (mapped) {
      // 如果映射成功，使用映射后的路径和后缀
      relativeId = mapped + postfix;
    } else if (mapped === false) {
      // mapped 为false 表示该模块在浏览器环境中不应被解析或加载
      // 因此将 id 对应的值设置为 browserExternalId
      return (webResolvedImports[id] = browserExternalId);
    }
  }

  if (relativeId) {
    // relativeId 解析成功了，就尝试通过文件系统路径来解析它。
    // 如果解析成功，将结果缓存起来并返回

    // 调用 tryFsResolve 函数尝试解析文件系统路径
    const resolved = tryFsResolve(
      path.join(dir, relativeId), //将 dir 和 relativeId 结合起来，形成完整的文件路径
      options,
      !exportsField, // 如果没有 exports 字段，则尝试使用 index 解析
      targetWeb
    );

    if (resolved) {
      // 解析成功，通过 debug 打印解析结果
      debug?.(
        `[node/deep-import] ${colors.cyan(id)} -> ${colors.dim(resolved)}`
      );

      // 将解析结果缓存起来，以便下次使用
      setResolvedCache(id, resolved, targetWeb);

      // 返回解析结果
      return resolved;
    }
  }
}

/**
 * 解析包的入口点，考虑到各种可能的入口配置和字段
 * @param id
 * @param param1
 * @param targetWeb
 * @param options
 * @returns
 */
export function resolvePackageEntry(
  id: string,
  { dir, data, setResolvedCache, getResolvedCache }: PackageData,
  targetWeb: boolean,
  options: InternalResolveOptions
): string | undefined {
  // 拆分文件和后缀
  const { file: idWithoutPostfix, postfix } = splitFileAndPostfix(id);

  // 检查是否有缓存的解析结果，如果有，直接返回缓存结果加上后缀
  const cached = getResolvedCache(".", targetWeb);
  if (cached) {
    return cached + postfix;
  }

  try {
    // 用于存储解析到的入口点
    let entryPoint: string | undefined;

    // resolve exports field with highest priority
    // using https://github.com/lukeed/resolve.exports
    if (data.exports) {
      // 如果 package.json 中有 exports 字段
      entryPoint = resolveExportsOrImports(
        data,
        ".",
        options,
        targetWeb,
        "exports"
      );
    }

    // 如果未解析到入口点，则回退到 mainFields
    if (!entryPoint) {
      // 遍历 options.mainFields，依次尝试解析 browser 字段或其他字段
      for (const field of options.mainFields) {
        if (field === "browser") {
          if (targetWeb) {
            entryPoint = tryResolveBrowserEntry(dir, data, options);
            if (entryPoint) {
              break;
            }
          }
        } else if (typeof data[field] === "string") {
          entryPoint = data[field];
          break;
        }
      }
    }

    // 如果上述步骤都未解析到入口点，则尝试使用 main 字段
    entryPoint ||= data.main;

    // https://nodejs.org/api/modules.html#all-together
    /**
     * 如果解析到 entryPoint，使用它作为唯一的入口文件，
     * 否则使用默认的入口文件 index.js，index.json，index.node
     */
    const entryPoints = entryPoint
      ? [entryPoint]
      : ["index.js", "index.json", "index.node"];

    // 尝试解析每个入口文件
    for (let entry of entryPoints) {
      // 确保我们在寻找sass的时候没有得到脚本

      // 跳过不适合的脚本文件
      let skipPackageJson = false;
      if (
        // 第一个字段是 sass
        options.mainFields[0] === "sass" &&
        // 且入口文件的扩展名不在
        !options.extensions.includes(path.extname(entry))
      ) {
        // 跳过以避免获取到脚本文件
        entry = "";
        skipPackageJson = true;
      } else {
        // 解析 package.json 中的 browser 字段
        const { browser: browserField } = data;
        if (
          targetWeb &&
          // mainFields 包含 browser
          options.mainFields.includes("browser") &&
          isObject(browserField)
        ) {
          // 解析 browserField 字段
          entry = mapWithBrowserField(entry, browserField) || entry;
        }
      }

      // 构建入口文件的完整路径
      const entryPointPath = path.join(dir, entry);
      // 尝试文件系统解析入口文件
      const resolvedEntryPoint = tryFsResolve(
        entryPointPath,
        options,
        true,
        true,
        skipPackageJson
      );

      if (resolvedEntryPoint) {
        // 如果成功解析到入口文件，调用 debug 函数记录日志
        debug?.(
          `[package entry] ${colors.cyan(idWithoutPostfix)} -> ${colors.dim(
            resolvedEntryPoint
          )}${postfix !== "" ? ` (postfix: ${postfix})` : ""}`
        );

        // 将解析结果缓存起来，最后返回解析结果加上后缀
        setResolvedCache(".", resolvedEntryPoint, targetWeb);
        return resolvedEntryPoint + postfix;
      }
    }
  } catch (e) {
    // 记录错误信息
    packageEntryFailure(id, e.message);
  }
  packageEntryFailure(id);
}

/**入口文件解析失败错误处理，主要是抛出响应的错误信息 */
function packageEntryFailure(id: string, details?: string) {
  const err: any = new Error(
    `Failed to resolve entry for package "${id}". ` +
      `The package may have incorrect main/module/exports specified in its package.json` +
      (details ? ": " + details : ".")
  );
  err.code = ERR_RESOLVE_PACKAGE_ENTRY_FAIL;
  throw err;
}

/**
 * 在模块解析过程中用于尝试解析文件系统路径，确定模块的实际位置
 * 这个函数主要用于处理 node_modules 中的依赖，特别是那些路径中包含特殊字符如 # 和 ? 的情况
 * @param fsPath 要解析的文件系统路径
 * @param options 解析选项，包含一些控制解析行为的参数
 * @param tryIndex 是否尝试解析 index 文件（如 index.js）
 * @param targetWeb
 * @param skipPackageJson  是否跳过 package.json 文件的解析
 * @returns
 */
export function tryFsResolve(
  fsPath: string,
  options: InternalResolveOptions,
  tryIndex = true,
  targetWeb = true,
  skipPackageJson = false
): string | undefined {
  /**
   * 源码中这段注释解释了为什么函数 tryFsResolve 需要特别处理路径中包含 # 和 ? 的情况，以及这种处理的适用范围。
   *
   * 一些依赖包（例如 es5-ext）在它们的文件路径中会使用 # 这个字符
   * 在用户编写的源代码中，不允许使用 # 这种特殊字符，因此只需要对 node_modules 中的依赖进行处理
   * 在 node_modules 中的路径也不允许包含 ? 这种字符，因此这个检查逻辑只需要在处理 node_modules 路径时使用
   */

  // 检查路径中是否包含 # 和 ?，这是为了处理一些依赖包路径中可能存在的特殊字符

  // 找到路径中 # 的位置
  const hashIndex = fsPath.indexOf("#");
  if (hashIndex >= 0 && isInNodeModules(fsPath)) {
    // 如果路径中包含 # 且位于 node_modules 中，则提取出文件路径进行解析

    // 找到路径中 ？ 的位置
    const queryIndex = fsPath.indexOf("?");
    // We only need to check foo#bar?baz and foo#bar, ignore foo?bar#baz
    if (queryIndex < 0 || queryIndex > hashIndex) {
      // 如果不存在？ 或者是 ？ 在 # 的后面

      // 提取出不包含查询参数的文件路径
      const file =
        queryIndex > hashIndex ? fsPath.slice(0, queryIndex) : fsPath;

      // 解析提取出的文件路径
      const res = tryCleanFsResolve(
        file,
        options,
        tryIndex,
        targetWeb,
        skipPackageJson
      );

      // 如果解析成功，返回解析结果并加上原路径中的后缀
      if (res) return res + fsPath.slice(file.length);
    }
  }

  // 拆分文件路径和后缀
  const { file, postfix } = splitFileAndPostfix(fsPath);
  // 解析文件路径
  const res = tryCleanFsResolve(
    file,
    options,
    tryIndex,
    targetWeb,
    skipPackageJson
  );
  // 如果解析成功，返回解析结果并加上后缀
  if (res) return res + postfix;
}

/**
 * 这个函数将路径分为文件路径和后缀部分
 * @param path
 * @returns
 * @example
 * 如foo/bar.js 将被拆分为 file: "foo/bar" 和 postfix: ".js"
 */
function splitFileAndPostfix(path: string) {
  const file = cleanUrl(path);
  return { file, postfix: path.slice(file.length) };
}

/**
 * 用于根据特定的条件解析包的 exports 或 imports 字段，确定模块的入口点
 * @param pkg 包数据，通常是 package.json 的内容
 * @param key  要解析的键，可能是相对路径或模块名
 * @param options 解析选项，包含一些条件和配置
 * @param targetWeb 是否针对 Web 环境进行解析
 * @param type 指定解析的类型，是 exports 还是 imports
 * @returns
 */
function resolveExportsOrImports(
  pkg: PackageData["data"],
  key: string,
  options: InternalResolveOptionsWithOverrideConditions,
  targetWeb: boolean,
  type: "imports" | "exports"
) {
  // 根据 options 设置附加条件，如果没有提供则使用默认条件
  const additionalConditions = new Set(
    options.overrideConditions || [
      "production",
      "development",
      "module",
      ...options.conditions,
    ]
  );

  // 根据当前环境过滤附加条件，例如生产环境和开发环境的区别
  const conditions = [...additionalConditions].filter((condition) => {
    switch (condition) {
      case "production":
        return options.isProduction;
      case "development":
        return !options.isProduction;
    }
    return true;
  });

  // 根据 type 选择解析 imports 还是 exports
  const fn = type === "imports" ? imports : exports;

  // 解析导入或导出:
  const result = fn(pkg, key, {
    browser: targetWeb && !additionalConditions.has("node"),
    require: options.isRequire && !additionalConditions.has("import"),
    conditions,
  });

  // 如果有结果则返回第一个解析结果，否则返回 undefined
  return result ? result[0] : undefined;
}

/**
 * 该函数根据 package.json 中的 browser 字段将路径映射到相应的文件路径
 * @param relativePathInPkgDir 包目录中的相对路径
 * @param map 字段的映射对象
 * @returns
 */
function mapWithBrowserField(
  relativePathInPkgDir: string,
  map: Record<string, string | false>
): string | false | undefined {
  // 将相对路径标准化为 POSIX 风格
  const normalizedPath = path.posix.normalize(relativePathInPkgDir);

  // 遍历映射:
  for (const key in map) {
    // 标准化key
    const normalizedKey = path.posix.normalize(key);

    if (
      normalizedPath === normalizedKey ||
      equalWithoutSuffix(normalizedPath, normalizedKey, ".js") ||
      equalWithoutSuffix(normalizedPath, normalizedKey, "/index.js")
    ) {
      // 如果找到匹配项，则返回对应的映射路径
      return map[key];
    }
  }
}

/**
 * 用于比较两个路径是否在去掉特定后缀后相等
 * @param path 要比较的路径
 * @param key 参考路径
 * @param suffix 要去掉的后缀
 * @returns
 */
function equalWithoutSuffix(path: string, key: string, suffix: string) {
  // 检查 key 是否以 suffix 结尾，并且去掉后缀后的 key 是否等于 path
  return key.endsWith(suffix) && key.slice(0, -suffix.length) === path;
}

/**用于匹配可能的 TypeScript 输出文件 */
const knownTsOutputRE = /\.(?:js|mjs|cjs|jsx)$/;
/**判断给定的 URL 是否可能是 TypeScript 输出文件 */
const isPossibleTsOutput = (url: string): boolean => knownTsOutputRE.test(url);

/**
 * 函数尝试解析文件系统路径，优先考虑解析 .js、.mjs、.cjs、.jsx 到对应的 TypeScript 文件，同时处理目录和包的入口解析
 * @param file 要解析的文件路径
 * @param options 解析选项，包括前缀、扩展名、是否保留符号链接等
 * @param tryIndex 是否尝试解析索引文件
 * @param targetWeb 是否针对 Web 环境进行解析
 * @param skipPackageJson 是否跳过 package.json 文件解析
 * @returns
 */
function tryCleanFsResolve(
  file: string,
  options: InternalResolveOptions,
  tryIndex = true,
  targetWeb = true,
  skipPackageJson = false
): string | undefined {
  const { tryPrefix, extensions, preserveSymlinks } = options;

  // 获取一些 文件系统的工具函数
  const fsUtils = options.fsUtils ?? commonFsUtils;

  // 优化解析文件类型，如果找到路径直接返回
  const fileResult = fsUtils.tryResolveRealFileOrType(
    file,
    options.preserveSymlinks
  );

  if (fileResult?.path) return fileResult.path;

  // 用于存储解析后的文件路径
  let res: string | undefined;

  // 如果路径的目录名是一个有效的目录，尝试扩展名和 TypeScript 解析逻辑
  /**possibleJsToTs 表示是否需要将可能的 JavaScript 输出文件解析为 TypeScript 文件 */
  const possibleJsToTs = options.isFromTsImporter && isPossibleTsOutput(file);
  if (possibleJsToTs || options.extensions.length || tryPrefix) {
    // 如果需要进行 TypeScript 文件解析，或者指定了扩展名或前缀，则进入进一步解析逻辑

    // 获取文件的目录路径 dirPath
    const dirPath = path.dirname(file);
    // 检查 dirPath 是否是一个有效的目录
    if (fsUtils.isDirectory(dirPath)) {
      if (possibleJsToTs) {
        // try resolve .js, .mjs, .cjs or .jsx import to typescript file
        // 尝试将可能的 JavaScript 输出文件解析为 TypeScript 文件:

        /**
         * 这段代码的目的是为了在解析 JavaScript 文件时，考虑可能存在的 TypeScript 版本文件 (.ts 或 .tsx)
         * 这种尝试是为了支持在项目中混合使用 JavaScript 和 TypeScript 文件时的解析需求
         */
        // 获取文件的扩展名
        const fileExt = path.extname(file);
        // 获取文件名
        const fileName = file.slice(0, -fileExt.length);

        if (
          // 尝试将 .js、.mjs、.cjs、.jsx 扩展名替换为 .ts 并解析。
          (res = fsUtils.tryResolveRealFile(
            fileName + fileExt.replace("js", "ts"),
            preserveSymlinks
          ))
        )
          return res;

        // 对于 .js 文件，还尝试将其解析为 .tsx 文件
        if (
          fileExt === ".js" &&
          (res = fsUtils.tryResolveRealFile(
            fileName + ".tsx",
            preserveSymlinks
          ))
        )
          return res;
      }

      // 尝试解析扩展名:
      if (
        // 如果有指定的扩展名，尝试将文件路径与这些扩展名结合解析
        (res = fsUtils.tryResolveRealFileWithExtensions(
          file,
          extensions,
          preserveSymlinks
        ))
      )
        return res;

      // 尝试带前缀的解析:
      if (tryPrefix) {
        // 如果指定了前缀，尝试将文件名加上前缀后进行解析
        const prefixed = `${dirPath}/${options.tryPrefix}${path.basename(
          file
        )}`;

        if ((res = fsUtils.tryResolveRealFile(prefixed, preserveSymlinks)))
          return res;

        if (
          (res = fsUtils.tryResolveRealFileWithExtensions(
            prefixed,
            extensions,
            preserveSymlinks
          ))
        )
          return res;
      }
    }
  }

  // 检查是否需要进行索引解析:
  if (tryIndex && fileResult?.type === "directory") {
    // 处理文件路径指向目录时的解析逻辑。主要是检查目录下是否存在 package.json 文件或者 /index 文件，并进行相应的解析处理

    // 获取当前文件路径作为目录路径
    const dirPath = file;

    // 如果不跳过解析 package.json，构建 pkgPath 表示 package.json 文件路径
    if (!skipPackageJson) {
      let pkgPath = `${dirPath}/package.json`;

      try {
        //  检查 pkgPath 是否存在
        if (fsUtils.existsSync(pkgPath)) {
          // 如果存在且不需要保留符号链接,获取实际路径
          if (!options.preserveSymlinks) {
            pkgPath = safeRealpathSync(pkgPath);
          }
          // 加载 package.json 数据
          const pkg = loadPackageData(pkgPath);
          // 解析包入口
          return resolvePackageEntry(dirPath, pkg, targetWeb, options);
        }
      } catch (e) {
        // This check is best effort, so if an entry is not found, skip error for now
        if (e.code !== ERR_RESOLVE_PACKAGE_ENTRY_FAIL && e.code !== "ENOENT")
          throw e;
      }
    }

    // 尝试解析 /index 文件:
    if (
      // 尝试解析带有扩展名的 /index 文件
      (res = fsUtils.tryResolveRealFileWithExtensions(
        `${dirPath}/index`,
        extensions,
        preserveSymlinks
      ))
    )
      return res;

    // 尝试使用前缀的 /index 文件解析
    if (tryPrefix) {
      if (
        (res = fsUtils.tryResolveRealFileWithExtensions(
          `${dirPath}/${options.tryPrefix}index`,
          extensions,
          preserveSymlinks
        ))
      )
        return res;
    }
  }

  // tryCleanFsResolve 函数是一个多功能的文件路径解析器，根据传入的参数和文件路径的类型，尝试多种解析逻辑，
  // 包括但不限于扩展名解析、TypeScript 文件解析、目录下的 package.json 和 /index 文件解析
}

function ensureVersionQuery(
  resolved: string,
  id: string,
  options: InternalResolveOptions,
  depsOptimizer?: DepsOptimizer
): string {
  if (
    !options.isBuild &&
    !options.scan &&
    depsOptimizer &&
    !(resolved === normalizedClientEntry || resolved === normalizedEnvEntry)
  ) {
    // Ensure that direct imports of node_modules have the same version query
    // as if they would have been imported through a bare import
    // Use the original id to do the check as the resolved id may be the real
    // file path after symlinks resolution
    const isNodeModule = isInNodeModules(id) || isInNodeModules(resolved);

    if (isNodeModule && !DEP_VERSION_RE.test(resolved)) {
      const versionHash = depsOptimizer.metadata.browserHash;
      if (versionHash && isOptimizable(resolved, depsOptimizer.options)) {
        resolved = injectQuery(resolved, `v=${versionHash}`);
      }
    }
  }
  return resolved;
}

function tryResolveBrowserMapping(
  id: string,
  importer: string | undefined,
  options: InternalResolveOptions,
  isFilePath: boolean,
  externalize?: boolean
) {
  let res: string | undefined;
  const pkg =
    importer &&
    findNearestPackageData(path.dirname(importer), options.packageCache);
  if (pkg && isObject(pkg.data.browser)) {
    const mapId = isFilePath ? "./" + slash(path.relative(pkg.dir, id)) : id;
    const browserMappedPath = mapWithBrowserField(mapId, pkg.data.browser);
    if (browserMappedPath) {
      if (
        (res = bareImportRE.test(browserMappedPath)
          ? tryNodeResolve(browserMappedPath, importer, options, true)?.id
          : tryFsResolve(path.join(pkg.dir, browserMappedPath), options))
      ) {
        debug?.(`[browser mapped] ${colors.cyan(id)} -> ${colors.dim(res)}`);
        let result: PartialResolvedId = { id: res };
        if (options.idOnly) {
          return result;
        }
        if (!options.scan && options.isBuild) {
          const resPkg = findNearestPackageData(
            path.dirname(res),
            options.packageCache
          );
          if (resPkg) {
            result = {
              id: res,
              moduleSideEffects: resPkg.hasSideEffects(res),
            };
          }
        }
        return externalize ? { ...result, external: true } : result;
      }
    } else if (browserMappedPath === false) {
      return browserExternalId;
    }
  }
}

function tryResolveBrowserEntry(
  dir: string,
  data: PackageData["data"],
  options: InternalResolveOptions
) {
  // handle edge case with browser and module field semantics

  // check browser field
  // https://github.com/defunctzombie/package-browser-field-spec
  const browserEntry =
    typeof data.browser === "string"
      ? data.browser
      : isObject(data.browser) && data.browser["."];
  if (browserEntry) {
    // check if the package also has a "module" field.
    if (
      !options.isRequire &&
      options.mainFields.includes("module") &&
      typeof data.module === "string" &&
      data.module !== browserEntry
    ) {
      // if both are present, we may have a problem: some package points both
      // to ESM, with "module" targeting Node.js, while some packages points
      // "module" to browser ESM and "browser" to UMD/IIFE.
      // the heuristics here is to actually read the browser entry when
      // possible and check for hints of ESM. If it is not ESM, prefer "module"
      // instead; Otherwise, assume it's ESM and use it.
      const resolvedBrowserEntry = tryFsResolve(
        path.join(dir, browserEntry),
        options
      );
      if (resolvedBrowserEntry) {
        const content = fs.readFileSync(resolvedBrowserEntry, "utf-8");
        if (hasESMSyntax(content)) {
          // likely ESM, prefer browser
          return browserEntry;
        } else {
          // non-ESM, UMD or IIFE or CJS(!!! e.g. firebase 7.x), prefer module
          return data.module;
        }
      }
    } else {
      return browserEntry;
    }
  }
}

function resolveSubpathImports(
  id: string,
  importer: string | undefined,
  options: InternalResolveOptions,
  targetWeb: boolean
) {
  if (!importer || !id.startsWith(subpathImportsPrefix)) return;
  const basedir = path.dirname(importer);
  const pkgData = findNearestPackageData(basedir, options.packageCache);
  if (!pkgData) return;

  let { file: idWithoutPostfix, postfix } = splitFileAndPostfix(id.slice(1));
  idWithoutPostfix = "#" + idWithoutPostfix;

  let importsPath = resolveExportsOrImports(
    pkgData.data,
    idWithoutPostfix,
    options,
    targetWeb,
    "imports"
  );

  if (importsPath?.[0] === ".") {
    importsPath = path.relative(basedir, path.join(pkgData.dir, importsPath));

    if (importsPath[0] !== ".") {
      importsPath = `./${importsPath}`;
    }
  }

  return importsPath + postfix;
}

export async function tryOptimizedResolve(
  depsOptimizer: DepsOptimizer,
  id: string,
  importer?: string,
  preserveSymlinks?: boolean,
  packageCache?: PackageCache
): Promise<string | undefined> {
  // TODO: we need to wait until scanning is done here as this function
  // is used in the preAliasPlugin to decide if an aliased dep is optimized,
  // and avoid replacing the bare import with the resolved path.
  // We should be able to remove this in the future
  await depsOptimizer.scanProcessing;

  const metadata = depsOptimizer.metadata;

  const depInfo = optimizedDepInfoFromId(metadata, id);
  if (depInfo) {
    return depsOptimizer.getOptimizedDepId(depInfo);
  }

  if (!importer) return;

  // further check if id is imported by nested dependency
  let idPkgDir: string | undefined;
  const nestedIdMatch = `> ${id}`;

  for (const optimizedData of metadata.depInfoList) {
    if (!optimizedData.src) continue; // Ignore chunks

    // check where "foo" is nested in "my-lib > foo"
    if (!optimizedData.id.endsWith(nestedIdMatch)) continue;

    // lazily initialize idPkgDir
    if (idPkgDir == null) {
      const pkgName = getNpmPackageName(id);
      if (!pkgName) break;
      idPkgDir = resolvePackageData(
        pkgName,
        importer,
        preserveSymlinks,
        packageCache
      )?.dir;
      // if still null, it likely means that this id isn't a dep for importer.
      // break to bail early
      if (idPkgDir == null) break;
      idPkgDir = normalizePath(idPkgDir);
    }

    // match by src to correctly identify if id belongs to nested dependency
    if (optimizedData.src.startsWith(withTrailingSlash(idPkgDir))) {
      return depsOptimizer.getOptimizedDepId(optimizedData);
    }
  }
}
