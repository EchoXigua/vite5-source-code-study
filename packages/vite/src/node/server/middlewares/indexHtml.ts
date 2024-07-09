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
  ensureWatchedFile,
  fsPathFromId,
  getHash,
  injectQuery,
  isDevServer,
  isJSRequest,
  joinUrlSegments,
  normalizePath,
  processSrcSetSync,
  stripBase,
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

/**
 * 在 Vite 中用于创建一个开发环境下的 HTML 转换函数
 * 这个函数会根据配置的插件顺序和一些内置的转换钩子，对 HTML 内容进行一系列的处理和修改
 * @param config
 * @returns
 */
export function createDevHtmlTransformFn(
  config: ResolvedConfig
): (
  server: ViteDevServer,
  url: string,
  html: string,
  originalUrl?: string
) => Promise<string> {
  // 解析 HTML 转换钩子
  const [preHooks, normalHooks, postHooks] = resolveHtmlTransforms(
    config.plugins,
    config.logger
  );

  // 定义一系列用于转换 HTML 的钩子
  const transformHooks = [
    // 在 HTML 中导入 map 之前的预处理钩子
    preImportMapHook(config),
    // 注入 CSP (Content Security Policy) nonce 元标签的钩子
    injectCspNonceMetaTagHook(config),
    // 用户插件的预处理钩子
    ...preHooks,
    // 处理环境变量相关的钩子
    htmlEnvHook(config),
    // 开发环境下的 HTML 处理钩子
    devHtmlHook,
    // 用户插件的正常处理钩子
    ...normalHooks,
    // 用户插件的后处理钩子
    ...postHooks,
    // 注入 nonce 属性标签的钩子
    injectNonceAttributeTagHook(config),
    // 在 HTML 中导入 map 之后的后处理钩子
    postImportMapHook(),
  ];

  // 返回转换函数
  return (
    server: ViteDevServer,
    url: string,
    html: string,
    originalUrl?: string
  ): Promise<string> => {
    // 应用所有的转换钩子
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
    // 如果以FS_PREFIX 开头，则删除这个
    return decodeURIComponent(fsPathFromId(url));
  } else {
    // 否则，将 URL 转换为相对于服务器根目录的路径
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

/**
 * 检查给定的属性是否为 srcset 属性，并且没有前缀
 * @param attr
 * @returns
 */
const isSrcSet = (attr: Token.Attribute) =>
  attr.name === "srcset" && attr.prefix === undefined;

/**
 * 根据传入的参数处理和转换给定的 URL
 * @param url 要处理的 URL 字符串
 * @param useSrcSetReplacer 指示是否应用 srcset 替换器
 * @param config 包含解析后配置信息的对象
 * @param htmlPath 当前 HTML 文件的路径
 * @param originalUrl 原始 URL
 * @param server 开发服务器实例
 * @param isClassicScriptLink 指示是否为经典的脚本链接
 * @returns
 */
const processNodeUrl = (
  url: string,
  useSrcSetReplacer: boolean,
  config: ResolvedConfig,
  htmlPath: string,
  originalUrl?: string,
  server?: ViteDevServer,
  isClassicScriptLink?: boolean
): string => {
  // 前缀为base(仅限dev, base从来不是相对的)
  // 用于实际处理和转换 URL
  const replacer = (url: string) => {
    if (server?.moduleGraph) {
      // 存在模块图
      const mod = server.moduleGraph.urlToModuleMap.get(url);
      // 检查 URL 对应的模块是否有最新的 HMR 时间戳
      if (mod && mod.lastHMRTimestamp > 0) {
        // 将其作为查询参数 t 注入到 URL 中
        url = injectQuery(url, `t=${mod.lastHMRTimestamp}`);
      }
    }

    // 如果 URL 符合以下条件之一，进行重写处理
    if (
      // 检查 URL 是否是绝对路径，并且不是以双斜杠 // 开头
      (url[0] === "/" && url[1] !== "/") ||
      // #3230 if some request url (localhost:3000/a/b) return to fallback html, the relative assets
      // path will add `/a/` prefix, it will caused 404.
      //
      // skip if url contains `:` as it implies a url protocol or Windows path that we don't want to replace.
      //
      // rewrite `./index.js` -> `localhost:5173/a/index.js`.
      // rewrite `../index.js` -> `localhost:5173/index.js`.
      // rewrite `relative/index.js` -> `localhost:5173/a/relative/index.js`.

      // 检查 URL 是否是相对路径，并且满足以下条件
      ((url[0] === "." || isBareRelative(url)) &&
        // 同时满足 originalUrl 不为空且不是根路径 /，以及 htmlPath 是 "/index.html"
        originalUrl &&
        originalUrl !== "/" &&
        htmlPath === "/index.html")
    ) {
      //  将 config.base 和 URL 进行拼接，以确保 URL 被重写为以 config.base 作为根路径的绝对路径
      url = path.posix.join(config.base, url);
    }

    // 如果满足以下条件，则进行预转换请求处理：
    // 存在 server 实例、不是经典的脚本链接、是否需要进行预转换
    if (server && !isClassicScriptLink && shouldPreTransform(url, config)) {
      // 预转换的url
      let preTransformUrl: string | undefined;

      // 如果 URL 是绝对路径，直接使用
      if (url[0] === "/" && url[1] !== "/") {
        preTransformUrl = url;
      } else if (url[0] === "." || isBareRelative(url)) {
        // 如果 URL 是相对路径

        // 与 config.base 和 htmlPath 的目录部分进行拼接，以获取完整的路径
        preTransformUrl = path.posix.join(
          config.base,
          path.posix.dirname(htmlPath),
          url
        );
      }
      // 存在预转化url，则调用 preTransformRequest 进行处理
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

/**
 * 用于处理和转换开发环境下 HTML 内容的钩子函数。该函数在 Vite 的开发服务器中使用，
 * 用于处理 HTML 文件中的各种资源引用，如脚本和样式，以便在开发环境中正确加载和转换
 * @param html
 * @param param1
 * @returns
 */
const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server, originalUrl }
) => {
  // 获取服务器配置、模块图和文件观察器（chokidar）
  const { config, moduleGraph, watcher } = server!;
  const base = config.base || "/";

  let proxyModulePath: string;
  let proxyModuleUrl: string;

  // 是否以"/" 结尾
  const trailingSlash = htmlPath.endsWith("/");
  if (!trailingSlash && getFsUtils(config).existsSync(filename)) {
    // 路径不是一/结尾且存在对应的文件，则直接使用路径
    proxyModulePath = htmlPath;
    proxyModuleUrl = proxyModulePath;
  } else {
    /**
     * 一些用户在使用 vite.transformIndexHtml 时，会传递 URL '/'，这是为了支持服务端渲染（SSR）的集成
     * 对于这种情况，filename 会是根目录
     * 用户也可能使用一个有效的名称来表示一个虚拟的 HTML 文件
     *
     * 在这两种情况下，将路径标记为虚拟路径，这样可以确保不会处理 sourcemaps，并且能够正确处理 ID
     */

    // 路径标记为虚拟路径
    const validPath = `${htmlPath}${trailingSlash ? "index.html" : ""}`;
    proxyModulePath = `\0${validPath}`;
    proxyModuleUrl = wrapId(proxyModulePath);
  }

  proxyModuleUrl = joinUrlSegments(base, proxyModuleUrl);

  // 创建一个 MagicString 实例，用于对 HTML 内容进行代码操作和变更
  const s = new MagicString(html);
  // 存储内联模块索引
  let inlineModuleIndex = -1;
  /**
   * 缓存键的解码：proxyCacheUrl 的键是解码后的
   * 这意味着在生成这个键时，将 URL 解码，以确保其与其他经过解码的 URL 进行比较时能够匹配
   *
   * 解码后的 proxyCacheUrl 将与 HTML 插件中的解码 URL 进行比较
   * 这是为了确保在处理 HTML 插件时，能够正确匹配和使用缓存的条目
   *
   * proxyModulePath 被解码以生成 proxyCacheUrl，这使得在 HTML 插件中对 URL 进行解码比较时能够正确匹配
   */

  // 代理缓存 URL
  const proxyCacheUrl = decodeURI(
    cleanUrl(proxyModulePath).replace(normalizePath(config.root), "")
  );
  // 样式 URL
  const styleUrl: AssetNode[] = [];
  // 和内联样式
  const inlineStyles: InlineStyleAttribute[] = [];

  /**
   * 用于处理内联的 JavaScript 模块，并将它们转换成引用外部代理模块的 <script> 标签
   * @param node
   * @param ext
   */
  const addInlineModule = (
    node: DefaultTreeAdapterMap["element"],
    ext: "js"
  ) => {
    // 每次调用时递增 inlineModuleIndex，用于标识不同的内联模块
    inlineModuleIndex++;

    // 获取内联脚本内容节点
    const contentNode = node.childNodes[0] as DefaultTreeAdapterMap["textNode"];

    // 获取内联脚本的代码内容
    const code = contentNode.value;

    let map: SourceMapInput | undefined;
    //  不是虚拟路径（即不以 \0 开头），则生成 source map
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

    // 将内联脚本代码及其 source map 添加到缓存中
    addToHTMLProxyCache(config, proxyCacheUrl, inlineModuleIndex, {
      code,
      map,
    });

    // 内联js模块。转换为src="proxy"(仅限dev, base不是相对的)
    /**生成代理模块路径，包含查询参数 html-proxy 和 index，用于标识具体的内联模块 */
    const modulePath = `${proxyModuleUrl}?html-proxy&index=${inlineModuleIndex}.${ext}`;

    /**使模块失效，以便提供新缓存的内容 */
    const module = server?.moduleGraph.getModuleById(modulePath);
    if (module) {
      server?.moduleGraph.invalidateModule(module);
    }

    // 更新内联脚本标签
    s.update(
      node.sourceCodeLocation!.startOffset,
      node.sourceCodeLocation!.endOffset,
      `<script type="module" src="${modulePath}"></script>`
    );

    //  预处理代理模块的请求
    preTransformRequest(server!, modulePath, base);
  };

  /**遍历 HTML 内容，并对 HTML 中的脚本、内联样式和其他资源链接进行处理 */
  await traverseHtml(html, filename, (node) => {
    // 检查当前节点是否是元素节点，如果不是则直接返回
    if (!nodeIsElement(node)) {
      return;
    }

    // 理 <script> 标签：
    if (node.nodeName === "script") {
      /**获取脚本的相关信息 */
      const { src, sourceCodeLocation, isModule } = getScriptInfo(node);

      if (src) {
        //  处理 URL，并用 overwriteAttrValue 更新属性值
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
        // 如果是模块化的内联脚本（带有 type="module" 的 <script> 标签）
        // 调用 addInlineModule 函数处理内联模块化脚本
        addInlineModule(node, "js");
      } else if (node.childNodes.length) {
        // 如果是非模块化的内联脚本
        // extractImportExpressionFromClassicScript 提取导入表达式，并用 s.update 更新 URL
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

    // 查找需要转换的内联样式属性
    const inlineStyle = findNeedTransformStyleAttribute(node);
    if (inlineStyle) {
      inlineModuleIndex++;
      // 存在的话将其添加到 inlineStyles 列表中
      inlineStyles.push({
        index: inlineModuleIndex,
        location: inlineStyle.location!,
        code: inlineStyle.attr.value,
      });
    }

    // 处理 <style> 标签中的内容：
    if (node.nodeName === "style" && node.childNodes.length) {
      // 获取 <style> 标签中的内容，并将其添加到 styleUrl 列表中，以便后续处理
      const children = node.childNodes[0] as DefaultTreeAdapterMap["textNode"];
      styleUrl.push({
        start: children.sourceCodeLocation!.startOffset,
        end: children.sourceCodeLocation!.endOffset,
        code: children.value,
      });
    }

    // 处理带有 [href/src] 属性的元素
    const assetAttrs = assetAttrsConfig[node.nodeName];
    if (assetAttrs) {
      // 遍历这些属性并使用 processNodeUrl 处理 URL，最后用 overwriteAttrValue 更新属性值
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

  // 并行处理 styleUrl 和 inlineStyles 数组中的样式，并将处理后的样式内容更新到 HTML 中
  await Promise.all([
    ...styleUrl.map(async ({ start, end, code }, index) => {
      // 生成对应的模块 URL（带有 html-proxy 和 index 参数）
      const url = `${proxyModulePath}?html-proxy&direct&index=${index}.css`;

      // 确保模块在加载后进入模块图
      const mod = await moduleGraph.ensureEntryFromUrl(url, false);
      // 确保文件被监视，以便在文件更改时触发重新编译
      ensureWatchedFile(watcher, mod.file, config.root);

      // 对样式代码进行转换
      const result = await server!.pluginContainer.transform(code, mod.id!);
      let content = "";
      if (result) {
        // 如果转换结果包含映射（map），则调用 injectSourcesContent 注入源内容，并生成带有映射的代码
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
      //  将转换后的样式内容更新到 HTML 中
      s.overwrite(start, end, content);
    }),
    ...inlineStyles.map(async ({ index, location, code }) => {
      // will transform with css plugin and cache result with css-post plugin
      // 生成对应的模块 URL（带有 html-proxy、inline-css、style-attr 和 index 参数）
      const url = `${proxyModulePath}?html-proxy&inline-css&style-attr&index=${index}.css`;

      // 确保模块在加载后进入模块图
      const mod = await moduleGraph.ensureEntryFromUrl(url, false);
      // 确保文件被监视
      ensureWatchedFile(watcher, mod.file, config.root);

      // 对样式代码进行转换
      await server?.pluginContainer.transform(code, mod.id!);

      // 计算模块的哈希值
      const hash = getHash(cleanUrl(mod.id!));
      // 从 htmlProxyResult 中获取转换结果
      const result = htmlProxyResult.get(`${hash}_${index}`);
      // 将转换后的样式内容更新到 HTML 中
      overwriteAttrValue(s, location, result ?? "");
    }),
  ]);

  // 将 MagicString 对象转换为字符串，包含了对原始 HTML 进行的所有变更和更新
  html = s.toString();

  return {
    html, //转换后的 HTML 字符串
    tags: [
      // 包含一个要注入的 <script> 标签
      {
        tag: "script", //要注入的标签名
        attrs: {
          //标签的属性对象
          type: "module",
          src: path.posix.join(base, CLIENT_PUBLIC_PATH),
        },
        injectTo: "head-prepend", //插入的位置
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

      // 检查文件是否存在并读取内容
      if (fsUtils.existsSync(filePath)) {
        // 根据模式的不同，选择的不同的请求头
        const headers = isDev
          ? server.config.server.headers
          : server.config.preview.headers;

        try {
          // 读取文件内容
          let html = await fsp.readFile(filePath, "utf-8");
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
