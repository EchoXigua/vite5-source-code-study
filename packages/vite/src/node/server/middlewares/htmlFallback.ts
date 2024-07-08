import path from "node:path";
import type { Connect } from "dep-types/connect";
import { createDebugger } from "../../utils";
import type { FsUtils } from "../../fsUtils";
import { commonFsUtils } from "../../fsUtils";
import { cleanUrl } from "../../../shared/utils";

const debug = createDebugger("vite:html-fallback");

/**
 * 用于处理 Vite 项目中的 HTML 文件请求
 * 其主要功能是在处理不同路径请求时，检查对应的 HTML 文件是否存在，并进行相应的路径重写
 * @param root
 * @param spaFallback
 * @param fsUtils
 * @returns
 */
export function htmlFallbackMiddleware(
  root: string,
  spaFallback: boolean,
  fsUtils: FsUtils = commonFsUtils
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteHtmlFallbackMiddleware(req, res, next) {
    if (
      // 该中间件只处理 GET 和 HEAD 请求，其他方法的请求会直接调用 next() 跳过此中间件。
      (req.method !== "GET" && req.method !== "HEAD") ||
      // 请求路径为 /favicon.ico 的请求会直接跳过此中间件
      req.url === "/favicon.ico" ||
      // 该中间件要求 Accept 头部包含 text/html 或 */*，否则请求会被跳过。
      !(
        req.headers.accept === undefined || // equivalent to `Accept: */*`
        req.headers.accept === "" || // equivalent to `Accept: */*`
        req.headers.accept.includes("text/html") ||
        req.headers.accept.includes("*/*")
      )
    ) {
      return next();
    }

    // 对请求路径进行清理和解码，以便后续处理
    const url = cleanUrl(req.url!);
    const pathname = decodeURIComponent(url);

    // .html文件不被serveStaticMiddleware处理，所以我们需要检查该文件是否存在
    if (pathname.endsWith(".html")) {
      const filePath = path.join(root, pathname);
      if (fsUtils.existsSync(filePath)) {
        // 存在则重写请求路径
        debug?.(`Rewriting ${req.method} ${req.url} to ${url}`);
        req.url = url;
        return next();
      }
    }
    // 尾斜杠应该检查是否有回退index.html
    else if (pathname[pathname.length - 1] === "/") {
      // 末尾为 "/" 的，统一添加 index.html
      const filePath = path.join(root, pathname, "index.html");
      if (fsUtils.existsSync(filePath)) {
        // 存在的话，重写路径，这里访问"/" 目录的时候，会走到这里，从而添加index.html
        // 被后面的中间件去处理
        const newUrl = url + "index.html";
        debug?.(`Rewriting ${req.method} ${req.url} to ${newUrl}`);
        req.url = newUrl;
        return next();
      }
    }
    // 非尾随斜杠应该检查是否有回退 .html
    else {
      // 非尾随斜杠的会添加.html 后缀,文件存在后重写后,调用next() 交给下一个中间件
      const filePath = path.join(root, pathname + ".html");
      if (fsUtils.existsSync(filePath)) {
        const newUrl = url + ".html";
        debug?.(`Rewriting ${req.method} ${req.url} to ${newUrl}`);
        req.url = newUrl;
        return next();
      }
    }

    // 以上的情况都不满足,启用单页面应用的回退处理，将所有未匹配的路径重写为 /index.html
    if (spaFallback) {
      debug?.(`Rewriting ${req.method} ${req.url} to /index.html`);
      req.url = "/index.html";
    }

    next();
  };
}
