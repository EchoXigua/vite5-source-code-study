import fsp from "node:fs/promises";
import path from "node:path";

import type { Connect } from "dep-types/connect";
import type { PreviewServer, ResolvedConfig, ViteDevServer } from "../..";
import { send } from "../send";
import { CLIENT_PUBLIC_PATH, FS_PREFIX } from "../../constants";
import {
  // ensureWatchedFile,
  fsPathFromId,
  // getHash,
  // injectQuery,
  isDevServer,
  // isJSRequest,
  // joinUrlSegments,
  // normalizePath,
  // processSrcSetSync,
  // stripBase,
} from "../../utils";
import { getFsUtils } from "../../fsUtils";

import { cleanUrl } from "../../../shared/utils";

export function indexHtmlMiddleware(
  root: string,
  server: ViteDevServer | PreviewServer
): Connect.NextHandleFunction {
  const isDev = isDevServer(server);
  const fsUtils = getFsUtils(server.config);

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (res.writableEnded) {
      return next();
    }

    const url = req.url && cleanUrl(req.url);
    // htmlFallbackMiddleware appends '.html' to URLs
    if (url?.endsWith(".html") && req.headers["sec-fetch-dest"] !== "script") {
      let filePath: string;
      if (isDev && url.startsWith(FS_PREFIX)) {
        filePath = decodeURIComponent(fsPathFromId(url));
      } else {
        filePath = path.join(root, decodeURIComponent(url));
      }

      if (fsUtils.existsSync(filePath)) {
        const headers = isDev
          ? server.config.server.headers
          : server.config.preview.headers;

        try {
          let html = await fsp.readFile(filePath, "utf-8");
          if (isDev) {
            html = await server.transformIndexHtml(url, html, req.originalUrl);
          }
          return send(req, res, html, "html", { headers });
        } catch (e) {
          return next(e);
        }
      }
    }
    next();
  };
}
