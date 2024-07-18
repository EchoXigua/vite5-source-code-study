import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import glob from "fast-glob";
import type {
  BuildContext,
  Loader,
  OnLoadArgs,
  OnLoadResult,
  Plugin,
} from "esbuild";
import esbuild, { formatMessages, transform } from "esbuild";
import colors from "picocolors";
import type { ResolvedConfig } from "..";
import {
  CSS_LANGS_RE,
  JS_TYPES_RE,
  KNOWN_ASSET_TYPES,
  SPECIAL_QUERY_RE,
} from "../constants";
import {
  arraify,
  createDebugger,
  dataUrlRE,
  externalRE,
  isInNodeModules,
  isObject,
  isOptimizable,
  moduleListContains,
  multilineCommentsRE,
  normalizePath,
  singlelineCommentsRE,
  virtualModulePrefix,
  virtualModuleRE,
} from "../utils";
import type { PluginContainer } from "../server/pluginContainer";
import { createPluginContainer } from "../server/pluginContainer";
import { transformGlobImport } from "../plugins/importMetaGlob";
import { cleanUrl } from "../../shared/utils";
import { loadTsconfigJsonForFile } from "../plugins/esbuild";

type ResolveIdOptions = Parameters<PluginContainer["resolveId"]>[2];

const debug = createDebugger("vite:deps");

const htmlTypesRE = /\.(html|vue|svelte|astro|imba)$/;

// A simple regex to detect import sources. This is only used on
// <script lang="ts"> blocks in vue (setup only) or svelte files, since
// seemingly unused imports are dropped by esbuild when transpiling TS which
// prevents it from crawling further.
// We can't use es-module-lexer because it can't handle TS, and don't want to
// use Acorn because it's slow. Luckily this doesn't have to be bullet proof
// since even missed imports can be caught at runtime, and false positives will
// simply be ignored.
export const importsRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)(?:[\w*{}\n\r\t, ]+from)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm;

/**
 * 这个函数主要就是用来扫描依赖
 * @param config
 * @returns 返回一个对象,其中包含 cancel 和 result 两个属性
 */
export function scanImports(config: ResolvedConfig): {
  cancel: () => Promise<void>;
  result: Promise<{
    deps: Record<string, string>;
    missing: Record<string, string>;
  }>;
} {
  // Only used to scan non-ssr code

  // 获取函数开始执行的时间，用于计算执行时间
  const start = performance.now();
  /**记录依赖的对象 */
  const deps: Record<string, string> = {};
  /**记录缺失依赖的对象 */
  const missing: Record<string, string> = {};
  /**存储计算后的入口点 */
  let entries: string[];

  /** 用来跟踪是否取消了扫描操作 */
  const scanContext = { cancelled: false };

  // esbuild 上下文,处理如何计算入口点并准备使用 esbuild 扫描器
  const esbuildContext: Promise<BuildContext | undefined> = computeEntries(
    config
  ).then((computedEntries) => {
    entries = computedEntries;

    // 如果没有找到任何入口点
    if (!entries.length) {
      // 检查是否配置了 optimizeDeps.entries 或 optimizeDeps.include
      if (!config.optimizeDeps.entries && !config.optimizeDeps.include) {
        // 发出警告日志，说明未能自动确定入口点
        config.logger.warn(
          colors.yellow(
            "(!) Could not auto-determine entry point from rollupOptions or html files " +
              "and there are no explicit optimizeDeps.include patterns. " +
              "Skipping dependency pre-bundling."
          )
        );
      }
      // 返回空值，不执行后续操作
      return;
    }
    // 如果扫描已取消，直接返回
    if (scanContext.cancelled) return;

    // 输出调试信息，显示正在使用的入口点
    debug?.(
      `Crawling dependencies using entries: ${entries
        .map((entry) => `\n  ${colors.dim(entry)}`)
        .join("")}`
    );
    // 准备使用 esbuild 扫描器，并返回相应的上下文
    return prepareEsbuildScanner(config, entries, deps, missing, scanContext);
  });

  const result = esbuildContext
    .then((context) => {
      /**
       * 这个函数用来释放 context，防止资源泄漏，同时处理可能发生的错误
       * @returns
       */
      function disposeContext() {
        return context?.dispose().catch((e) => {
          // 处理释放上下文时的错误
          config.logger.error("Failed to dispose esbuild context", {
            error: e,
          });
        });
      }

      // 如果上下文不存在或者扫描已取消，则释放上下文并返回空结果
      if (!context || scanContext?.cancelled) {
        disposeContext();
        return { deps: {}, missing: {} };
      }

      // 重新构建
      return context
        .rebuild()
        .then(() => {
          // 返回扫描得到的依赖项 deps 和缺失项 missing
          return {
            // 确保一个固定的顺序，这样哈希是稳定的，并改善日志
            deps: orderedDependencies(deps),
            missing,
          };
        })
        .finally(() => {
          // 执行完成后,释放上下文
          return disposeContext();
        });
    })
    .catch(async (e) => {
      // 处理异常情况
      if (e.errors && e.message.includes("The build was canceled")) {
        // esbuild 在取消时会记录一个错误，但这是预期的，因此返回空结果
        return { deps: {}, missing: {} };
      }

      // 用于指示扫描依赖失败，并列出相关的入口
      const prependMessage = colors.red(`\
  Failed to scan for dependencies from entries:
  ${entries.join("\n")}

  `);

      if (e.errors) {
        // 将错误信息格式化为带颜色的消息数组 msgs
        const msgs = await formatMessages(e.errors, {
          kind: "error",
          color: true,
        });
        // 拼接成完整的错误信息
        e.message = prependMessage + msgs.join("\n");
      } else {
        // 没有 errors 属性,直接拼接
        e.message = prependMessage + e.message;
      }
      throw e;
    })
    .finally(() => {
      // 最终清理和日志记录:

      if (debug) {
        // 计算并输出扫描的持续时间
        const duration = (performance.now() - start).toFixed(2);
        const depsStr =
          // 获取按顺序排列的依赖项 deps
          Object.keys(orderedDependencies(deps))
            .sort()
            .map((id) => `\n  ${colors.cyan(id)} -> ${colors.dim(deps[id])}`)
            .join("") || colors.dim("no dependencies found");

        // 输出扫描完成的日志信息，包括扫描时间和依赖项信息
        debug(`Scan completed in ${duration}ms: ${depsStr}`);
      }
    });

  return {
    cancel: async () => {
      scanContext.cancelled = true;
      return esbuildContext.then((context) => context?.cancel());
    },
    result,
  };
}

async function computeEntries(config: ResolvedConfig) {
  let entries: string[] = [];

  const explicitEntryPatterns = config.optimizeDeps.entries;
  const buildInput = config.build.rollupOptions?.input;

  if (explicitEntryPatterns) {
    entries = await globEntries(explicitEntryPatterns, config);
  } else if (buildInput) {
    const resolvePath = (p: string) => path.resolve(config.root, p);
    if (typeof buildInput === "string") {
      entries = [resolvePath(buildInput)];
    } else if (Array.isArray(buildInput)) {
      entries = buildInput.map(resolvePath);
    } else if (isObject(buildInput)) {
      entries = Object.values(buildInput).map(resolvePath);
    } else {
      throw new Error("invalid rollupOptions.input value.");
    }
  } else {
    entries = await globEntries("**/*.html", config);
  }

  // Non-supported entry file types and virtual files should not be scanned for
  // dependencies.
  entries = entries.filter(
    (entry) =>
      isScannable(entry, config.optimizeDeps.extensions) && fs.existsSync(entry)
  );

  return entries;
}

/**
 * 这个函数用于准备使用 esbuild 进行扫描的上下文对象
 * @param config
 * @param entries 要扫描的入口
 * @param deps 记录依赖项的对象
 * @param missing 记录缺失依赖项的对象
 * @param scanContext 用于跟踪扫描操作是否被取消
 * @returns
 */
async function prepareEsbuildScanner(
  config: ResolvedConfig,
  entries: string[],
  deps: Record<string, string>,
  missing: Record<string, string>,
  scanContext?: { cancelled: boolean }
): Promise<BuildContext | undefined> {
  /**创建一个插件容器 container，用于管理插件和配置 */
  const container = await createPluginContainer(config);

  // 如果扫描取消,则直接返回
  if (scanContext?.cancelled) return;

  // 创建一个 esbuild 插件 plugin，用于实际执行依赖扫描
  const plugin = esbuildScanPlugin(config, container, deps, missing, entries);

  // 从用户配置中获取依赖优化的 esbuild配置插件和 其他配置选项,最终会和默认的合并在一起
  const { plugins = [], ...esbuildOptions } =
    config.optimizeDeps?.esbuildOptions ?? {};

  // The plugin pipeline automatically loads the closest tsconfig.json.
  // But esbuild doesn't support reading tsconfig.json if the plugin has resolved the path (https://github.com/evanw/esbuild/issues/2265).
  // Due to syntax incompatibilities between the experimental decorators in TypeScript and TC39 decorators,
  // we cannot simply set `"experimentalDecorators": true` or `false`. (https://github.com/vitejs/vite/pull/15206#discussion_r1417414715)
  // Therefore, we use the closest tsconfig.json from the root to make it work in most cases.
  /**
   * 这里解释了为什么在 prepareEsbuildScanner 函数中需要手动加载最接近根目录的 tsconfig.json 文件
   * 而不依赖 esbuild 自动加载的功能
   *
   * 1. 自动加载最近的 tsconfig.json:
   * esbuild 默认会自动加载最近的 tsconfig.json 文件来配置 TypeScript 的编译选项
   * 这意味着如果项目中存在多个 tsconfig.json 文件，esbuild 会使用离入口点最近的那个文件
   *
   * 2. 问题与限制:
   *    1）路径解析问题: 当插件解析了路径后，esbuild 无法正确读取 tsconfig.json。这是因为 esbuild 不会考虑插件解析后的路径
   *    2）TypeScript 中的实验性装饰器语法与 TC39 的装饰器存在语法不兼容的问题
   *    因此，简单地设置 "experimentalDecorators": true 或 false 并不总是有效的解决方案
   *
   * 3. 解决方案:
   * 为了解决路径解析问题和实验性装饰器的语法兼容性，Vite 在大多数情况下使用距离项目根目录最近的 tsconfig.json
   * 这样可以确保 esbuild 在大多数情况下都能够正确地配置 TypeScript 编译选项，并且能够处理实验性装饰器的语法问题
   */

  let tsconfigRaw = esbuildOptions.tsconfigRaw;
  // 如果未提供 tsconfigRaw 或 esbuildOptions.tsconfig
  if (!tsconfigRaw && !esbuildOptions.tsconfig) {
    // 加载最接近根目录的 tsconfig.json 文件
    const tsconfigResult = await loadTsconfigJsonForFile(
      path.join(config.root, "_dummy.js")
    );

    // 根据其配置设置 tsconfigRaw, experimentalDecorators (实验性装饰器)
    if (tsconfigResult.compilerOptions?.experimentalDecorators) {
      tsconfigRaw = { compilerOptions: { experimentalDecorators: true } };
    }
  }

  return await esbuild.context({
    // 设置为当前工作目录
    absWorkingDir: process.cwd(),
    // 设置为 false，表示不写入输出文件
    write: false,
    // 包含了以 entries 为基础的导入语句
    stdin: {
      contents: entries.map((e) => `import ${JSON.stringify(e)}`).join("\n"),
      loader: "js",
    },
    bundle: true, //表示要打包输出
    format: "esm",
    logLevel: "silent", // 设置为 "silent"，表示日志级别为静默，不输出日志
    plugins: [...plugins, plugin], //包括了之前创建的 plugin 和从用户配置中获取的其他插件
    ...esbuildOptions, // 合并用户的esbuild 配置
    tsconfigRaw,
  });
}

/**
 * 这个函数用于对给定的依赖项对象 deps 进行排序，并返回排序后的对象
 * @param deps
 * @returns
 */
function orderedDependencies(deps: Record<string, string>) {
  // 将依赖项对象转换为键值对数组
  const depsList = Object.entries(deps);
  // 确保对同一组依赖项使用相同的browserHash

  // 按照键名进行字母顺序排序
  // localeCompare 方法可以确保按照当前地区的语言顺序进行比较，因此在不同语言环境下都能得到正确的排序结果
  depsList.sort((a, b) => a[0].localeCompare(b[0]));

  // 将排序后的数组转换回对象格式
  return Object.fromEntries(depsList);
}

function globEntries(pattern: string | string[], config: ResolvedConfig) {
  const resolvedPatterns = arraify(pattern);
  if (resolvedPatterns.every((str) => !glob.isDynamicPattern(str))) {
    return resolvedPatterns.map((p) =>
      normalizePath(path.resolve(config.root, p))
    );
  }
  return glob(pattern, {
    cwd: config.root,
    ignore: [
      "**/node_modules/**",
      `**/${config.build.outDir}/**`,
      // if there aren't explicit entries, also ignore other common folders
      ...(config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`]),
    ],
    absolute: true,
    suppressErrors: true, // suppress EACCES errors
  });
}

export const scriptRE =
  /(<script(?:\s+[a-z_:][-\w:]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^"'<>=\s]+))?)*\s*>)(.*?)<\/script>/gis;
export const commentRE = /<!--.*?-->/gs;
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i;
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i;
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i;
const contextRE = /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i;

function esbuildScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[]
): Plugin {
  const seen = new Map<string, string | undefined>();

  const resolve = async (
    id: string,
    importer?: string,
    options?: ResolveIdOptions
  ) => {
    const key = id + (importer && path.dirname(importer));
    if (seen.has(key)) {
      return seen.get(key);
    }
    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer),
      {
        ...options,
        scan: true,
      }
    );
    const res = resolved?.id;
    seen.set(key, res);
    return res;
  };

  const include = config.optimizeDeps?.include;
  const exclude = [
    ...(config.optimizeDeps?.exclude || []),
    "@vite/client",
    "@vite/env",
  ];

  const isUnlessEntry = (path: string) => !entries.includes(path);

  const externalUnlessEntry = ({ path }: { path: string }) => ({
    path,
    external: isUnlessEntry(path),
  });

  const doTransformGlobImport = async (
    contents: string,
    id: string,
    loader: Loader
  ) => {
    let transpiledContents;
    // transpile because `transformGlobImport` only expects js
    if (loader !== "js") {
      transpiledContents = (await transform(contents, { loader })).code;
    } else {
      transpiledContents = contents;
    }

    const result = await transformGlobImport(
      transpiledContents,
      id,
      config.root,
      resolve
    );

    return result?.s.toString() || transpiledContents;
  };

  return {
    name: "vite:dep-scan",
    setup(build) {
      const scripts: Record<string, OnLoadResult> = {};

      // external urls
      build.onResolve({ filter: externalRE }, ({ path }) => ({
        path,
        external: true,
      }));

      // data urls
      build.onResolve({ filter: dataUrlRE }, ({ path }) => ({
        path,
        external: true,
      }));

      // local scripts (`<script>` in Svelte and `<script setup>` in Vue)
      build.onResolve({ filter: virtualModuleRE }, ({ path }) => {
        return {
          // strip prefix to get valid filesystem path so esbuild can resolve imports in the file
          path: path.replace(virtualModulePrefix, ""),
          namespace: "script",
        };
      });

      build.onLoad({ filter: /.*/, namespace: "script" }, ({ path }) => {
        return scripts[path];
      });

      // html types: extract script contents -----------------------------------
      build.onResolve({ filter: htmlTypesRE }, async ({ path, importer }) => {
        const resolved = await resolve(path, importer);
        if (!resolved) return;
        // It is possible for the scanner to scan html types in node_modules.
        // If we can optimize this html type, skip it so it's handled by the
        // bare import resolve, and recorded as optimization dep.
        if (
          isInNodeModules(resolved) &&
          isOptimizable(resolved, config.optimizeDeps)
        )
          return;
        return {
          path: resolved,
          namespace: "html",
        };
      });

      const htmlTypeOnLoadCallback: (
        args: OnLoadArgs
      ) => Promise<OnLoadResult | null | undefined> = async ({ path: p }) => {
        let raw = await fsp.readFile(p, "utf-8");
        // Avoid matching the content of the comment
        raw = raw.replace(commentRE, "<!---->");
        const isHtml = p.endsWith(".html");
        let js = "";
        let scriptId = 0;
        const matches = raw.matchAll(scriptRE);
        for (const [, openTag, content] of matches) {
          const typeMatch = openTag.match(typeRE);
          const type =
            typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3]);
          const langMatch = openTag.match(langRE);
          const lang =
            langMatch && (langMatch[1] || langMatch[2] || langMatch[3]);
          // skip non type module script
          if (isHtml && type !== "module") {
            continue;
          }
          // skip type="application/ld+json" and other non-JS types
          if (
            type &&
            !(
              type.includes("javascript") ||
              type.includes("ecmascript") ||
              type === "module"
            )
          ) {
            continue;
          }
          let loader: Loader = "js";
          if (lang === "ts" || lang === "tsx" || lang === "jsx") {
            loader = lang;
          } else if (p.endsWith(".astro")) {
            loader = "ts";
          }
          const srcMatch = openTag.match(srcRE);
          if (srcMatch) {
            const src = srcMatch[1] || srcMatch[2] || srcMatch[3];
            js += `import ${JSON.stringify(src)}\n`;
          } else if (content.trim()) {
            // The reason why virtual modules are needed:
            // 1. There can be module scripts (`<script context="module">` in Svelte and `<script>` in Vue)
            // or local scripts (`<script>` in Svelte and `<script setup>` in Vue)
            // 2. There can be multiple module scripts in html
            // We need to handle these separately in case variable names are reused between them

            // append imports in TS to prevent esbuild from removing them
            // since they may be used in the template
            const contents =
              content +
              (loader.startsWith("ts") ? extractImportPaths(content) : "");

            const key = `${p}?id=${scriptId++}`;
            if (contents.includes("import.meta.glob")) {
              scripts[key] = {
                loader: "js", // since it is transpiled
                contents: await doTransformGlobImport(contents, p, loader),
                resolveDir: normalizePath(path.dirname(p)),
                pluginData: {
                  htmlType: { loader },
                },
              };
            } else {
              scripts[key] = {
                loader,
                contents,
                resolveDir: normalizePath(path.dirname(p)),
                pluginData: {
                  htmlType: { loader },
                },
              };
            }

            const virtualModulePath = JSON.stringify(virtualModulePrefix + key);

            const contextMatch = openTag.match(contextRE);
            const context =
              contextMatch &&
              (contextMatch[1] || contextMatch[2] || contextMatch[3]);

            // Especially for Svelte files, exports in <script context="module"> means module exports,
            // exports in <script> means component props. To avoid having two same export name from the
            // star exports, we need to ignore exports in <script>
            if (p.endsWith(".svelte") && context !== "module") {
              js += `import ${virtualModulePath}\n`;
            } else {
              js += `export * from ${virtualModulePath}\n`;
            }
          }
        }

        // This will trigger incorrectly if `export default` is contained
        // anywhere in a string. Svelte and Astro files can't have
        // `export default` as code so we know if it's encountered it's a
        // false positive (e.g. contained in a string)
        if (!p.endsWith(".vue") || !js.includes("export default")) {
          js += "\nexport default {}";
        }

        return {
          loader: "js",
          contents: js,
        };
      };

      // extract scripts inside HTML-like files and treat it as a js module
      build.onLoad(
        { filter: htmlTypesRE, namespace: "html" },
        htmlTypeOnLoadCallback
      );
      // the onResolve above will use namespace=html but esbuild doesn't
      // call onResolve for glob imports and those will use namespace=file
      // https://github.com/evanw/esbuild/issues/3317
      build.onLoad(
        { filter: htmlTypesRE, namespace: "file" },
        htmlTypeOnLoadCallback
      );

      // bare imports: record and externalize ----------------------------------
      build.onResolve(
        {
          // avoid matching windows volume
          filter: /^[\w@][^:]/,
        },
        async ({ path: id, importer, pluginData }) => {
          if (moduleListContains(exclude, id)) {
            return externalUnlessEntry({ path: id });
          }
          if (depImports[id]) {
            return externalUnlessEntry({ path: id });
          }
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          });
          if (resolved) {
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id });
            }
            if (isInNodeModules(resolved) || include?.includes(id)) {
              // dependency or forced included, externalize and stop crawling
              if (isOptimizable(resolved, config.optimizeDeps)) {
                depImports[id] = resolved;
              }
              return externalUnlessEntry({ path: id });
            } else if (isScannable(resolved, config.optimizeDeps.extensions)) {
              const namespace = htmlTypesRE.test(resolved) ? "html" : undefined;
              // linked package, keep crawling
              return {
                path: path.resolve(resolved),
                namespace,
              };
            } else {
              return externalUnlessEntry({ path: id });
            }
          } else {
            missing[id] = normalizePath(importer);
          }
        }
      );

      // Externalized file types -----------------------------------------------
      // these are done on raw ids using esbuild's native regex filter so it
      // should be faster than doing it in the catch-all via js
      // they are done after the bare import resolve because a package name
      // may end with these extensions
      const setupExternalize = (
        filter: RegExp,
        doExternalize: (path: string) => boolean
      ) => {
        build.onResolve({ filter }, ({ path }) => {
          return {
            path,
            external: doExternalize(path),
          };
        });
      };

      // css
      setupExternalize(CSS_LANGS_RE, isUnlessEntry);
      // json & wasm
      setupExternalize(/\.(json|json5|wasm)$/, isUnlessEntry);
      // known asset types
      setupExternalize(
        new RegExp(`\\.(${KNOWN_ASSET_TYPES.join("|")})$`),
        isUnlessEntry
      );
      // known vite query types: ?worker, ?raw
      setupExternalize(SPECIAL_QUERY_RE, () => true);

      // catch all -------------------------------------------------------------

      build.onResolve(
        {
          filter: /.*/,
        },
        async ({ path: id, importer, pluginData }) => {
          // use vite resolver to support urls and omitted extensions
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          });
          if (resolved) {
            if (
              shouldExternalizeDep(resolved, id) ||
              !isScannable(resolved, config.optimizeDeps.extensions)
            ) {
              return externalUnlessEntry({ path: id });
            }

            const namespace = htmlTypesRE.test(resolved) ? "html" : undefined;

            return {
              path: path.resolve(cleanUrl(resolved)),
              namespace,
            };
          } else {
            // resolve failed... probably unsupported type
            return externalUnlessEntry({ path: id });
          }
        }
      );

      // for jsx/tsx, we need to access the content and check for
      // presence of import.meta.glob, since it results in import relationships
      // but isn't crawled by esbuild.
      build.onLoad({ filter: JS_TYPES_RE }, async ({ path: id }) => {
        let ext = path.extname(id).slice(1);
        if (ext === "mjs") ext = "js";

        let contents = await fsp.readFile(id, "utf-8");
        if (ext.endsWith("x") && config.esbuild && config.esbuild.jsxInject) {
          contents = config.esbuild.jsxInject + `\n` + contents;
        }

        const loader =
          config.optimizeDeps?.esbuildOptions?.loader?.[`.${ext}`] ||
          (ext as Loader);

        if (contents.includes("import.meta.glob")) {
          return {
            loader: "js", // since it is transpiled,
            contents: await doTransformGlobImport(contents, id, loader),
          };
        }

        return {
          loader,
          contents,
        };
      });

      // onResolve is not called for glob imports.
      // we need to add that here as well until esbuild calls onResolve for glob imports.
      // https://github.com/evanw/esbuild/issues/3317
      build.onLoad({ filter: /.*/, namespace: "file" }, () => {
        return {
          loader: "js",
          contents: "export default {}",
        };
      });
    },
  };
}

/**
 * when using TS + (Vue + `<script setup>`) or Svelte, imports may seem
 * unused to esbuild and dropped in the build output, which prevents
 * esbuild from crawling further.
 * the solution is to add `import 'x'` for every source to force
 * esbuild to keep crawling due to potential side effects.
 */
function extractImportPaths(code: string) {
  // empty singleline & multiline comments to avoid matching comments
  code = code
    .replace(multilineCommentsRE, "/* */")
    .replace(singlelineCommentsRE, "");

  let js = "";
  let m;
  importsRE.lastIndex = 0;
  while ((m = importsRE.exec(code)) != null) {
    js += `\nimport ${m[1]}`;
  }
  return js;
}

function shouldExternalizeDep(resolvedId: string, rawId: string): boolean {
  // not a valid file path
  if (!path.isAbsolute(resolvedId)) {
    return true;
  }
  // virtual id
  if (resolvedId === rawId || resolvedId.includes("\0")) {
    return true;
  }
  return false;
}

function isScannable(id: string, extensions: string[] | undefined): boolean {
  return (
    JS_TYPES_RE.test(id) ||
    htmlTypesRE.test(id) ||
    extensions?.includes(path.extname(id)) ||
    false
  );
}
