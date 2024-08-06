import path from "node:path";
import fsp from "node:fs/promises";
import type { Connect } from "dep-types/connect";
import colors from "picocolors";
import type { ExistingRawSourceMap } from "rollup";
import type { ViteDevServer } from "..";
import {
  createDebugger,
  fsPathFromId,
  injectQuery,
  isImportRequest,
  isJSRequest,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  urlRE,
} from "../../utils";
import { send } from "../send";
import { ERR_LOAD_URL, transformRequest } from "../transformRequest";
import { applySourcemapIgnoreList } from "../sourcemap";
import { isHTMLProxy } from "../../plugins/html";
import { DEP_VERSION_RE, FS_PREFIX } from "../../constants";
import {
  isCSSRequest,
  isDirectCSSRequest,
  isDirectRequest,
} from "../../plugins/css";
import {
  ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR,
  ERR_OPTIMIZE_DEPS_PROCESSING_ERROR,
  ERR_OUTDATED_OPTIMIZED_DEP,
} from "../../plugins/optimizedDeps";
import { ERR_CLOSED_SERVER } from "../pluginContainer";
import { getDepsOptimizer } from "../../optimizer";
import { cleanUrl, unwrapId, withTrailingSlash } from "../../../shared/utils";
import { NULL_BYTE_PLACEHOLDER } from "../../../shared/constants";

const debugCache = createDebugger("vite:cache");

const knownIgnoreList = new Set(["/", "/favicon.ico"]);

/**
 * 用于处理 Vite 开发服务器中的缓存转换逻辑。它的主要目的是检查请求的 ETag 头，
 * 如果可以使用缓存响应，就返回 HTTP 状态码 304 (Not Modified)，以避免重新处理请求，从而提升性能。
 */
export function cachedTransformMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteCachedTransformMiddleware(req, res, next) {
    // 检查是否可以提前返回 304 状态码
    // 浏览器在请求头中带有 If-None-Match，表示它已经有一个缓存的版本，并带有 ETag 值
    // 服务器通过这个 ETag 来判断是否内容有变化
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch) {
      // 获取与 ETag 对应的模块
      const moduleByEtag = server.moduleGraph.getModuleByEtag(ifNoneMatch);
      // 转换结果中的 ETag 与请求头中的 ETag 相同，说明内容没有变化，可以使用缓存
      if (moduleByEtag?.transformResult?.etag === ifNoneMatch) {
        // For CSS requests, if the same CSS file is imported in a module,
        // the browser sends the request for the direct CSS request with the etag
        // from the imported CSS module. We ignore the etag in this case.
        /**
         * 对于 CSS 请求，可能会有多次请求同一个 CSS 文件的情况。需要忽略这种情况下的 ETag。
         */
        const maybeMixedEtag = isCSSRequest(req.url!);
        if (!maybeMixedEtag) {
          // 返回 304 状态码，告诉浏览器内容没有变化，可以使用缓存的版本
          debugCache?.(`[304] ${prettifyUrl(req.url!, server.config.root)}`);
          res.statusCode = 304;
          return res.end();
        }
      }
    }

    // 如果不能使用缓存或者是 CSS 请求，调用 next() 继续处理请求
    next();
  };
}

export function transformMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  // 保留命名函数。这个名字可以通过“debug =connect:dispatcher…”在调试日志中看到

  // 检查 public 目录是否在项目的根目录中
  const { root, publicDir } = server.config;

  // 检查 publicDir 是否在 root 目录中
  const publicDirInRoot = publicDir.startsWith(withTrailingSlash(root));
  // 计算 publicPath
  const publicPath = `${publicDir.slice(root.length)}/`;

  return async function viteTransformMiddleware(req, res, next) {
    // 这里检查请求是否为 get，因为 esm 请求模块是get 请求，也就是我们需要转换的模块
    // 检查请求是否在需要忽略的 URL 的集合
    // 两者满足其一就跳过此次处理，交给后续的中间件去处理
    if (req.method !== "GET" || knownIgnoreList.has(req.url!)) {
      return next();
    }

    /**存储处理后的请求 URL */
    let url: string;
    try {
      // removeTimestampQuery 去除 URL 中的时间戳查询参数，在前面几章我们可以发现vite 很多请求都会加上v?123456
      // 使用 decodeURI 解码 URL，将url 中的占位符替换为\0
      url = decodeURI(removeTimestampQuery(req.url!)).replace(
        NULL_BYTE_PLACEHOLDER,
        "\0"
      );
    } catch (e) {
      return next(e);
    }

    /**去除 URL 中的查询参数，只保留基础路径，这样可以简化后续处理 */
    const withoutQuery = cleanUrl(url);

    try {
      // 这一块主要是处理 sourcemap 文件
      const isSourceMap = withoutQuery.endsWith(".map");
      // since we generate source map references, handle those requests here
      if (isSourceMap) {
        const depsOptimizer = getDepsOptimizer(server.config, false); // non-ssr
        if (depsOptimizer?.isOptimizedDepUrl(url)) {
          // If the browser is requesting a source map for an optimized dep, it
          // means that the dependency has already been pre-bundled and loaded
          const sourcemapPath = url.startsWith(FS_PREFIX)
            ? fsPathFromId(url)
            : normalizePath(path.resolve(server.config.root, url.slice(1)));
          try {
            const map = JSON.parse(
              await fsp.readFile(sourcemapPath, "utf-8")
            ) as ExistingRawSourceMap;

            applySourcemapIgnoreList(
              map,
              sourcemapPath,
              server.config.server.sourcemapIgnoreList,
              server.config.logger
            );

            return send(req, res, JSON.stringify(map), "json", {
              headers: server.config.server.headers,
            });
          } catch (e) {
            // Outdated source map request for optimized deps, this isn't an error
            // but part of the normal flow when re-optimizing after missing deps
            // Send back an empty source map so the browser doesn't issue warnings
            const dummySourceMap = {
              version: 3,
              file: sourcemapPath.replace(/\.map$/, ""),
              sources: [],
              sourcesContent: [],
              names: [],
              mappings: ";;;;;;;;;",
            };
            return send(req, res, JSON.stringify(dummySourceMap), "json", {
              cacheControl: "no-cache",
              headers: server.config.server.headers,
            });
          }
        } else {
          const originalUrl = url.replace(/\.map($|\?)/, "$1");
          const map = (
            await server.moduleGraph.getModuleByUrl(originalUrl, false)
          )?.transformResult?.map;
          if (map) {
            return send(req, res, JSON.stringify(map), "json", {
              headers: server.config.server.headers,
            });
          } else {
            return next();
          }
        }
      }

      // 检查请求的 URL 是否涉及到 Vite 项目中的 public 目录，并在特定情况下发出警告
      // 1. 避免冗余路径：在 URL 中显式包含 public 目录可能是多余的，因为 Vite 已经配置了静态资源的处理方式
      // 2. 防止错误：显式在 URL 中包含 public 目录的路径可能会导致路径解析错误或资源未找到的问题
      // 3. 一致性：确保 URL 路径的一致性和正确性，避免用户在 URL 中使用不必要的路径
      // 例如 访问public 下面的文件 /public/img.png 这里是不需要加 public
      if (publicDirInRoot && url.startsWith(publicPath)) {
        warnAboutExplicitPublicPathInUrl(url);
      }

      if (
        // 是否是 js 请求
        isJSRequest(url) ||
        // 是否是 导入请求（如模块请求）
        isImportRequest(url) ||
        // 是否是 css 请求
        isCSSRequest(url) ||
        // 请求的是否是 html-proxy
        isHTMLProxy(url)
      ) {
        // 用于去除 URL 中的 ?import 查询参数，以便更好地处理和转换请求
        url = removeImportQuery(url);
        // 去除由 importAnalysis 插件添加的有效 ID 前缀，这些前缀通常用于解决导入路径，但在处理请求时需要去除
        // 像/@id/
        url = unwrapId(url);

        /**
         * 在处理 CSS 请求时，Vite 区分了两种情况：普通的 CSS 请求和 CSS 导入。
         * 这里的目标是确保对这两种请求类型进行适当的处理，尤其是在缓存和响应策略方面。
         *
         * 1. 普通的 CSS 请求是指直接从浏览器请求的 CSS 文件。这通常是通过 <link> 标签或 CSS 文件的 URL 进行的请求。
         * @example
         * <link rel="stylesheet" href="/styles/main.css">
         *
         * 对于普通的 CSS 请求:
         *  1） 缓存控制：Vite 会设置缓存策略，以确保浏览器能够缓存 CSS 文件并在未来的请求中使用这些缓存的文件。
         *  2） 直接请求处理：如果请求的 CSS 文件是直接的（即不是通过 JS 动态导入的），Vite 会为这些请求设置适当的响应头，例如 Cache-Control。
         *
         *
         * 2. CSS 导入是指在 JS 文件中通过 import 语法动态导入的 CSS 文件。
         * @example
         * import './styles/main.css';
         *
         * 对于 CSS 导入：
         *  1） 请求注入：如果请求的 CSS 文件是通过 JS 导入的，Vite 会在 URL 中注入查询参数（例如 ?direct），以区分这种类型的请求。
         *      这样可以确保 Vite 在处理这些请求时采用不同的策略。
         *  2） 缓存策略：由于这些 CSS 文件可能被多个模块动态导入，Vite 可能会使用不同的缓存策略，以确保不会发生缓存冲突或错误。
         */
        if (isCSSRequest(url)) {
          if (
            // 检查请求头中是否接受 text/css 类型
            req.headers.accept?.includes("text/css") &&
            // 检查请求是否不是直接请求（即可能是 CSS 导入）
            !isDirectRequest(url)
          ) {
            // 为 css 导入 注入查询参数
            url = injectQuery(url, "direct");
          }

          // check if we can return 304 early for CSS requests. These aren't handled
          // by the cachedTransformMiddleware due to the browser possibly mixing the
          // etags of direct and imported CSS
          /**
           * 1. 这段注释说明了代码的主要目的是检查是否可以提前返回一个 304 状态码。304 状态码表示“未修改”，
           * 用于告诉客户端缓存的资源是最新的，无需重新下载。这样做可以提高响应速度和效率。
           *
           * 2. cachedTransformMiddleware 是 Vite 中的一个中间件，用于处理缓存文件转换模块。
           * 在开发模式中，Vite 需要对 JavaScript 和 CSS 模块进行转换和缓存管理。
           * CSS 请求（特别是直接请求和导入请求）不会经过 cachedTransformMiddleware 处理。
           * 这是因为 cachedTransformMiddleware 可能只处理了部分资源，而 CSS 文件的处理需要特别注意。
           *
           * 3. etags 是用于缓存验证的标识符。浏览器使用 ETag 值来判断缓存的资源是否已经过期。
           * 混合 etags 指的是浏览器可能将直接请求的 CSS 文件和通过 JavaScript 导入的 CSS 文件的 ETag 值混合在一起。这可能导致缓存冲突或验证问题。
           */

          /**
           * 这段代码处理了 CSS 请求中的缓存验证，尤其是在处理直接请求和导入请求时的缓存策略。其目的是提高缓存效率和避免缓存冲突。
           */
          const ifNoneMatch = req.headers["if-none-match"];
          if (
            ifNoneMatch &&
            // 检查 if-none-match 请求头中的 ETag 值，并与服务器上实际模块的 ETag 进行比较
            // 确保 CSS 文件的缓存验证不会混淆或冲突
            (await server.moduleGraph.getModuleByUrl(url, false))
              ?.transformResult?.etag === ifNoneMatch
          ) {
            // 如果 ETag 匹配，服务器可以快速返回 304 状态码，避免重新处理和传输 CSS 文件，从而提高响应速度和性能
            debugCache?.(`[304] ${prettifyUrl(url, server.config.root)}`);
            res.statusCode = 304;
            return res.end();
          }
        }

        /**
         * 在 Vite 的开发服务器中，resolve, load, 和 transform 是处理模块请求的关键步骤。这些步骤通常通过插件容器（plugin container）来完成
         *
         * 1. resolve 是用于解析模块的路径。它负责将模块的导入路径转换为实际的文件系统路径。
         *
         * 2. load 是用于加载模块的内容。它负责读取文件内容并将其提供给后续的处理步骤。
         *
         * 3. transform 是用于处理和转换模块内容的步骤。这包括将原始文件内容转换为目标格式，如将 ES6 模块转为 ES5、处理 CSS 预处理器等。
         */
        const result = await transformRequest(url, server, {
          html: req.headers.accept?.includes("text/html"),
        });

        // 如果 result 存在，意味着请求的模块经过解析、加载和转换，现在可以返回给客户端
        if (result) {
          // 用于获取依赖优化器
          const depsOptimizer = getDepsOptimizer(server.config, false); // non-ssr
          // 判断请求的 URL 是否是直接请求 CSS 文件
          const type = isDirectCSSRequest(url) ? "css" : "js";

          // 检查当前请求的 url 是否为经过依赖预构建，如果是的话则设置强缓存
          const isDep =
            DEP_VERSION_RE.test(url) || depsOptimizer?.isOptimizedDepUrl(url);
          return send(req, res, result.code, type, {
            etag: result.etag,
            // allow browser to cache npm deps!
            cacheControl: isDep ? "max-age=31536000,immutable" : "no-cache",
            headers: server.config.server.headers,
            map: result.map,
          });
        }
      }
    } catch (e) {
      if (e?.code === ERR_OPTIMIZE_DEPS_PROCESSING_ERROR) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504; // status code request timeout
          res.statusMessage = "Optimize Deps Processing Error";
          res.end();
        }
        // This timeout is unexpected
        server.config.logger.error(e.message);
        return;
      }
      if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504; // status code request timeout
          res.statusMessage = "Outdated Optimize Dep";
          res.end();
        }
        // We don't need to log an error in this case, the request
        // is outdated because new dependencies were discovered and
        // the new pre-bundle dependencies have changed.
        // A full-page reload has been issued, and these old requests
        // can't be properly fulfilled. This isn't an unexpected
        // error but a normal part of the missing deps discovery flow
        return;
      }
      if (e?.code === ERR_CLOSED_SERVER) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504; // status code request timeout
          res.statusMessage = "Outdated Request";
          res.end();
        }
        // We don't need to log an error in this case, the request
        // is outdated because new dependencies were discovered and
        // the new pre-bundle dependencies have changed.
        // A full-page reload has been issued, and these old requests
        // can't be properly fulfilled. This isn't an unexpected
        // error but a normal part of the missing deps discovery flow
        return;
      }
      if (e?.code === ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR) {
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
        server.config.logger.warn(colors.yellow(e.message));
        return;
      }
      if (e?.code === ERR_LOAD_URL) {
        // Let other middleware handle if we can't load the url via transformRequest
        return next();
      }
      return next(e);
    }

    next();
  };

  function warnAboutExplicitPublicPathInUrl(url: string) {
    let warning: string;

    if (isImportRequest(url)) {
      const rawUrl = removeImportQuery(url);
      if (urlRE.test(url)) {
        warning =
          `Assets in the public directory are served at the root path.\n` +
          `Instead of ${colors.cyan(rawUrl)}, use ${colors.cyan(
            rawUrl.replace(publicPath, "/")
          )}.`;
      } else {
        warning =
          "Assets in public directory cannot be imported from JavaScript.\n" +
          `If you intend to import that asset, put the file in the src directory, and use ${colors.cyan(
            rawUrl.replace(publicPath, "/src/")
          )} instead of ${colors.cyan(rawUrl)}.\n` +
          `If you intend to use the URL of that asset, use ${colors.cyan(
            injectQuery(rawUrl.replace(publicPath, "/"), "url")
          )}.`;
      }
    } else {
      warning =
        `Files in the public directory are served at the root path.\n` +
        `Instead of ${colors.cyan(url)}, use ${colors.cyan(
          url.replace(publicPath, "/")
        )}.`;
    }

    server.config.logger.warn(colors.yellow(warning));
  }
}
