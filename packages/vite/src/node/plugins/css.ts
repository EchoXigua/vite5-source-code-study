import path from "node:path";

import type {
  ExistingRawSourceMap,
  ModuleFormat,
  OutputChunk,
  RenderedChunk,
  RollupError,
  SourceMapInput,
} from "rollup";
import type * as PostCSS from "postcss";
import type { LightningCSSOptions } from "dep-types/lightningcss";
import { CSS_LANGS_RE } from "../constants";
import type { ResolvedConfig } from "../config";
import { normalizePath } from "../utils";

import { cleanUrl, slash } from "../../shared/utils";

//用于配置 Vite 中与 CSS 相关的选项，涵盖了各种 CSS 处理方式，包括 CSS 模块、预处理器和源映射等。
export interface CSSOptions {
  /**
   * 使用 lightningcss 作为实验性选项来处理 CSS 模块、资源和导入。
   * 需要将其安装为一个对等依赖项(peer dependency)。这与使用预处理器不兼容。
   *
   * @default 'postcss'
   * @experimental
   */
  transformer?: "postcss" | "lightningcss";
  /**
   * https://github.com/css-modules/postcss-modules
   *
   * 用于配置 CSS 模块。可以是 false（禁用 CSS 模块）或 CSS 模块选项对象。
   */
  modules?: CSSModulesOptions | false;

  /**
   * 预处理器的选项。
   *
   * 除了每个处理器特定的选项外，Vite 还支持 `additionalData` 选项。
   * `additionalData` 选项可用于为每个样式内容注入额外的代码。
   *
   * vite 中使用：
   * css: {
   *      preprocessorOptions: {
            scss: {
                additionalData: `$injectedColor: orange;`
            }
        },
   * }
   */
  preprocessorOptions?: Record<string, any>;

  /**
   * 如果设置此选项，预处理器将在可能的情况下运行在 worker 中。
   * `true` 表示 CPU 数减 1。
   *
   * 这是一个实验性选项。
   * @default 0
   * @experimental
   */
  preprocessorMaxWorkers?: number | true;

  /**
   * 配置 PostCSS 选项。
   * 可以是一个字符串（指向配置文件的路径）或一个对象，包含 PostCSS 处理选项和插件数组。
   */
  postcss?:
    | string
    | (PostCSS.ProcessOptions & {
        plugins?: PostCSS.AcceptedPlugin[];
      });

  /**
   * 在开发时启用 CSS 源映射。
   * @default false
   * @experimental
   */
  devSourcemap?: boolean;

  /**
   * @experimental
   */
  lightningcss?: LightningCSSOptions;
}

/**
 *  demo

export default defineConfig({
  css: {
    transformer: 'postcss',
    modules: {
      scopeBehaviour: 'local',
      generateScopedName: '[name]__[local]___[hash:base64:5]'
    },
    preprocessorOptions: {
      scss: {
        additionalData: `$injectedColor: orange;`
      }
    },
    preprocessorMaxWorkers: true,
    postcss: {
      plugins: [
        require('autoprefixer')(),
        require('cssnano')()
      ]
    },
    devSourcemap: true,
    lightningcss: {
      // 配置 lightningcss 的选项
    }
  }
});
 */

export interface CSSModulesOptions {
  getJSON?: (
    cssFileName: string,
    json: Record<string, string>,
    outputFileName: string
  ) => void;
  scopeBehaviour?: "global" | "local";
  globalModulePaths?: RegExp[];
  exportGlobals?: boolean;
  generateScopedName?:
    | string
    | ((name: string, filename: string, css: string) => string);
  hashPrefix?: string;
  /**
   * default: undefined
   */
  localsConvention?:
    | "camelCase"
    | "camelCaseOnly"
    | "dashes"
    | "dashesOnly"
    | ((
        originalClassName: string,
        generatedClassName: string,
        inputFile: string
      ) => string);
}

const cssModuleRE = new RegExp(`\\.module${CSS_LANGS_RE.source}`);
const directRequestRE = /[?&]direct\b/;

export const isDirectCSSRequest = (request: string): boolean =>
  CSS_LANGS_RE.test(request) && directRequestRE.test(request);

export const isCSSRequest = (request: string): boolean =>
  CSS_LANGS_RE.test(request);

export const isModuleCSSRequest = (request: string): boolean =>
  cssModuleRE.test(request);

export async function formatPostcssSourceMap(
  rawMap: ExistingRawSourceMap,
  file: string
): Promise<ExistingRawSourceMap> {
  const inputFileDir = path.dirname(file);

  const sources = rawMap.sources.map((source) => {
    const cleanSource = cleanUrl(decodeURIComponent(source));

    // postcss virtual files
    if (cleanSource[0] === "<" && cleanSource[cleanSource.length - 1] === ">") {
      return `\0${cleanSource}`;
    }

    return normalizePath(path.resolve(inputFileDir, cleanSource));
  });

  return {
    file,
    mappings: rawMap.mappings,
    names: rawMap.names,
    sources,
    sourcesContent: rawMap.sourcesContent,
    version: rawMap.version,
  };
}

type PreprocessorWorkerController = ReturnType<
  typeof createPreprocessorWorkerController
>;

const preprocessorWorkerControllerCache = new WeakMap<
  ResolvedConfig,
  PreprocessorWorkerController
>();
let alwaysFakeWorkerWorkerControllerCache:
  | PreprocessorWorkerController
  | undefined;

export interface PreprocessCSSResult {
  code: string;
  map?: SourceMapInput;
  modules?: Record<string, string>;
  deps?: Set<string>;
}

/**
 * @experimental
 */
export async function preprocessCSS(
  code: string,
  filename: string,
  config: ResolvedConfig
): Promise<PreprocessCSSResult> {
  let workerController = preprocessorWorkerControllerCache.get(config);

  // if (!workerController) {
  //   // if workerController doesn't exist, create a workerController that always uses fake workers
  //   // because fake workers doesn't require calling `.close` unlike real workers
  //   alwaysFakeWorkerWorkerControllerCache ||=
  //     createPreprocessorWorkerController(0)
  //   workerController = alwaysFakeWorkerWorkerControllerCache
  // }

  // return await compileCSS(filename, code, config, workerController)
}

async function compileCSS(
  id: string,
  code: string,
  config: ResolvedConfig,
  workerController: PreprocessorWorkerController,
  urlReplacer?: CssUrlReplacer
): Promise<{
  code: string;
  map?: SourceMapInput;
  ast?: PostCSS.Result;
  modules?: Record<string, string>;
  deps?: Set<string>;
}> {
  if (config.css?.transformer === "lightningcss") {
    return compileLightningCSS(id, code, config, urlReplacer);
  }

  const { modules: modulesOptions, devSourcemap } = config.css || {};
  const isModule = modulesOptions !== false && cssModuleRE.test(id);
  // although at serve time it can work without processing, we do need to
  // crawl them in order to register watch dependencies.
  const needInlineImport = code.includes("@import");
  const hasUrl = cssUrlRE.test(code) || cssImageSetRE.test(code);
  const lang = id.match(CSS_LANGS_RE)?.[1] as CssLang | undefined;
  const postcssConfig = await resolvePostcssConfig(config);

  // 1. plain css that needs no processing
  if (
    lang === "css" &&
    !postcssConfig &&
    !isModule &&
    !needInlineImport &&
    !hasUrl
  ) {
    return { code, map: null };
  }

  let modules: Record<string, string> | undefined;
  const deps = new Set<string>();

  // 2. pre-processors: sass etc.
  let preprocessorMap: ExistingRawSourceMap | undefined;
  if (isPreProcessor(lang)) {
    const preprocessorResult = await compileCSSPreprocessors(
      id,
      lang,
      code,
      config,
      workerController
    );
    code = preprocessorResult.code;
    preprocessorMap = preprocessorResult.map;
    preprocessorResult.deps?.forEach((dep) => deps.add(dep));
  }

  // 3. postcss
  const atImportResolvers = getAtImportResolvers(config);
  const postcssOptions = (postcssConfig && postcssConfig.options) || {};

  const postcssPlugins =
    postcssConfig && postcssConfig.plugins ? postcssConfig.plugins.slice() : [];

  if (needInlineImport) {
    postcssPlugins.unshift(
      (await importPostcssImport()).default({
        async resolve(id, basedir) {
          const publicFile = checkPublicFile(id, config);
          if (publicFile) {
            return publicFile;
          }

          const resolved = await atImportResolvers.css(
            id,
            path.join(basedir, "*")
          );

          if (resolved) {
            return path.resolve(resolved);
          }

          // postcss-import falls back to `resolve` dep if this is unresolved,
          // but we've shimmed to remove the `resolve` dep to cut on bundle size.
          // warn here to provide a better error message.
          if (!path.isAbsolute(id)) {
            config.logger.error(
              colors.red(
                `Unable to resolve \`@import "${id}"\` from ${basedir}`
              )
            );
          }

          return id;
        },
        async load(id) {
          const code = await fs.promises.readFile(id, "utf-8");
          const lang = id.match(CSS_LANGS_RE)?.[1] as CssLang | undefined;
          if (isPreProcessor(lang)) {
            const result = await compileCSSPreprocessors(
              id,
              lang,
              code,
              config,
              workerController
            );
            result.deps?.forEach((dep) => deps.add(dep));
            // TODO: support source map
            return result.code;
          }
          return code;
        },
        nameLayer(index) {
          return `vite--anon-layer-${getHash(id)}-${index}`;
        },
      })
    );
  }

  if (urlReplacer) {
    postcssPlugins.push(
      UrlRewritePostcssPlugin({
        replacer: urlReplacer,
        logger: config.logger,
      })
    );
  }

  if (isModule) {
    postcssPlugins.unshift(
      (await importPostcssModules()).default({
        ...modulesOptions,
        localsConvention: modulesOptions?.localsConvention,
        getJSON(
          cssFileName: string,
          _modules: Record<string, string>,
          outputFileName: string
        ) {
          modules = _modules;
          if (modulesOptions && typeof modulesOptions.getJSON === "function") {
            modulesOptions.getJSON(cssFileName, _modules, outputFileName);
          }
        },
        async resolve(id: string, importer: string) {
          for (const key of getCssResolversKeys(atImportResolvers)) {
            const resolved = await atImportResolvers[key](id, importer);
            if (resolved) {
              return path.resolve(resolved);
            }
          }

          return id;
        },
      })
    );
  }

  if (!postcssPlugins.length) {
    return {
      code,
      map: preprocessorMap,
      deps,
    };
  }

  let postcssResult: PostCSS.Result;
  try {
    const source = removeDirectQuery(id);
    const postcss = await importPostcss();
    // postcss is an unbundled dep and should be lazy imported
    postcssResult = await postcss.default(postcssPlugins).process(code, {
      ...postcssOptions,
      parser: lang === "sss" ? loadSss(config.root) : postcssOptions.parser,
      to: source,
      from: source,
      ...(devSourcemap
        ? {
            map: {
              inline: false,
              annotation: false,
              // postcss may return virtual files
              // we cannot obtain content of them, so this needs to be enabled
              sourcesContent: true,
              // when "prev: preprocessorMap", the result map may include duplicate filename in `postcssResult.map.sources`
              // prev: preprocessorMap,
            },
          }
        : {}),
    });

    // record CSS dependencies from @imports
    for (const message of postcssResult.messages) {
      if (message.type === "dependency") {
        deps.add(normalizePath(message.file as string));
      } else if (message.type === "dir-dependency") {
        // https://github.com/postcss/postcss/blob/main/docs/guidelines/plugin.md#3-dependencies
        const { dir, glob: globPattern = "**" } = message;
        const pattern =
          glob.escapePath(normalizePath(path.resolve(path.dirname(id), dir))) +
          `/` +
          globPattern;
        const files = glob.sync(pattern, {
          ignore: ["**/node_modules/**"],
        });
        for (let i = 0; i < files.length; i++) {
          deps.add(files[i]);
        }
      } else if (message.type === "warning") {
        const warning = message as PostCSS.Warning;
        let msg = `[vite:css] ${warning.text}`;
        msg += `\n${generateCodeFrame(
          code,
          {
            line: warning.line,
            column: warning.column - 1, // 1-based
          },
          warning.endLine !== undefined && warning.endColumn !== undefined
            ? {
                line: warning.endLine,
                column: warning.endColumn - 1, // 1-based
              }
            : undefined
        )}`;
        config.logger.warn(colors.yellow(msg));
      }
    }
  } catch (e) {
    e.message = `[postcss] ${e.message}`;
    e.code = code;
    e.loc = {
      file: e.file,
      line: e.line,
      column: e.column - 1, // 1-based
    };
    throw e;
  }

  if (!devSourcemap) {
    return {
      ast: postcssResult,
      code: postcssResult.css,
      map: { mappings: "" },
      modules,
      deps,
    };
  }

  const rawPostcssMap = postcssResult.map.toJSON();

  const postcssMap = await formatPostcssSourceMap(
    // version property of rawPostcssMap is declared as string
    // but actually it is a number
    rawPostcssMap as Omit<RawSourceMap, "version"> as ExistingRawSourceMap,
    cleanUrl(id)
  );

  return {
    ast: postcssResult,
    code: postcssResult.css,
    map: combineSourcemapsIfExists(cleanUrl(id), postcssMap, preprocessorMap),
    modules,
    deps,
  };
}

const createPreprocessorWorkerController = (maxWorkers: number | undefined) => {
  const scss = scssProcessor(maxWorkers);
  const less = lessProcessor(maxWorkers);
  const styl = stylProcessor(maxWorkers);

  const sassProcess: StylePreprocessor["process"] = (
    source,
    root,
    options,
    resolvers
  ) => {
    return scss.process(
      source,
      root,
      { ...options, indentedSyntax: true },
      resolvers
    );
  };

  const close = () => {
    less.close();
    scss.close();
    styl.close();
  };

  return {
    [PreprocessLang.less]: less.process,
    [PreprocessLang.scss]: scss.process,
    [PreprocessLang.sass]: sassProcess,
    [PreprocessLang.styl]: styl.process,
    [PreprocessLang.stylus]: styl.process,
    close,
  } as const satisfies { [K in PreprocessLang | "close"]: unknown };
};

const scssProcessor = (
  maxWorkers: number | undefined
): SassStylePreprocessor => {
  const workerMap = new Map<unknown, ReturnType<typeof makeScssWorker>>();

  return {
    close() {
      for (const worker of workerMap.values()) {
        worker.stop();
      }
    },
    async process(source, root, options, resolvers) {
      const sassPath = loadPreprocessorPath(PreprocessLang.sass, root);

      if (!workerMap.has(options.alias)) {
        workerMap.set(
          options.alias,
          makeScssWorker(resolvers, options.alias, maxWorkers)
        );
      }
      const worker = workerMap.get(options.alias)!;

      const { content: data, map: additionalMap } = await getSource(
        source,
        options.filename,
        options.additionalData,
        options.enableSourcemap
      );

      const optionsWithoutAdditionalData = {
        ...options,
        additionalData: undefined,
      };
      try {
        const result = await worker.run(
          sassPath,
          data,
          optionsWithoutAdditionalData
        );
        const deps = result.stats.includedFiles.map((f) => cleanScssBugUrl(f));
        const map: ExistingRawSourceMap | undefined = result.map
          ? JSON.parse(result.map.toString())
          : undefined;

        return {
          code: result.css.toString(),
          map,
          additionalMap,
          deps,
        };
      } catch (e) {
        // normalize SASS error
        e.message = `[sass] ${e.message}`;
        e.id = e.file;
        e.frame = e.formatted;
        return { code: "", error: e, deps: [] };
      }
    },
  };
};
