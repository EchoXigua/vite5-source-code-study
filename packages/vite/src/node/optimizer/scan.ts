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

/**匹配 .html、.vue、.svelet、.astro、.imba */
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
  // 仅用于扫描非ssr代码

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

/**
 * 这个函数用于根据配置计算项目中的入口文件
 * 读取 Vite 配置中的 optimizeDeps.entries 和 build.rollupOptions.input 来确定入口文件
 * @param config
 * @returns
 * 
 * @example
 * const config = {
    root: "/project/root",
    optimizeDeps: {
      entries: ["src/main.js", "src/app.js"]
    },
    build: {
      rollupOptions: {
        input: {
          main: "index.html",
          admin: "admin.html"
        }
      }
    }
  };

  最终得到：
  [
    "/project/root/src/main.js",
    "/project/root/src/app.js",
    "/project/root/index.html",
    "/project/root/admin.html"
  ]
 */
async function computeEntries(config: ResolvedConfig) {
  /** 用于存储找到的入口文件路径 */
  let entries: string[] = [];

  // 获取的显式入口文件(用户提供的)
  const explicitEntryPatterns = config.optimizeDeps.entries;
  //  获取的构建输入配置
  const buildInput = config.build.rollupOptions?.input;

  if (explicitEntryPatterns) {
    // 使用 globEntries 函数根据模式解析入口文件
    entries = await globEntries(explicitEntryPatterns, config);
  } else if (buildInput) {
    // 根据配置类型（字符串、数组或对象）解析入口文件路径
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
    // 如果都不存在，则使用 globEntries 函数查找所有 HTML 文件 **/*.html 作为入口文件
    entries = await globEntries("**/*.html", config);
  }

  // 不支持的条目文件类型和虚拟文件不应该扫描依赖项。
  entries = entries.filter(
    (entry) =>
      // 使用 isScannable 函数过滤掉不支持扫描的入口文件类型
      // 使用 fs.existsSync 函数过滤掉不存在的文件路径
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

/**
 * 这个函数的作用是根据给定的模式（pattern）和配置（config）查找并返回符合条件的文件路径
 * @param pattern
 * @param config
 * @returns
 */
function globEntries(pattern: string | string[], config: ResolvedConfig) {
  //  将 pattern 转换为数组（如果不是数组的话）
  const resolvedPatterns = arraify(pattern);
  // 检查每个模式是否都不是动态模式（即不包含通配符，如 *、? 等）。
  if (resolvedPatterns.every((str) => !glob.isDynamicPattern(str))) {
    // 如果所有模式都不是动态模式，则将每个模式转换为绝对路径，并标准化路径格式，然后返回这些路径
    return resolvedPatterns.map((p) =>
      normalizePath(path.resolve(config.root, p))
    );
  }

  // 如果包含动态模式，则使用 glob 库进行文件查找
  return glob(pattern, {
    cwd: config.root, //设置工作目录为项目根目录
    //  指定要忽略的路径模式
    ignore: [
      "**/node_modules/**",
      `**/${config.build.outDir}/**`,
      // if there aren't explicit entries, also ignore other common folders
      ...(config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`]),
    ],
    absolute: true, //返回绝对路径
    suppressErrors: true, //  抑制错误（如 EACCES 权限错误）
  });
}

/**
 * 匹配 HTML 文件中的 <script> 标签及其内容
 *
 * <script(?:\s+[a-z_:][-\w:]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^"'<>=\s]+))?)*\s*>
 * 匹配 <script> 标签的开头部分，可以包含各种属性
 * (?:\s+[a-z_:][-\w:]*)  匹配标签中的属性名称
 * (?:\s*=\s*(?:"[^"]*"|'[^']*'|[^"'<>=\s]+))?  匹配属性的值（可能用引号括起来，也可能不括起来）
 *
 *
 * (.*?) 非贪婪地匹配 <script> 标签内的内容
 * <\/script>: 匹配 </script> 标签的结尾
 *
 * g: 全局匹配。
 * i: 忽略大小写。
 * s: 使点号 . 匹配换行符。
 */
export const scriptRE =
  /(<script(?:\s+[a-z_:][-\w:]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^"'<>=\s]+))?)*\s*>)(.*?)<\/script>/gis;

/**
 * 匹配 HTML 注释
 * <!-- 匹配注释的开始部分
 * .*? 非贪婪地匹配注释内容
 * --> 匹配注释的结束部分
 */
export const commentRE = /<!--.*?-->/gs;

/**
 * 匹配 <script> 标签中的 src 属性
 *
 * \bsrc\s*=\s*   匹配 src= 属性名，前后允许有空格
 * (?:"([^"]+)"|'([^']+)'|([^\s'">]+))  匹配 src 属性的值，可以是用引号括起来的字符串，也可以是不带引号的值
 */
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i;
/**匹配 <script> 标签中的 type 属性 */
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i;
/**匹配 <script> 标签中的 lang 属性 */
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i;
/**匹配 <script> 标签中的 context 属性 */
const contextRE = /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i;

/**
 * 这个函数用于创建一个 esbuild 插件，用于依赖项的扫描和处理
 * @param config
 * @param container 插件容器对象，用于管理和执行各种插件功能
 * @param depImports 记录了依赖项导入路径的对象
 * @param missing 记录了未能解析的依赖项的对象
 * @param entries 包含入口文件路径的字符串数组
 * @returns
 */
function esbuildScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[]
): Plugin {
  /**用于缓存已解析过的模块路径 */
  const seen = new Map<string, string | undefined>();

  /**
   * 用于解析给定的模块标识符，在函数内部，通过 container.resolveId 方法尝试解析模块路径
   *
   * @param id  要解析的模块标识符
   * @param importer 导入者的路径，用于确定模块的相对路径
   * @param options 解析选项，包括扫描 (scan) 选项
   * @returns
   */
  const resolve = async (
    id: string,
    importer?: string,
    options?: ResolveIdOptions
  ) => {
    const key = id + (importer && path.dirname(importer));
    // 如果已经在 seen 中缓存了相同的 key（由 id 和 importer 组成），则直接返回缓存的结果
    if (seen.has(key)) {
      return seen.get(key);
    }
    // 使用 container.resolveId 方法解析模块路径，并将结果存入 seen 中，以便下次快速访问
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

  /**包含需要优化的模块的数组 */
  const include = config.optimizeDeps?.include;
  /**排除不需要优化的模块的数组 */
  const exclude = [
    // 通常包括一些用户配置提供的依赖或特定的 Vite 插件
    ...(config.optimizeDeps?.exclude || []),
    "@vite/client",
    "@vite/env",
  ];

  /**判断给定路径是否不是入口文件路径 */
  const isUnlessEntry = (path: string) => !entries.includes(path);

  /**根据 isUnlessEntry 函数的返回值确定某个路径是否应该被标记为外部依赖项 */
  const externalUnlessEntry = ({ path }: { path: string }) => ({
    path,
    external: isUnlessEntry(path),
  });

  /**
   * 当我们处理包含 glob 导入的内容时，有时候需要确保这些内容能被正确地处理和转义，
   * 特别是当这些内容不是纯粹的 JavaScript 代码时
   *
   * @param contents
   * @param id
   * @param loader
   * @returns
   */
  const doTransformGlobImport = async (
    contents: string,
    id: string,
    loader: Loader
  ) => {
    let transpiledContents;
    // transformGlobImport 只接受 JavaScript 代码
    if (loader !== "js") {
      // 如果不是 'js' 类型，说明内容可能包含其他语言（如 TypeScript、JSX 等）
      // 需要先通过 transform 函数对内容进行转译成纯 JavaScript
      transpiledContents = (await transform(contents, { loader })).code;
    } else {
      transpiledContents = contents;
    }

    //
    const result = await transformGlobImport(
      transpiledContents,
      id,
      config.root,
      resolve
    );

    return result?.s.toString() || transpiledContents;
  };

  // 这个插件的主要目的是通过集成 esbuild 进行依赖扫描
  return {
    name: "vite:dep-scan",
    setup(build) {
      // 用于存储本地脚本的映射
      const scripts: Record<string, OnLoadResult> = {};

      /**
       * esbuild 的几个钩子函数：
       * 1. onResolve 钩子函数用于自定义模块解析逻辑。
       * 当 ESBuild 遇到一个需要解析的模块时，它会调用所有匹配的 onResolve 钩子
       * build.onResolve(options, callback);
       * options: 一个对象，可以包含 filter（用于匹配文件路径的正则表达式）和 namespace
       * callback: 一个异步函数，接收一个包含 path 和 importer 等信息的对象，返回一个解析结果对象。
       *
       * 2. onLoad 钩子函数用于自定义模块加载逻辑。
       * 当 ESBuild 解析到一个模块路径后，它会调用所有匹配的 onLoad 钩子来加载该模块
       * build.onLoad(options, callback);
       *
       * 3. onStart 钩子函数在构建开始时调用，可以用于执行一些初始化逻辑。
       * build.onStart(callback);
       *
       * 4. onEnd 钩子函数在构建结束时调用，可以用于执行一些清理或总结逻辑
       * build.onEnd(callback);
       *
       * 5. onDispose 钩子函数在插件被清理时调用，可以用于释放资源
       * build.onDispose(callback);
       */

      // 处理外部 URL
      build.onResolve({ filter: externalRE }, ({ path }) => ({
        path,
        external: true,
      }));

      // 处理数据 URL
      build.onResolve({ filter: dataUrlRE }, ({ path }) => ({
        path,
        external: true,
      }));

      // 处理script标签（svelte 中的script 和 vue 中的 <script setup>
      build.onResolve({ filter: virtualModuleRE }, ({ path }) => {
        return {
          // 移除虚拟模块前缀，使 esbuild 可以解析文件系统中的导入
          path: path.replace(virtualModulePrefix, ""),
          namespace: "script",
        };
      });

      // 这个钩子函数负责在 namespace: "script" 命名空间中加载文件
      // filter: /.*/ 表示匹配所有文件
      build.onLoad({ filter: /.*/, namespace: "script" }, ({ path }) => {
        return scripts[path];
      });

      // html types: extract script contents -----------------------------------
      build.onResolve({ filter: htmlTypesRE }, async ({ path, importer }) => {
        // 使用 resolve 函数解析传入的路径 path 和导入者 importer
        const resolved = await resolve(path, importer);

        // 如果解析失败（!resolved），则不处理该路径
        if (!resolved) return;
        // It is possible for the scanner to scan html types in node_modules.
        // If we can optimize this html type, skip it so it's handled by the
        // bare import resolve, and recorded as optimization dep.
        /**
         * 扫描器可能会扫描 node_modules 目录中的 HTML 类型文件。
         * 如果我们能够优化这种 HTML 类型文件，那么就跳过它，这样它就可以由基础的导入解析处理，并被记录为优化依赖项
         */

        // 解析成功
        if (
          // 该文件在 node_modules 中并且可优化，则跳过处理
          isInNodeModules(resolved) &&
          isOptimizable(resolved, config.optimizeDeps)
        )
          return;

        // 返回一个对象，包含解析后的路径 path 和命名空间 namespace: "html"
        return {
          path: resolved,
          namespace: "html",
        };
      });

      /**
       * 用于处理 HTML 类型文件中的脚本内容，并将其转换为 JavaScript 代码
       * @param param0
       * @returns
       */
      const htmlTypeOnLoadCallback: (
        args: OnLoadArgs
      ) => Promise<OnLoadResult | null | undefined> = async ({ path: p }) => {
        // 读取文件内容
        let raw = await fsp.readFile(p, "utf-8");
        // 移除注释内容
        raw = raw.replace(commentRE, "<!---->");
        // 是否是html文件
        const isHtml = p.endsWith(".html");
        /**用于存储最终生成的 JavaScript 代码 */
        let js = "";
        /**用于为每个 <script> 标签生成唯一的 ID */
        let scriptId = 0;
        // 匹配所有 <script> 标签
        const matches = raw.matchAll(scriptRE);

        // 遍历处理每个script标签
        for (const [, openTag, content] of matches) {
          /**
           * openTag 是 <script> 标签的开始部分，例如 <script type="module">
           * content 是 <script> 标签中的内容
           */

          //  提取 type 属性
          const typeMatch = openTag.match(typeRE);
          const type =
            typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3]);
          // 提取 lang 属性
          const langMatch = openTag.match(langRE);
          const lang =
            langMatch && (langMatch[1] || langMatch[2] || langMatch[3]);
          // 跳过type 不是 moldule 的script
          if (isHtml && type !== "module") {
            continue;
          }
          // skip type="application/ld+json" and other non-JS types
          if (
            // 如果 type 存在但不包含 javascript、ecmascript 或 "module"，则跳过
            type &&
            !(
              type.includes("javascript") ||
              type.includes("ecmascript") ||
              type === "module"
            )
          ) {
            continue;
          }

          // 根据 lang 属性设置加载器，支持 ts、tsx、jsx
          let loader: Loader = "js";
          if (lang === "ts" || lang === "tsx" || lang === "jsx") {
            loader = lang;
          } else if (p.endsWith(".astro")) {
            loader = "ts";
          }

          // 处理 <script> 标签的 src 属性或内容
          const srcMatch = openTag.match(srcRE);
          if (srcMatch) {
            // 如果 <script> 标签有 src 属性，则生成一个导入语句 import 'src'
            const src = srcMatch[1] || srcMatch[2] || srcMatch[3];

            // 将生成的导入语句添加到 js 变量中
            js += `import ${JSON.stringify(src)}\n`;
          } else if (content.trim()) {
            // The reason why virtual modules are needed:
            // 1. There can be module scripts (`<script context="module">` in Svelte and `<script>` in Vue)
            // or local scripts (`<script>` in Svelte and `<script setup>` in Vue)
            // 2. There can be multiple module scripts in html
            // We need to handle these separately in case variable names are reused between them

            // append imports in TS to prevent esbuild from removing them
            // since they may be used in the template

            // 没有src 属性，处理 script 标签中的内容
            const contents =
              content +
              // 使用 extractImportPaths 函数提取 TypeScript 文件中的导入路径，并将这些路径附加到脚本内容中
              // 这是为了防止 esbuild 移除这些导入，因为它们可能在模板中使用
              (loader.startsWith("ts") ? extractImportPaths(content) : "");

            // 为每个脚本内容生成一个唯一的虚拟模块 key。
            const key = `${p}?id=${scriptId++}`;

            // 如果内容中包含 import.meta.glob，则通过 doTransformGlobImport 处理内容，并将结果存储在 scripts 对象中
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

            // 生成虚拟模块路径
            const virtualModulePath = JSON.stringify(virtualModulePrefix + key);

            // 匹配 <script> 标签中的 context 属性
            const contextMatch = openTag.match(contextRE);
            // 提取 context 属性的值
            const context =
              contextMatch &&
              (contextMatch[1] || contextMatch[2] || contextMatch[3]);

            // Especially for Svelte files, exports in <script context="module"> means module exports,
            // exports in <script> means component props. To avoid having two same export name from the
            // star exports, we need to ignore exports in <script>
            /**
             * 这段代码注释解释了处理 Svelte 文件时的特殊情况
             *
             * 1. Svelte 文件中的 <script context="module">：
             * 在 Svelte 文件中，<script context="module"> 用于定义模块级别的导出（module exports）
             * 这些导出是在模块层面上进行的，通常用于设置模块的属性和函数，供其他模块或文件使用
             *
             * 2. Svelte 文件中的 <script>：
             * 普通的 <script> 标签用于定义组件的属性和行为（component props），而不是模块级别的导出
             * 在这些标签内定义的导出仅适用于组件内部，并不暴露给其他模块
             *
             * 3. 避免重复导出：
             * 由于 Svelte 文件中的 <script context="module"> 和普通 <script> 标签可以有不同的导出逻辑，可能会导致导出名称重复的问题
             * 为了避免在虚拟模块导出过程中出现两个相同名称的导出（因为 <script context="module"> 和普通 <script> 都可以定义导出），
             * 需要忽略普通 <script> 标签中的导出。
             */
            if (p.endsWith(".svelte") && context !== "module") {
              js += `import ${virtualModulePath}\n`;
            } else {
              // 对于其他类型的文件，生成一个导出语句 export * from ${virtualModulePath}
              // 将虚拟模块的所有导出重新导出，以确保模块之间的依赖关系正确
              js += `export * from ${virtualModulePath}\n`;
            }
          }

          /**
           * 这段代码的目的是将 HTML 文件中的 <script> 标签内容转换为 JavaScript 模块。处理分为两个主要部分：
           * 1. src 属性：直接生成导入语句
           * 2. 内联内容：生成虚拟模块，并根据文件类型和上下文生成适当的导入或导出语句
           */
        }

        // This will trigger incorrectly if `export default` is contained
        // anywhere in a string. Svelte and Astro files can't have
        // `export default` as code so we know if it's encountered it's a
        // false positive (e.g. contained in a string)
        /**
         * 这里解释了如何处理包含 export default 语法的 JavaScript 代码，尤其是在特定的文件类型（如 Svelte 和 Astro 文件）中
         *
         * 1. export default 可能触发错误：
         * 如果在处理 JavaScript 文件时，代码中出现了 export default，但实际上它可能是字符串中的一部分，而不是实际的代码。
         * 这可能会导致误判，认为文件中存在 export default 语法。
         *
         * 2. Svelte 和 Astro 文件的特殊情况
         * Svelte 和 Astro 文件中的 JavaScript 代码不允许使用 export default。
         * 因此，如果这些文件中包含了 export default，我们可以确定它是一个假阳性（false positive），
         * 即它实际上并不是代码的一部分，而可能只是一个字符串内容。
         *
         * 3. 处理逻辑：
         * 如果当前文件不是 Vue 文件，或者 JavaScript 代码中不包含 export default，则追加一行 export default {}
         * 对于 Vue 文件，如果代码中包含 export default，则不再追加 export default {}，避免与现有的 export default 冲突
         *
         */
        if (!p.endsWith(".vue") || !js.includes("export default")) {
          js += "\nexport default {}";
        }

        /**
         * 对于loader 的处理：
         *
         * 指定为 "js"：通常用于处理外部 JavaScript 模块或当文件内容需要以 JavaScript 格式进行处理时
         *
         * 未指定 loader：可能是因为内容已经是 JavaScript 格式，或者根据 lang 属性选择其他语言的 loader。
         * 特别是对于 TypeScript、JSX 等文件，使用相应的 loader 确保正确的编译和转换。
         */
        return {
          loader: "js",
          contents: js,
        };
      };

      // 指定处理的文件是 HTML 类型的文件，将其内的脚本提取出来，并将其作为 JavaScript 模块进行处理
      build.onLoad(
        { filter: htmlTypesRE, namespace: "html" },
        htmlTypeOnLoadCallback
      );
      // the onResolve above will use namespace=html but esbuild doesn't
      // call onResolve for glob imports and those will use namespace=file
      // https://github.com/evanw/esbuild/issues/3317

      /**
       * 这段注释解释了为什么需要在 build.onLoad 中使用两个不同的 namespace，
       * 即 "html" 和 "file"，以及它们在处理不同类型的文件时的行为差异
       *
       * 在 esbuild 的插件系统中，namespace 是一个用于区分不同类型的文件处理逻辑的标识符。
       * 它帮助 esbuild 确定应该如何处理和加载特定的文件
       *
       * 对于 namespace="html" 的文件，onResolve 钩子会被用来解析这些文件的依赖关系
       * 对于 namespace="file" 的文件，esbuild 不会调用 onResolve 钩子。
       * 这是因为 esbuild 在处理 glob imports（例如 import.meta.glob）时，不
       * 会调用 onResolve 钩子， 而是直接使用 namespace="file"。
       *
       * 为什么需要两个 namespace呢？
       *
       * 1. HTML 文件可能包含 <script> 标签，这些标签可以是 JavaScript、TypeScript 或其他语言的代码块。
       * 为了处理这些脚本并将它们转换为 JavaScript 模块，需要使用 namespace="html"。
       * 这使得插件能够专门处理 HTML 文件中的 <script> 标签。
       *
       * 2. import.meta.glob 是一种特殊的语法，用于动态导入模块。esbuild 在处理这种语法时，
       * 可能会跳过一些 onResolve 调用，因为它直接使用 namespace="file" 来处理文件。
       * 这就是为什么需要额外处理 namespace="file" 的文件，以确保 glob imports 的正确处理。
       *
       */
      build.onLoad(
        { filter: htmlTypesRE, namespace: "file" },
        htmlTypeOnLoadCallback
      );

      // bare imports: record and externalize ----------------------------------
      // 这段代码主要处理了 bare imports（即未指定路径的导入）并决定是否将它们外部化
      build.onResolve(
        {
          // avoid matching windows volume
          // 匹配导入路径，排除了带有 Windows 卷标的路径（如 C:）和以冒号开头的路径
          // 实际上，这个正则表达式用于匹配裸导入 如 lodash 而不是 lodash/index.js
          filter: /^[\w@][^:]/,
        },
        async ({ path: id, importer, pluginData }) => {
          // 检查当前导入的模块是否在排除列表中
          if (moduleListContains(exclude, id)) {
            // 将模块标记为外部化
            return externalUnlessEntry({ path: id });
          }

          // 检查当前模块是否已经存在于 depImports 中
          if (depImports[id]) {
            // 如果是，则也将其标记为外部化
            return externalUnlessEntry({ path: id });
          }
          // 尝试解析导入的模块路径
          const resolved = await resolve(id, importer, {
            custom: {
              // 这里的 loader 是来自 pluginData，用于传递 HTML 类型的加载器信息。
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          });

          if (resolved) {
            // 解析成功

            // 判断当前模块是否需要外部化
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id });
            }

            // 查解析后的模块是否在 node_modules 中或在 include 列表中
            if (isInNodeModules(resolved) || include?.includes(id)) {
              // dependency or forced included, externalize and stop crawling

              // 如果模块符合优化条件，则将其添加到 depImports 中，并标记为外部化
              if (isOptimizable(resolved, config.optimizeDeps)) {
                depImports[id] = resolved;
              }
              return externalUnlessEntry({ path: id });

              // 检查解析后的模块是否需要进一步扫描
            } else if (isScannable(resolved, config.optimizeDeps.extensions)) {
              const namespace = htmlTypesRE.test(resolved) ? "html" : undefined;
              // linked package, keep crawling
              /**
               * keep crawling(继续扫描)
               *
               * 本地开发时，可能会有本地链接的包（比如通过 npm link 创建的链接）
               * 这些包在构建过程中需要被扫描和处理，而不是立即外部化
               */

              // 返回解析后的路径，并根据是否为 HTML 类型的文件设置 namespace
              return {
                path: path.resolve(resolved),
                namespace,
              };
            } else {
              // 将模块标记为外部化
              return externalUnlessEntry({ path: id });
            }
          } else {
            // 如果无法解析模块，则将其添加到 missing 列表中，记录无法找到的模块及其导入路径
            missing[id] = normalizePath(importer);
          }
        }
      );

      // Externalized file types -----------------------------------------------
      // these are done on raw ids using esbuild's native regex filter so it
      // should be faster than doing it in the catch-all via js
      // they are done after the bare import resolve because a package name
      // may end with these extensions

      /**
       * 用于配置 esbuild 的 onResolve 钩子的函数，其目的是根据特定的正则表达式和条件将模块标记为外部化
       * @param filter 用于匹配需要处理的模块路径
       * @param doExternalize 用于决定一个模块是否应该被外部化
       */
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

      // 外部化所有 CSS 文件
      // CSS 文件在构建过程中可以被外部化，因为它们可能已经被其他工具处理过，或者不需要打包到最终的构建结果中
      setupExternalize(CSS_LANGS_RE, isUnlessEntry);
      // json & wasm
      // 外部化 JSON 和 WASM 文件
      // 它们不一定需要被打包到最终的输出中，可以作为外部资源进行管理
      setupExternalize(/\.(json|json5|wasm)$/, isUnlessEntry);
      // known asset types
      // 外部化已知的资源类型文件，如图片、字体等。这些文件可能是静态资源，不需要直接打包进最终的构建中
      setupExternalize(
        new RegExp(`\\.(${KNOWN_ASSET_TYPES.join("|")})$`),
        isUnlessEntry
      );
      // known vite query types: ?worker, ?raw
      // 外部化匹配特殊查询参数的模块。这可能包括工作线程（web workers）和原始资源（raw）等，
      // 这些资源通常需要特殊处理，不适合直接打包进最终的构建结果中
      setupExternalize(SPECIAL_QUERY_RE, () => true);

      // catch all -------------------------------------------------------------

      // 用于处理所有未被前面钩子处理的模块，它会在其他更具体的解析钩子之后被调用，捕获所有未被处理的情况
      build.onResolve(
        {
          filter: /.*/,
        },
        async ({ path: id, importer, pluginData }) => {
          // 利用 Vite 的解析器来处理模块路径解析，支持 URL 和省略的扩展名
          // Vite 允许直接使用 URL 作为模块路径。例如，import 'https://example.com/module.js';。这种方式可以用来从外部服务器加载模块
          // 在 Vite 中，你可以省略模块路径的扩展名。例如，import 'module' 可以自动解析为 module.js 或 module.ts，具体取决于模块的实际类型和配置

          // 解析模块路径 id
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          });
          if (resolved) {
            // 解析成功

            if (
              // 判断是否需要将模块外部化
              shouldExternalizeDep(resolved, id) ||
              // 判断模块是否可以被扫描
              !isScannable(resolved, config.optimizeDeps.extensions)
            ) {
              return externalUnlessEntry({ path: id });
            }

            // 根据模块路径是否匹配 htmlTypesRE 正则表达式来设置 namespace
            const namespace = htmlTypesRE.test(resolved) ? "html" : undefined;

            // 返回解析后的模块路径和命名空间
            return {
              path: path.resolve(cleanUrl(resolved)),
              namespace,
            };
          } else {
            // 解析失败
            // 如果解析失败或模块需要外部化，返回外部化处理
            return externalUnlessEntry({ path: id });
          }
        }
      );

      // for jsx/tsx, we need to access the content and check for
      // presence of import.meta.glob, since it results in import relationships
      // but isn't crawled by esbuild.
      /**
       * 这段注释解释了为什么在处理 JSX 和 TSX 文件时，需要特别的逻辑来处理 import.meta.glob，
       * 因为 esbuild 默认情况下不会处理这个特性
       *
       * import.meta.glob 是 Vite 特有的一个功能，它允许动态地导入多个模块。
       * 这个特性在 JSX 和 TSX 文件中使用，但 esbuild 并不内建支持这个特性，因此它不会自动处理这些动态导入
       */
      // 匹配特定类型的文件（例如 .js, .jsx, .ts, .tsx, mjs）
      build.onLoad({ filter: JS_TYPES_RE }, async ({ path: id }) => {
        // 获取文件的扩展名
        let ext = path.extname(id).slice(1);
        // 如果扩展名是 .mjs，将其改为 .js，因为 mjs 和 js 在处理上是类似的
        if (ext === "mjs") ext = "js";

        // 读取文件的内容，并以 UTF-8 编码格式进行解码
        let contents = await fsp.readFile(id, "utf-8");

        // 如果文件是 jsx 或 tsx 类型，并且配置中有 jsxInject，则将 jsxInject 注入到文件内容的开头
        // 这个注入可能用于自动添加 React 的导入语句，例如 import React from 'react'
        if (ext.endsWith("x") && config.esbuild && config.esbuild.jsxInject) {
          contents = config.esbuild.jsxInject + `\n` + contents;
        }

        // 从配置中选择适当的加载器。
        // 如果配置中定义了扩展名对应的加载器，则使用该加载器；否则使用文件扩展名作为加载器。
        const loader =
          config.optimizeDeps?.esbuildOptions?.loader?.[`.${ext}`] ||
          (ext as Loader);

        // 检查文件内容是否包含 import.meta.glob,这是一种特殊的语法，用于动态导入多个模块
        if (contents.includes("import.meta.glob")) {
          // 调用 doTransformGlobImport 函数来处理这些动态导入，并将加载器设置为 "js"。
          return {
            loader: "js", // since it is transpiled,
            contents: await doTransformGlobImport(contents, id, loader),
          };
        }

        // 返回文件内容和加载器
        return {
          loader,
          contents,
        };
      });

      // onResolve is not called for glob imports.
      // we need to add that here as well until esbuild calls onResolve for glob imports.
      // https://github.com/evanw/esbuild/issues/3317
      // 这段代码处理了 esbuild 在处理 glob 导入时的一个特定问题
      // esbuild 目前存在一个问题，它在处理 glob 导入时不调用 onResolve 钩子。为了绕过这个问题，需要添加额外的处理逻辑
      build.onLoad({ filter: /.*/, namespace: "file" }, () => {
        // 导出一个空对象。这是为了确保即使 onResolve 没有被调用，构建过程仍然能继续进行，防止出现错误。
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

/**
 * 这个函数用于决定是否应该将某个依赖外部化
 * 外部化依赖意味着该依赖不会被打包到最终的输出中，而是作为外部依赖处理
 * @param resolvedId
 * @param rawId
 * @returns
 */
function shouldExternalizeDep(resolvedId: string, rawId: string): boolean {
  // not a valid file path
  // 检查是否是绝对路径：
  if (!path.isAbsolute(resolvedId)) {
    return true;
  }
  // virtual id
  if (resolvedId === rawId || resolvedId.includes("\0")) {
    return true;
  }
  return false;
}

/**
 * 函数用于判断给定的文件是否可以被扫描。
 * 它通过检查文件的扩展名以及匹配特定的正则表达式来确定文件是否可扫描
 * @param id 文件的路径或标识符
 * @param extensions 可扫描的文件扩展名数组
 * @returns
 */
function isScannable(id: string, extensions: string[] | undefined): boolean {
  return (
    //  用于匹配 JavaScript 类型文件（例如 .js, .jsx, .ts, .tsx 等）的正则表达式
    JS_TYPES_RE.test(id) ||
    // 用于匹配 HTML 类型文件（例如 .html, .vue等）的正则表达式
    htmlTypesRE.test(id) ||
    // 检查文件的扩展名是否在给定的扩展名数组种
    extensions?.includes(path.extname(id)) ||
    false
  );
}
