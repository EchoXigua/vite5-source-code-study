import path from "node:path";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { Options } from "sirv";
import sirv from "sirv";
import escapeHtml from "escape-html";
import type { Connect } from "dep-types/connect";
import type { ViteDevServer } from "../..";
import { FS_PREFIX } from "../../constants";
import {
  fsPathFromId,
  fsPathFromUrl,
  isFileReadable,
  isInternalRequest,
  isParentDirectory,
  isSameFileUri,
  removeLeadingSlash,
} from "../../utils";
import {
  cleanUrl,
  isWindows,
  slash,
  withTrailingSlash,
} from "../../../shared/utils";

const sirvOptions = ({
  getHeaders,
}: {
  getHeaders: () => OutgoingHttpHeaders | undefined;
}): Options => {
  return {
    dev: true,
    etag: true,
    extensions: [],
    setHeaders(res, pathname) {
      // Matches js, jsx, ts, tsx.
      // The reason this is done, is that the .ts file extension is reserved
      // for the MIME type video/mp2t. In almost all cases, we can expect
      // these files to be TypeScript files, and for Vite to serve them with
      // this Content-Type.
      if (knownJavascriptExtensionRE.test(pathname)) {
        res.setHeader("Content-Type", "text/javascript");
      }
      const headers = getHeaders();
      if (headers) {
        for (const name in headers) {
          res.setHeader(name, headers[name]!);
        }
      }
    },
  };
};

/**
 * 用于在 Vite 开发服务器中提供静态文件服务。
 * 该函数使用了 sirv 库来处理静态文件请求，并对请求路径进行了一些处理和检查。
 * @param server
 * @returns
 */
export function serveStaticMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  const dir = server.config.root;
  // 提供静态文件服务
  const serve = sirv(
    dir,
    sirvOptions({
      getHeaders: () => server.config.server.headers,
    })
  );

  // 保留命名函数。这个名字可以通过“debug =connect:dispatcher…”在调试日志中看到。
  return function viteServeStaticMiddleware(req, res, next) {
    // 这是实际的中间件函数，处理传入的请求

    /**
     * 只有当它不是HTML请求或以' / '结尾时才提供文件，
     * 这样HTML请求可以通过我们的HTML中间件进行特殊处理，也可以跳过内部请求' /@fs/ /@vit -client '等
     *
     * HTML 请求通常需要经过特殊处理（例如注入脚本），因此需要跳过静态文件处理，交给专门处理 HTML 请求的中间件
     * 而以 / 结尾的请求通常表示目录请求，需要进一步处理或重定向
     * 内部请求是 Vite 自身使用的模块或功能，不应通过静态文件中间件处理，应该交给其他专门的中间件或处理逻辑
     */

    // 去掉请求 URL 中的查询参数和哈希部分
    const cleanedUrl = cleanUrl(req.url!);
    if (
      cleanedUrl[cleanedUrl.length - 1] === "/" ||
      path.extname(cleanedUrl) === ".html" ||
      isInternalRequest(req.url!)
    ) {
      // 如果 URL 以 / 结尾，或者是一个 .html 文件，或者是内部请求，
      // 则直接跳过静态文件处理，调用 next() 进入下一个中间件
      return next();
    }

    // 将请求 URL 转换为标准 URL 对象，并解码路径名
    const url = new URL(req.url!.replace(/^\/{2,}/, "/"), "http://example.com");
    const pathname = decodeURI(url.pathname);

    // 对静态请求也应用别名
    let redirectedPathname: string | undefined;

    // 根据 Vite 配置中的别名规则，对请求路径进行替换，支持字符串匹配和正则表达式匹配
    for (const { find, replacement } of server.config.resolve.alias) {
      const matches =
        typeof find === "string"
          ? pathname.startsWith(find)
          : find.test(pathname);
      if (matches) {
        redirectedPathname = pathname.replace(find, replacement);
        break;
      }
    }

    if (redirectedPathname) {
      // 检查它是否以 dir 结尾的斜杠形式开头 dir 是根目录
      if (redirectedPathname.startsWith(withTrailingSlash(dir))) {
        // 截取为不包含 dir 的路径
        redirectedPathname = redirectedPathname.slice(dir.length);
      }
    }

    // 解析完成的路径名
    const resolvedPathname = redirectedPathname || pathname;

    // 构建文件路径：将 dir 和去掉开头斜杠的 resolvedPathname 组合成完整的文件路径
    let fileUrl = path.resolve(dir, removeLeadingSlash(resolvedPathname));

    // 处理路径结尾斜杠：
    if (
      resolvedPathname[resolvedPathname.length - 1] === "/" &&
      fileUrl[fileUrl.length - 1] !== "/"
    ) {
      // 如果请求的路径以斜杠结尾，并且构建的 fileUrl 不以斜杠结尾，则给构建的路径添加斜杠
      fileUrl = withTrailingSlash(fileUrl);
    }

    // 检查访问权限：检查请求的 fileUrl 是否可以被访问。如果无法访问，则返回
    if (!ensureServingAccess(fileUrl, server, res, next)) {
      return;
    }

    // 更新请求对象 req 的 url 属性为经过编码后 redirectedPathname
    if (redirectedPathname) {
      url.pathname = encodeURI(redirectedPathname);
      req.url = url.href.slice(url.origin.length);
    }

    // 最终调用 serve 函数来处理静态文件的请求
    serve(req, res, next);
  };
}

/**
 * 用于处理特定路径前缀的请求，并从文件系统的根目录提供这些文件
 * 这在某些情况下很有用，比如在链接的 monorepo 项目中，需要访问根目录之外的文件
 * @param server
 * @returns
 */
export function serveRawFsMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  // sirv 是一个静态文件服务器中间件
  //  "/" 表示从根目录开始提供服务
  const serveFromRoot = sirv(
    "/",
    sirvOptions({ getHeaders: () => server.config.server.headers })
  );

  // 保留命名函数。这个名字可以通过“debug =connect:dispatcher…”在调试日志中看到。
  // 返回中间件函数
  return function viteServeRawFsMiddleware(req, res, next) {
    // 这是实际的中间件函数，处理传入的请求

    // 解析请求的 URL，将双斜杠替换为单斜杠，避免路径错误
    const url = new URL(req.url!.replace(/^\/{2,}/, "/"), "http://example.com");
    /**
     * 在某些情况下(例如链接的单节点)，根目录之外的文件将引用同样不在服务根目录中的资产。
     * 在这种情况下，路径被重写为' /@fs/ '前缀路径，并且必须通过基于fs根的搜索来提供。
     */

    // 检查 URL 路径是否以 FS_PREFIX 开头，这是一个特殊前缀，用于标识需要从文件系统根目录提供的文件
    if (url.pathname.startsWith(FS_PREFIX)) {
      // 解码 URL 路径
      const pathname = decodeURI(url.pathname);
      //限制' fs.allow '之外的文件

      // 确保文件的路径在允许的范围内，如果不允许访问，则终止请求处理
      if (
        !ensureServingAccess(
          slash(path.resolve(fsPathFromId(pathname))),
          server,
          res,
          next
        )
      ) {
        return;
      }

      // 去掉前缀 FS_PREFIX
      let newPathname = pathname.slice(FS_PREFIX.length);
      // 处理 Windows 系统的路径，将驱动器号去掉,如 C: 或 D:  将 C:\path\to\file 变为 \path\to\file
      if (isWindows) newPathname = newPathname.replace(/^[A-Z]:/i, "");

      // 更新 URL 路径
      url.pathname = encodeURI(newPathname);
      /**
       * 更新请求路径，使其仅包含路径和查询参数部分，而不包含协议和主机名
       *
       * url.href 返回整个 URL 字符串。例如，http://example.com/path/to/file
       * url.origin 返回 URL 的协议和主机名部分。例如，http://example.com
       *
       * 通过slice 提取子字符串，起始位置为 url.origin.length，即从主机名之后的部分开始，
       * 结果字符串为 /path/to/file，即仅包含路径和查询参数部分
       *
       * 假设初始 URL 为 http://example.com/@fs/C:/path to/file：
       * newPathname = '/path to/file'，去除了驱动器号
       * url.pathname = encodeURI('/path to/file') 结果为 /path%20to/file，空格被编码为 %20
       * 最终请求 URL 为 /@fs/path%20to/file，确保路径被正确编码和理解
       */
      req.url = url.href.slice(url.origin.length); //以便后续中间件能够正确处理请求
      // 提供文件
      serveFromRoot(req, res, next);
    } else {
      // 如果 URL 路径不以 FS_PREFIX 开头，直接调用 next 处理下一个中间件
      next();
    }

    // 这个中间件的作用是处理带有特定前缀的请求，通过文件系统根目录提供相应的文件
  };
}

/**
 * 用于检查给定的文件路径是否允许被 Vite 服务器服务
 * @param url
 * @param server
 * @returns
 */
export function isFileServingAllowed(
  url: string,
  server: ViteDevServer
): boolean {
  // 如果文件服务的严格模式未启用，直接返回 true，表示允许所有文件服务
  if (!server.config.server.fs.strict) return true;

  // 使用 fsPathFromUrl 函数将 URL 转换为文件路径
  const file = fsPathFromUrl(url);

  // 检查文件路径是否匹配拒绝的全局模式
  if (server._fsDenyGlob(file)) return false;

  // 检查文件路径是否在安全模块路径列表中
  if (server.moduleGraph.safeModulesPath.has(file)) return true;

  if (
    // 遍历允许的 URI 列表
    server.config.server.fs.allow.some(
      // 查文件路径是否与某个允许的 URI 相同，或者是否是某个允许 URI 的子目录
      (uri) => isSameFileUri(uri, file) || isParentDirectory(uri, file)
    )
  )
    return true;

  // 默认返回 false，禁止文件服务
  return false;
}

/**
 * 是确保请求的 URL 在允许的文件服务路径列表中。
 * 如果请求的文件不在允许列表中，它会返回错误响应，防止访问。
 * 如果文件不存在，它会将请求传递给下一个中间件
 * @param url
 * @param server
 * @param res
 * @param next
 * @returns
 */
function ensureServingAccess(
  url: string,
  server: ViteDevServer,
  res: ServerResponse,
  next: Connect.NextFunction
): boolean {
  if (isFileServingAllowed(url, server)) {
    return true;
  }

  // cleanUrl 函数用于清理 URL，可能会移除查询参数等
  // isFileReadable 函数检查文件是否存在且可读
  if (isFileReadable(cleanUrl(url))) {
    // 如果文件存在但不在允许列表中，构建错误消息和提示信息

    // 提示具体的 URL 被拒绝
    const urlMessage = `The request url "${url}" is outside of Vite serving allow list.`;
    // 提供当前允许的路径列表和文档链接以获取更多信息
    const hintMessage = `
  ${server.config.server.fs.allow.map((i) => `- ${i}`).join("\n")}
  
  Refer to docs https://vitejs.dev/config/server-options.html#server-fs-allow for configurations and more details.`;

    // 记录错误信息到日志中
    server.config.logger.error(urlMessage);
    server.config.logger.warnOnce(hintMessage + "\n");
    // 设置 HTTP 状态码为 403（禁止访问
    res.statusCode = 403;
    // 返回包含错误信息的 HTML 内容
    res.write(renderRestrictedErrorHTML(urlMessage + "\n" + hintMessage));
    // 中断请求
    res.end();
  } else {
    // 如果这个文件不存在，我们不应该限制这个路径，因为它可以是一个API调用。
    // 如果文件未被处理，中间件将发出404
    next();
  }
  return false;
}

function renderRestrictedErrorHTML(msg: string): string {
  // 确保在模板字符串中使用反斜杠字符（\）时，不会被转义，从而保留原始的字符串内容。
  const html = String.raw;

  // escapeHtml 处理传入的错误消息 msg，可以有效防止 XSS 攻击，确保输出的 HTML 是安全的，不会被利用来注入恶意代码
  return html`
    <body>
      <h1>403 Restricted</h1>
      <p>${escapeHtml(msg).replace(/\n/g, "<br/>")}</p>
      <style>
        body {
          padding: 1em 2em;
        }
      </style>
    </body>
  `;
}
