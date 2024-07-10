import fs from "node:fs";
import path from "node:path";
import colors from "picocolors";
import type { PartialResolvedId } from "rollup";

import type { Plugin } from "../plugin";
import {
  CLIENT_ENTRY,
  DEFAULT_EXTENSIONS,
  DEFAULT_MAIN_FIELDS,
  // DEP_VERSION_RE,
  ENV_ENTRY,
  FS_PREFIX,
  OPTIMIZABLE_ENTRY_RE,
  SPECIAL_QUERY_RE,
} from "../constants";
import {
  bareImportRE,
  createDebugger,
  deepImportRE,
  getNpmPackageName,
  injectQuery,
  isBuiltin,
  isFilePathESM,
  isInNodeModules,
  isOptimizable,
} from "../utils";
import type { DepsOptimizer } from "../optimizer";
import {
  cleanUrl,
  isWindows,
  slash,
  withTrailingSlash,
} from "../../shared/utils";
import {
  findNearestMainPackageData,
  findNearestPackageData,
  // loadPackageData,
  resolvePackageData,
} from "../packages";
import type { PackageCache, PackageData } from "../packages";

const debug = createDebugger("vite:resolve-details", {
  onlyWhenFocused: true,
});

export const optionalPeerDepId = "__vite-optional-peer-dep";

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
  const rootInRoot = tryStatSync(path.join(root, root))?.isDirectory() ?? false;

  return {
    name: "vite:resolve",

    async resolveId(id, importer, resolveOpts) {
      if (
        id[0] === "\0" ||
        id.startsWith("virtual:") ||
        // When injected directly in html/client code
        id.startsWith("/virtual:")
      ) {
        return;
      }

      const ssr = resolveOpts?.ssr === true;

      // We need to delay depsOptimizer until here instead of passing it as an option
      // the resolvePlugin because the optimizer is created on server listen during dev
      const depsOptimizer = resolveOptions.getDepsOptimizer?.(ssr);

      if (id.startsWith(browserExternalId)) {
        return id;
      }

      const targetWeb = !ssr || ssrTarget === "webworker";

      // this is passed by @rollup/plugin-commonjs
      const isRequire: boolean =
        resolveOpts?.custom?.["node-resolve"]?.isRequire ?? false;

      // end user can configure different conditions for ssr and client.
      // falls back to client conditions if no ssr conditions supplied
      const ssrConditions =
        resolveOptions.ssrConfig?.resolve?.conditions ||
        resolveOptions.conditions;

      const options: InternalResolveOptions = {
        isRequire,
        ...resolveOptions,
        scan: resolveOpts?.scan ?? resolveOptions.scan,
        conditions: ssr ? ssrConditions : resolveOptions.conditions,
      };

      const resolvedImports = resolveSubpathImports(
        id,
        importer,
        options,
        targetWeb
      );
      if (resolvedImports) {
        id = resolvedImports;

        if (resolveOpts.custom?.["vite:import-glob"]?.isSubImportsPattern) {
          return id;
        }
      }

      if (importer) {
        if (
          isTsRequest(importer) ||
          resolveOpts.custom?.depScan?.loader?.startsWith("ts")
        ) {
          options.isFromTsImporter = true;
        } else {
          const moduleLang = this.getModuleInfo(importer)?.meta?.vite?.lang;
          options.isFromTsImporter =
            moduleLang && isTsRequest(`.${moduleLang}`);
        }
      }

      let res: string | PartialResolvedId | undefined;

      // resolve pre-bundled deps requests, these could be resolved by
      // tryFileResolve or /fs/ resolution but these files may not yet
      // exists if we are in the middle of a deps re-processing
      if (asSrc && depsOptimizer?.isOptimizedDepUrl(id)) {
        const optimizedPath = id.startsWith(FS_PREFIX)
          ? fsPathFromId(id)
          : normalizePath(path.resolve(root, id.slice(1)));
        return optimizedPath;
      }

      // explicit fs paths that starts with /@fs/*
      if (asSrc && id.startsWith(FS_PREFIX)) {
        res = fsPathFromId(id);
        // We don't need to resolve these paths since they are already resolved
        // always return here even if res doesn't exist since /@fs/ is explicit
        // if the file doesn't exist it should be a 404.
        debug?.(`[@fs] ${colors.cyan(id)} -> ${colors.dim(res)}`);
        return ensureVersionQuery(res, id, options, depsOptimizer);
      }

      // URL
      // /foo -> /fs-root/foo
      if (
        asSrc &&
        id[0] === "/" &&
        (rootInRoot || !id.startsWith(withTrailingSlash(root)))
      ) {
        const fsPath = path.resolve(root, id.slice(1));
        if ((res = tryFsResolve(fsPath, options))) {
          debug?.(`[url] ${colors.cyan(id)} -> ${colors.dim(res)}`);
          return ensureVersionQuery(res, id, options, depsOptimizer);
        }
      }

      // relative
      if (
        id[0] === "." ||
        ((preferRelative || importer?.endsWith(".html")) &&
          startsWithWordCharRE.test(id))
      ) {
        const basedir = importer ? path.dirname(importer) : process.cwd();
        const fsPath = path.resolve(basedir, id);
        // handle browser field mapping for relative imports

        const normalizedFsPath = normalizePath(fsPath);

        if (depsOptimizer?.isOptimizedDepFile(normalizedFsPath)) {
          // Optimized files could not yet exist in disk, resolve to the full path
          // Inject the current browserHash version if the path doesn't have one
          if (
            !resolveOptions.isBuild &&
            !DEP_VERSION_RE.test(normalizedFsPath)
          ) {
            const browserHash = optimizedDepInfoFromFile(
              depsOptimizer.metadata,
              normalizedFsPath
            )?.browserHash;
            if (browserHash) {
              return injectQuery(normalizedFsPath, `v=${browserHash}`);
            }
          }
          return normalizedFsPath;
        }

        if (
          targetWeb &&
          options.mainFields.includes("browser") &&
          (res = tryResolveBrowserMapping(fsPath, importer, options, true))
        ) {
          return res;
        }

        if ((res = tryFsResolve(fsPath, options))) {
          res = ensureVersionQuery(res, id, options, depsOptimizer);
          debug?.(`[relative] ${colors.cyan(id)} -> ${colors.dim(res)}`);

          // If this isn't a script imported from a .html file, include side effects
          // hints so the non-used code is properly tree-shaken during build time.
          if (
            !options.idOnly &&
            !options.scan &&
            options.isBuild &&
            !importer?.endsWith(".html")
          ) {
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

      // drive relative fs paths (only windows)
      if (isWindows && id[0] === "/") {
        const basedir = importer ? path.dirname(importer) : process.cwd();
        const fsPath = path.resolve(basedir, id);
        if ((res = tryFsResolve(fsPath, options))) {
          debug?.(`[drive-relative] ${colors.cyan(id)} -> ${colors.dim(res)}`);
          return ensureVersionQuery(res, id, options, depsOptimizer);
        }
      }

      // absolute fs paths
      if (
        isNonDriveRelativeAbsolutePath(id) &&
        (res = tryFsResolve(id, options))
      ) {
        debug?.(`[fs] ${colors.cyan(id)} -> ${colors.dim(res)}`);
        return ensureVersionQuery(res, id, options, depsOptimizer);
      }

      // external
      if (isExternalUrl(id)) {
        return options.idOnly ? id : { id, external: true };
      }

      // data uri: pass through (this only happens during build and will be
      // handled by dedicated plugin)
      if (isDataUrl(id)) {
        return null;
      }

      // bare package imports, perform node resolve
      if (bareImportRE.test(id)) {
        const external = options.shouldExternalize?.(id, importer);
        if (
          !external &&
          asSrc &&
          depsOptimizer &&
          !options.scan &&
          (res = await tryOptimizedResolve(
            depsOptimizer,
            id,
            importer,
            options.preserveSymlinks,
            options.packageCache
          ))
        ) {
          return res;
        }

        if (
          targetWeb &&
          options.mainFields.includes("browser") &&
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

        // node built-ins.
        // externalize if building for SSR, otherwise redirect to empty module
        if (isBuiltin(id)) {
          if (ssr) {
            if (
              targetWeb &&
              ssrNoExternal === true &&
              // if both noExternal and external are true, noExternal will take the higher priority and bundle it.
              // only if the id is explicitly listed in external, we will externalize it and skip this error.
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
            if (!asSrc) {
              debug?.(
                `externalized node built-in "${id}" to empty module. ` +
                  `(imported by: ${colors.white(colors.dim(importer))})`
              );
            } else if (isProduction) {
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
      if (id.startsWith(browserExternalId)) {
        if (isProduction) {
          return `export default {}`;
        } else {
          id = id.slice(browserExternalId.length + 1);
          return `\
export default new Proxy({}, {
  get(_, key) {
    throw new Error(\`Module "${id}" has been externalized for browser compatibility. Cannot access "${id}.\${key}" in client code.  See https://vitejs.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.\`)
  }
})`;
        }
      }
      if (id.startsWith(optionalPeerDepId)) {
        if (isProduction) {
          return `export default {}`;
        } else {
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
 * @param id
 * @param param1
 * @param targetWeb
 * @param options
 * @returns
 */
function resolveDeepImport(
  id: string,
  {
    webResolvedImports,
    setResolvedCache,
    getResolvedCache,
    dir,
    data,
  }: PackageData,
  targetWeb: boolean,
  options: InternalResolveOptions
): string | undefined {
  const cache = getResolvedCache(id, targetWeb);
  if (cache) {
    return cache;
  }

  let relativeId: string | undefined | void = id;
  const { exports: exportsField, browser: browserField } = data;

  // map relative based on exports data
  if (exportsField) {
    if (isObject(exportsField) && !Array.isArray(exportsField)) {
      // resolve without postfix (see #7098)
      const { file, postfix } = splitFileAndPostfix(relativeId);
      const exportsId = resolveExportsOrImports(
        data,
        file,
        options,
        targetWeb,
        "exports"
      );
      if (exportsId !== undefined) {
        relativeId = exportsId + postfix;
      } else {
        relativeId = undefined;
      }
    } else {
      // not exposed
      relativeId = undefined;
    }
    if (!relativeId) {
      throw new Error(
        `Package subpath '${relativeId}' is not defined by "exports" in ` +
          `${path.join(dir, "package.json")}.`
      );
    }
  } else if (
    targetWeb &&
    options.mainFields.includes("browser") &&
    isObject(browserField)
  ) {
    // resolve without postfix (see #7098)
    const { file, postfix } = splitFileAndPostfix(relativeId);
    const mapped = mapWithBrowserField(file, browserField);
    if (mapped) {
      relativeId = mapped + postfix;
    } else if (mapped === false) {
      return (webResolvedImports[id] = browserExternalId);
    }
  }

  if (relativeId) {
    const resolved = tryFsResolve(
      path.join(dir, relativeId),
      options,
      !exportsField, // try index only if no exports field
      targetWeb
    );
    if (resolved) {
      debug?.(
        `[node/deep-import] ${colors.cyan(id)} -> ${colors.dim(resolved)}`
      );
      setResolvedCache(id, resolved, targetWeb);
      return resolved;
    }
  }
}

export function resolvePackageEntry(
  id: string,
  { dir, data, setResolvedCache, getResolvedCache }: PackageData,
  targetWeb: boolean,
  options: InternalResolveOptions
): string | undefined {
  const { file: idWithoutPostfix, postfix } = splitFileAndPostfix(id);

  const cached = getResolvedCache(".", targetWeb);
  if (cached) {
    return cached + postfix;
  }

  try {
    let entryPoint: string | undefined;

    // resolve exports field with highest priority
    // using https://github.com/lukeed/resolve.exports
    if (data.exports) {
      entryPoint = resolveExportsOrImports(
        data,
        ".",
        options,
        targetWeb,
        "exports"
      );
    }

    // fallback to mainFields if still not resolved
    if (!entryPoint) {
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
    entryPoint ||= data.main;

    // try default entry when entry is not define
    // https://nodejs.org/api/modules.html#all-together
    const entryPoints = entryPoint
      ? [entryPoint]
      : ["index.js", "index.json", "index.node"];

    for (let entry of entryPoints) {
      // make sure we don't get scripts when looking for sass
      let skipPackageJson = false;
      if (
        options.mainFields[0] === "sass" &&
        !options.extensions.includes(path.extname(entry))
      ) {
        entry = "";
        skipPackageJson = true;
      } else {
        // resolve object browser field in package.json
        const { browser: browserField } = data;
        if (
          targetWeb &&
          options.mainFields.includes("browser") &&
          isObject(browserField)
        ) {
          entry = mapWithBrowserField(entry, browserField) || entry;
        }
      }

      const entryPointPath = path.join(dir, entry);
      const resolvedEntryPoint = tryFsResolve(
        entryPointPath,
        options,
        true,
        true,
        skipPackageJson
      );
      if (resolvedEntryPoint) {
        debug?.(
          `[package entry] ${colors.cyan(idWithoutPostfix)} -> ${colors.dim(
            resolvedEntryPoint
          )}${postfix !== "" ? ` (postfix: ${postfix})` : ""}`
        );
        setResolvedCache(".", resolvedEntryPoint, targetWeb);
        return resolvedEntryPoint + postfix;
      }
    }
  } catch (e) {
    packageEntryFailure(id, e.message);
  }
  packageEntryFailure(id);
}
