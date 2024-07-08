import fsp from "node:fs/promises";
import path from "node:path";
import MagicString from "magic-string";
import type { SourceMapInput } from "rollup";
import type { Connect } from "dep-types/connect";
import type { DefaultTreeAdapterMap, Token } from "parse5";
import type { IndexHtmlTransformHook } from "../../plugins/html";
import {
  addToHTMLProxyCache,
  applyHtmlTransforms,
  assetAttrsConfig,
  extractImportExpressionFromClassicScript,
  findNeedTransformStyleAttribute,
  getAttrKey,
  getScriptInfo,
  htmlEnvHook,
  htmlProxyResult,
  injectCspNonceMetaTagHook,
  injectNonceAttributeTagHook,
  nodeIsElement,
  overwriteAttrValue,
  postImportMapHook,
  preImportMapHook,
  resolveHtmlTransforms,
  traverseHtml,
} from "../../plugins/html";
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
  normalizePath,
  // processSrcSetSync,
  // stripBase,
} from "../../utils";
import { getFsUtils } from "../../fsUtils";
import { checkPublicFile } from "../../publicDir";
import { isCSSRequest } from "../../plugins/css";
import { getCodeWithSourcemap, injectSourcesContent } from "../sourcemap";
import { cleanUrl, unwrapId, wrapId } from "../../../shared/utils";

interface AssetNode {
  start: number;
  end: number;
  code: string;
}

interface InlineStyleAttribute {
  index: number;
  location: Token.Location;
  code: string;
}

export function createDevHtmlTransformFn(
  config: ResolvedConfig
): (
  server: ViteDevServer,
  url: string,
  html: string,
  originalUrl?: string
) => Promise<string> {
  const [preHooks, normalHooks, postHooks] = resolveHtmlTransforms(
    config.plugins,
    config.logger
  );
  const transformHooks = [
    preImportMapHook(config),
    injectCspNonceMetaTagHook(config),
    ...preHooks,
    htmlEnvHook(config),
    devHtmlHook,
    ...normalHooks,
    ...postHooks,
    injectNonceAttributeTagHook(config),
    postImportMapHook(),
  ];
  return (
    server: ViteDevServer,
    url: string,
    html: string,
    originalUrl?: string
  ): Promise<string> => {
    return applyHtmlTransforms(html, transformHooks, {
      path: url,
      filename: getHtmlFilename(url, server),
      server,
      originalUrl,
    });
  };
}

function getHtmlFilename(url: string, server: ViteDevServer) {
  if (url.startsWith(FS_PREFIX)) {
    return decodeURIComponent(fsPathFromId(url));
  } else {
    return decodeURIComponent(
      normalizePath(path.join(server.config.root, url.slice(1)))
    );
  }
}

function shouldPreTransform(url: string, config: ResolvedConfig) {
  return (
    !checkPublicFile(url, config) && (isJSRequest(url) || isCSSRequest(url))
  );
}

const wordCharRE = /\w/;

function isBareRelative(url: string) {
  return wordCharRE.test(url[0]) && !url.includes(":");
}

const isSrcSet = (attr: Token.Attribute) =>
  attr.name === "srcset" && attr.prefix === undefined;
const processNodeUrl = (
  url: string,
  useSrcSetReplacer: boolean,
  config: ResolvedConfig,
  htmlPath: string,
  originalUrl?: string,
  server?: ViteDevServer,
  isClassicScriptLink?: boolean
): string => {
  // prefix with base (dev only, base is never relative)
  const replacer = (url: string) => {
    if (server?.moduleGraph) {
      const mod = server.moduleGraph.urlToModuleMap.get(url);
      if (mod && mod.lastHMRTimestamp > 0) {
        url = injectQuery(url, `t=${mod.lastHMRTimestamp}`);
      }
    }

    if (
      (url[0] === "/" && url[1] !== "/") ||
      // #3230 if some request url (localhost:3000/a/b) return to fallback html, the relative assets
      // path will add `/a/` prefix, it will caused 404.
      //
      // skip if url contains `:` as it implies a url protocol or Windows path that we don't want to replace.
      //
      // rewrite `./index.js` -> `localhost:5173/a/index.js`.
      // rewrite `../index.js` -> `localhost:5173/index.js`.
      // rewrite `relative/index.js` -> `localhost:5173/a/relative/index.js`.
      ((url[0] === "." || isBareRelative(url)) &&
        originalUrl &&
        originalUrl !== "/" &&
        htmlPath === "/index.html")
    ) {
      url = path.posix.join(config.base, url);
    }

    if (server && !isClassicScriptLink && shouldPreTransform(url, config)) {
      let preTransformUrl: string | undefined;
      if (url[0] === "/" && url[1] !== "/") {
        preTransformUrl = url;
      } else if (url[0] === "." || isBareRelative(url)) {
        preTransformUrl = path.posix.join(
          config.base,
          path.posix.dirname(htmlPath),
          url
        );
      }
      if (preTransformUrl) {
        preTransformRequest(server, preTransformUrl, config.base);
      }
    }
    return url;
  };

  const processedUrl = useSrcSetReplacer
    ? processSrcSetSync(url, ({ url }) => replacer(url))
    : replacer(url);
  return processedUrl;
};
const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server, originalUrl }
) => {
  const { config, moduleGraph, watcher } = server!;
  const base = config.base || "/";

  let proxyModulePath: string;
  let proxyModuleUrl: string;

  const trailingSlash = htmlPath.endsWith("/");
  if (!trailingSlash && getFsUtils(config).existsSync(filename)) {
    proxyModulePath = htmlPath;
    proxyModuleUrl = proxyModulePath;
  } else {
    // There are users of vite.transformIndexHtml calling it with url '/'
    // for SSR integrations #7993, filename is root for this case
    // A user may also use a valid name for a virtual html file
    // Mark the path as virtual in both cases so sourcemaps aren't processed
    // and ids are properly handled
    const validPath = `${htmlPath}${trailingSlash ? "index.html" : ""}`;
    proxyModulePath = `\0${validPath}`;
    proxyModuleUrl = wrapId(proxyModulePath);
  }
  proxyModuleUrl = joinUrlSegments(base, proxyModuleUrl);

  const s = new MagicString(html);
  let inlineModuleIndex = -1;
  // The key to the proxyHtml cache is decoded, as it will be compared
  // against decoded URLs by the HTML plugins.
  const proxyCacheUrl = decodeURI(
    cleanUrl(proxyModulePath).replace(normalizePath(config.root), "")
  );
  const styleUrl: AssetNode[] = [];
  const inlineStyles: InlineStyleAttribute[] = [];

  const addInlineModule = (
    node: DefaultTreeAdapterMap["element"],
    ext: "js"
  ) => {
    inlineModuleIndex++;

    const contentNode = node.childNodes[0] as DefaultTreeAdapterMap["textNode"];

    const code = contentNode.value;

    let map: SourceMapInput | undefined;
    if (proxyModulePath[0] !== "\0") {
      map = new MagicString(html)
        .snip(
          contentNode.sourceCodeLocation!.startOffset,
          contentNode.sourceCodeLocation!.endOffset
        )
        .generateMap({ hires: "boundary" });
      map.sources = [filename];
      map.file = filename;
    }

    // add HTML Proxy to Map
    addToHTMLProxyCache(config, proxyCacheUrl, inlineModuleIndex, {
      code,
      map,
    });

    // inline js module. convert to src="proxy" (dev only, base is never relative)
    const modulePath = `${proxyModuleUrl}?html-proxy&index=${inlineModuleIndex}.${ext}`;

    // invalidate the module so the newly cached contents will be served
    const module = server?.moduleGraph.getModuleById(modulePath);
    if (module) {
      server?.moduleGraph.invalidateModule(module);
    }
    s.update(
      node.sourceCodeLocation!.startOffset,
      node.sourceCodeLocation!.endOffset,
      `<script type="module" src="${modulePath}"></script>`
    );
    preTransformRequest(server!, modulePath, base);
  };

  await traverseHtml(html, filename, (node) => {
    if (!nodeIsElement(node)) {
      return;
    }

    // script tags
    if (node.nodeName === "script") {
      const { src, sourceCodeLocation, isModule } = getScriptInfo(node);

      if (src) {
        const processedUrl = processNodeUrl(
          src.value,
          isSrcSet(src),
          config,
          htmlPath,
          originalUrl,
          server,
          !isModule
        );
        if (processedUrl !== src.value) {
          overwriteAttrValue(s, sourceCodeLocation!, processedUrl);
        }
      } else if (isModule && node.childNodes.length) {
        addInlineModule(node, "js");
      } else if (node.childNodes.length) {
        const scriptNode = node.childNodes[
          node.childNodes.length - 1
        ] as DefaultTreeAdapterMap["textNode"];
        for (const {
          url,
          start,
          end,
        } of extractImportExpressionFromClassicScript(scriptNode)) {
          const processedUrl = processNodeUrl(
            url,
            false,
            config,
            htmlPath,
            originalUrl
          );
          if (processedUrl !== url) {
            s.update(start, end, processedUrl);
          }
        }
      }
    }

    const inlineStyle = findNeedTransformStyleAttribute(node);
    if (inlineStyle) {
      inlineModuleIndex++;
      inlineStyles.push({
        index: inlineModuleIndex,
        location: inlineStyle.location!,
        code: inlineStyle.attr.value,
      });
    }

    if (node.nodeName === "style" && node.childNodes.length) {
      const children = node.childNodes[0] as DefaultTreeAdapterMap["textNode"];
      styleUrl.push({
        start: children.sourceCodeLocation!.startOffset,
        end: children.sourceCodeLocation!.endOffset,
        code: children.value,
      });
    }

    // elements with [href/src] attrs
    const assetAttrs = assetAttrsConfig[node.nodeName];
    if (assetAttrs) {
      for (const p of node.attrs) {
        const attrKey = getAttrKey(p);
        if (p.value && assetAttrs.includes(attrKey)) {
          const processedUrl = processNodeUrl(
            p.value,
            isSrcSet(p),
            config,
            htmlPath,
            originalUrl
          );
          if (processedUrl !== p.value) {
            overwriteAttrValue(
              s,
              node.sourceCodeLocation!.attrs![attrKey],
              processedUrl
            );
          }
        }
      }
    }
  });

  await Promise.all([
    ...styleUrl.map(async ({ start, end, code }, index) => {
      const url = `${proxyModulePath}?html-proxy&direct&index=${index}.css`;

      // ensure module in graph after successful load
      const mod = await moduleGraph.ensureEntryFromUrl(url, false);
      ensureWatchedFile(watcher, mod.file, config.root);

      const result = await server!.pluginContainer.transform(code, mod.id!);
      let content = "";
      if (result) {
        if (result.map && "version" in result.map) {
          if (result.map.mappings) {
            await injectSourcesContent(
              result.map,
              proxyModulePath,
              config.logger
            );
          }
          content = getCodeWithSourcemap("css", result.code, result.map);
        } else {
          content = result.code;
        }
      }
      s.overwrite(start, end, content);
    }),
    ...inlineStyles.map(async ({ index, location, code }) => {
      // will transform with css plugin and cache result with css-post plugin
      const url = `${proxyModulePath}?html-proxy&inline-css&style-attr&index=${index}.css`;

      const mod = await moduleGraph.ensureEntryFromUrl(url, false);
      ensureWatchedFile(watcher, mod.file, config.root);

      await server?.pluginContainer.transform(code, mod.id!);

      const hash = getHash(cleanUrl(mod.id!));
      const result = htmlProxyResult.get(`${hash}_${index}`);
      overwriteAttrValue(s, location, result ?? "");
    }),
  ]);

  html = s.toString();

  return {
    html,
    tags: [
      {
        tag: "script",
        attrs: {
          type: "module",
          src: path.posix.join(base, CLIENT_PUBLIC_PATH),
        },
        injectTo: "head-prepend",
      },
    ],
  };
};

/**
 * 用于在 Vite 开发服务器或预览服务器上处理请求，特别是处理 .html 文件的请求。
 * @param root
 * @param server
 * @returns
 */
export function indexHtmlMiddleware(
  root: string,
  server: ViteDevServer | PreviewServer
): Connect.NextHandleFunction {
  // 判断服务器是否处于开发模式
  const isDev = isDevServer(server);
  // 获取文件系统工具,主要用于检查文件是否存在
  const fsUtils = getFsUtils(server.config);

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (res.writableEnded) {
      // 如果响应已经结束，则直接调用 next 传递给下一个中间件
      return next();
    }

    const url = req.url && cleanUrl(req.url);

    // htmlFallbackMiddleware appends '.html' to URLs
    // 这个中间件很关键，添加完 html 后缀后，可以进入到下面的处理，从而解析根目录下的index.html 并发送给客户端
    if (url?.endsWith(".html") && req.headers["sec-fetch-dest"] !== "script") {
      let filePath: string;

      // 确定文件路径
      if (isDev && url.startsWith(FS_PREFIX)) {
        // 如果是FS_PREFIX开头的，则调用fsPathFromId 去除前缀
        filePath = decodeURIComponent(fsPathFromId(url));
      } else {
        // 将 URL 解码并与 root 拼接来确定文件路径
        filePath = path.join(root, decodeURIComponent(url));
      }

      console.log("fsUtils", fsUtils);

      // 检查文件是否存在并读取内容
      if (fsUtils.existsSync(filePath)) {
        // 根据模式的不同，选择的不同的请求头
        const headers = isDev
          ? server.config.server.headers
          : server.config.preview.headers;

        try {
          // 读取文件内容
          let html = await fsp.readFile(filePath, "utf-8");
          console.log("html", html);

          if (isDev) {
            // 开发模式下 调用transformIndexHtml 转换html 内容
            html = await server.transformIndexHtml(url, html, req.originalUrl);
          }

          // 通过 send 函数将 HTML 内容发送给客户端
          return send(req, res, html, "html", { headers });
        } catch (e) {
          // 出错的话，调用next 传递给下一个中间件
          return next(e);
        }
      }
    }
    next();
  };
}

function preTransformRequest(server: ViteDevServer, url: string, base: string) {
  if (!server.config.server.preTransformRequests) return;

  // transform all url as non-ssr as html includes client-side assets only
  try {
    url = unwrapId(stripBase(decodeURI(url), base));
  } catch {
    // ignore
    return;
  }
  server.warmupRequest(url);
}
