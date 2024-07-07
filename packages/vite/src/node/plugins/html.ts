import path from "node:path";
import type {
  OutputAsset,
  OutputBundle,
  OutputChunk,
  RollupError,
  SourceMapInput,
} from "rollup";
import MagicString from "magic-string";
import colors from "picocolors";
import type { DefaultTreeAdapterMap, ParserError, Token } from "parse5";
import { stripLiteral } from "strip-literal";
import type { ResolvedConfig } from "../config";
import { resolveEnvPrefix } from "../env";
import {
  // encodeURIPath,
  // generateCodeFrame,
  // getHash,
  // isDataUrl,
  // isExternalUrl,
  normalizePath,
  // partialEncodeURIPath,
  // processSrcSet,
  // removeLeadingSlash,
  unique,
} from "../utils";
import type { Logger } from "../logger";
import type { Plugin } from "../plugin";
import type { ViteDevServer } from "../server";

interface ScriptAssetsUrl {
  start: number;
  end: number;
  url: string;
}

const inlineImportRE =
  /(?<!(?<!\.\.)\.)\bimport\s*\(("(?:[^"]|(?<=\\)")*"|'(?:[^']|(?<=\\)')*')\)/dg;

const spaceRe = /[\t\n\f\r ]/;

const importMapRE =
  /[ \t]*<script[^>]*type\s*=\s*(?:"importmap"|'importmap'|importmap)[^>]*>.*?<\/script>/is;
const moduleScriptRE =
  /[ \t]*<script[^>]*type\s*=\s*(?:"module"|'module'|module)[^>]*>/i;
const modulePreloadLinkRE =
  /[ \t]*<link[^>]*rel\s*=\s*(?:"modulepreload"|'modulepreload'|modulepreload)[\s\S]*?\/>/i;
const importMapAppendRE = new RegExp(
  [moduleScriptRE, modulePreloadLinkRE].map((r) => r.source).join("|"),
  "i"
);
// 用于在 HTML 文件中找到需要处理的资源属性，以便在构建过程中进行资源替换或处理
export const assetAttrsConfig: Record<string, string[]> = {
  link: ["href"],
  video: ["src", "poster"],
  source: ["src", "srcset"],
  img: ["src", "srcset"],
  image: ["xlink:href", "href"],
  use: ["xlink:href", "href"],
};

// 存储了 HTML 代理转换的结果
// 在构建过程中，Vite 会对 HTML 文件中的一些内容进行代理转换，这些转换结果会被存储在 htmlProxyResult 中
// 键是通过 importer 和 query.index 生成的唯一标识符，值是转换后的 CSS 代码
// `${hash(importer)}_${query.index}` -> transformed css code
// PS: key like `hash(/vite/playground/assets/index.html)_1`)
export const htmlProxyResult = new Map<string, string>();

// 用于存储每个 ResolvedConfig（已解析的配置）对应的 HTML 代理转换结果
// 这样可以在不同的配置上下文中缓存和查找转换后的内容，以提高构建效率和支持热重载等功能
export const htmlProxyMap = new WeakMap<
  ResolvedConfig,
  Map<string, Array<{ code: string; map?: SourceMapInput }>>
>();

/**
 * 用于将转换后的 HTML 代理结果添加到缓存中
 * @param config 已解析的配置对象
 * @param filePath 文件路径
 * @param index 转换结果的索引
 * @param result 转换后的结果，包含代码和可选的 SourceMap
 */
export function addToHTMLProxyCache(
  config: ResolvedConfig,
  filePath: string,
  index: number,
  result: { code: string; map?: SourceMapInput }
): void {
  if (!htmlProxyMap.get(config)) {
    // 检查 config 对应的 Map 是否存在，不存在则创建
    htmlProxyMap.set(config, new Map());
  }
  if (!htmlProxyMap.get(config)!.get(filePath)) {
    // 检查 filePath 对应的数组是否存在，不存在则创建
    htmlProxyMap.get(config)!.set(filePath, []);
  }

  // 将转换结果存储到对应的索引位置
  htmlProxyMap.get(config)!.get(filePath)![index] = result;
}

/**
 * 用于应用一系列 HTML 转换钩子来处理 HTML 内容。
 * @param html 初始的 HTML 字符串
 * @param hooks
 * HTML 转换钩子的数组，每个钩子是一个异步函数，
 * 接受 HTML 字符串和上下文对象作为参数，并返回转换后的 HTML 或包含标签的对象
 * @param ctx 转换上下文
 * @returns
 */
export async function applyHtmlTransforms(
  html: string,
  hooks: IndexHtmlTransformHook[],
  ctx: IndexHtmlTransformContext
): Promise<string> {
  // 循环遍历每个钩子并应用转换
  for (const hook of hooks) {
    const res = await hook(html, ctx);
    if (!res) {
      continue;
    }
    if (typeof res === "string") {
      // 如果钩子返回一个字符串，将其作为新的 html
      html = res;
    } else {
      // 如果钩子返回的是一个对象或数组，进行进一步处理
      let tags: HtmlTagDescriptor[];
      if (Array.isArray(res)) {
        // 如果返回值是数组，则认为它是包含标签的数组
        tags = res;
      } else {
        // 如果返回值是对象，提取 html 和 tags 属
        html = res.html || html;
        tags = res.tags;
      }

      // 分类标签并注入到相应位置
      let headTags: HtmlTagDescriptor[] | undefined;
      let headPrependTags: HtmlTagDescriptor[] | undefined;
      let bodyTags: HtmlTagDescriptor[] | undefined;
      let bodyPrependTags: HtmlTagDescriptor[] | undefined;

      for (const tag of tags) {
        // 根据 injectTo 属性将标签分类存储到不同的数组中
        switch (tag.injectTo) {
          case "body":
            (bodyTags ??= []).push(tag);
            break;
          case "body-prepend":
            (bodyPrependTags ??= []).push(tag);
            break;
          case "head":
            (headTags ??= []).push(tag);
            break;
          default:
            (headPrependTags ??= []).push(tag);
        }
      }

      // 用于检查和处理需要插入到 <head> 中的标签
      headTagInsertCheck(
        [...(headTags || []), ...(headPrependTags || [])],
        ctx
      );

      // 用于将标签插入到 HTML 的相应位置
      if (headPrependTags) html = injectToHead(html, headPrependTags, true);
      if (headTags) html = injectToHead(html, headTags);
      if (bodyPrependTags) html = injectToBody(html, bodyPrependTags, true);
      if (bodyTags) html = injectToBody(html, bodyTags);
    }
  }

  // 通过这个函数，Vite 可以灵活地处理 HTML 文件，注入脚本、样式等资源，
  // 以实现插件系统和各种自定义功能。

  return html;
}

/**
 * 它用于从经典脚本（<script> 标签中的内容）中提取导入表达式的 URL
 * @param scriptTextNode
 * @returns
 * @example 
 * <script>
    import "module1";
    import "module2";
  </script>

  [
    { start: 9, end: 16, url: "module1" },
    { start: 27, end: 34, url: "module2" }
  ]
 */
export function extractImportExpressionFromClassicScript(
  scriptTextNode: DefaultTreeAdapterMap["textNode"]
): ScriptAssetsUrl[] {
  // 获取脚本文本节点的起始偏移量
  const startOffset = scriptTextNode.sourceCodeLocation!.startOffset;
  // stripLiteral 函数用于清理脚本内容，可能是去掉注释或处理字符串字面量等
  const cleanCode = stripLiteral(scriptTextNode.value);

  // 用于存储提取到的 URL 信息
  const scriptUrls: ScriptAssetsUrl[] = [];
  let match: RegExpExecArray | null;
  // 一个正则表达式，用于匹配脚本中的导入表达式。将其 lastIndex 设为 0 以确保从头开始匹配。
  inlineImportRE.lastIndex = 0;

  // 循环匹配导入表达式
  while ((match = inlineImportRE.exec(cleanCode))) {
    // 每次匹配到导入表达式后，提取 URL 的起始和结束位置
    const [, [urlStart, urlEnd]] = match.indices!;
    const start = urlStart + 1;
    const end = urlEnd - 1;
    scriptUrls.push({
      start: start + startOffset,
      end: end + startOffset,
      url: scriptTextNode.value.slice(start, end),
    });
  }
  return scriptUrls;
}

// <tag style="... url(...) or image-set(...) ..."></tag>
// extract inline styles as virtual css
/**
 * 用于在 HTML 元素节点中查找需要转换的 style 属性。
 * @param node
 * @returns
 * @example
 * <div style="background: url('image.jpg'); color: red;"></div>
 * 
 * {
    attr: {
      name: "style",
      value: "background: url('image.jpg'); color: red;"
    },
    location: {
      start: { line: 1, col: 6 },
      end: { line: 1, col: 50 }
    }
  }
 */
export function findNeedTransformStyleAttribute(
  node: DefaultTreeAdapterMap["element"]
): { attr: Token.Attribute; location?: Token.Location } | undefined {
  const attr = node.attrs.find(
    (prop) =>
      // 属性没有前缀
      prop.prefix === undefined &&
      // 属性名称为 style
      prop.name === "style" &&
      // 属性值包含 url( 或者 image-set(
      // only url(...) or image-set(...) in css need to emit file
      (prop.value.includes("url(") || prop.value.includes("image-set("))
  );

  // 没有找到符合条件的 style 属性，返回 undefined
  if (!attr) return undefined;

  const location = node.sourceCodeLocation?.attrs?.["style"];
  return { attr, location };
}

/**
 * 得到属性的key
 * @param attr
 * @returns
 */
export function getAttrKey(attr: Token.Attribute): string {
  // 有前缀则拼接上前缀，没有则直接返回name
  return attr.prefix === undefined ? attr.name : `${attr.prefix}:${attr.name}`;
}

/**
 * 函数用于提取脚本元素的信息，
   包括 src 属性、src 属性的位置、是否是模块脚本和是否是异步脚本
 * @param node
 * @returns
 * @example
 * <script src="main.js" type="module" async></script>
 * 
 * {
    src: { name: "src", value: "main.js" },
    sourceCodeLocation: {
      start: { line: 1, col: 8 },
      end: { line: 1, col: 21 }
    },
    isModule: true,
    isAsync: true
  }
 */
export function getScriptInfo(node: DefaultTreeAdapterMap["element"]): {
  src: Token.Attribute | undefined; //属性对象
  sourceCodeLocation: Token.Location | undefined; //属性的位置
  isModule: boolean; //是否是模块脚本
  isAsync: boolean; //是否是异步脚本
} {
  let src: Token.Attribute | undefined;
  let sourceCodeLocation: Token.Location | undefined;
  let isModule = false;
  let isAsync = false;

  // 遍历节点的属性
  for (const p of node.attrs) {
    if (p.prefix !== undefined) continue;
    if (p.name === "src") {
      if (!src) {
        // 设置 src 为当前属性,并获取其位置 sourceCodeLocation
        src = p;
        sourceCodeLocation = node.sourceCodeLocation?.attrs!["src"];
      }
    } else if (p.name === "type" && p.value && p.value === "module") {
      isModule = true;
    } else if (p.name === "async") {
      isAsync = true;
    }
  }

  // 返回结果对象
  return { src, sourceCodeLocation, isModule, isAsync };
}

/**
 * 用于支持在 HTML 文件中使用 %ENV_NAME% 语法来替换环境变量
 * @example
 * <div>%APP_TITLE%</div>
    <div>%NOT_DEFINED_ENV%</div>

    以下是环境变量配置
    const config = {
      envPrefix: 'VITE_',
      env: {
        APP_TITLE: 'My App'
      },
      define: {
        'import.meta.env.API_URL': '"https://api.example.com"'
      },
      root: '/path/to/project',
      logger: {
        warn: console.warn
      }
    };

    转换后的结果为

    <div>My App</div>
    <div>%NOT_DEFINED_ENV%</div>
 */
export function htmlEnvHook(config: ResolvedConfig): IndexHtmlTransformHook {
  // 用于匹配 %ENV_NAME% 语法的环境变量
  const pattern = /%(\S+?)%/g;
  // 环境变量的前缀
  const envPrefix = resolveEnvPrefix({ envPrefix: config.envPrefix });
  // 一个环境变量的副本,包含 config.env 中的所有变量
  const env: Record<string, any> = { ...config.env };

  // 处理用户定义的环境变量
  for (const key in config.define) {
    if (key.startsWith(`import.meta.env.`)) {
      // 如果键以 import.meta.env. 开头，则表示是用户定义的环境变量
      const val = config.define[key];

      // 值是字符串类型，尝试将其解析为 JSON，如果解析成功且结果是字符串类型，直接使用解析后的值；否则，使用原始值
      // key.slice(16) 的作用是 键名去掉 import.meta.env. 前缀
      if (typeof val === "string") {
        try {
          const parsed = JSON.parse(val);
          env[key.slice(16)] = typeof parsed === "string" ? parsed : val;
        } catch {
          env[key.slice(16)] = val;
        }
      } else {
        // 如果值不是字符串类型，则将其转换为 JSON 字符串
        env[key.slice(16)] = JSON.stringify(val);
      }
    }
  }

  // 返回钩子函数，处理 HTML 内容中的 %ENV_NAME% 语法：
  return (html, ctx) => {
    // 使用正则表达式 pattern 替换 HTML 内容中的 %ENV_NAME% 语法
    return html.replace(pattern, (text, key) => {
      if (key in env) {
        // 如果 key 在 env 对象中，替换为对应的环境变量值
        return env[key];
      } else {
        // 检查其前缀是否在 envPrefix 中，如果在，则记录一个警告日志，提示环境变量未定义
        if (envPrefix.some((prefix) => key.startsWith(prefix))) {
          const relativeHtml = normalizePath(
            path.relative(config.root, ctx.filename)
          );
          config.logger.warn(
            colors.yellow(
              colors.bold(
                `(!) ${text} is not defined in env variables found in /${relativeHtml}. ` +
                  `Is the variable mistyped?`
              )
            )
          );
        }

        // 如果未找到对应的环境变量，保留原始的 %ENV_NAME% 语法
        return text;
      }
    });
  };
}

/**
 * 用于在 HTML 文件中插入 CSP (内容安全策略) 的 nonce 元素
 * 通过这个函数，可以确保生成的 HTML 文件符合内容安全策略要求，增强安全性
 * @param config
 * @returns
 * @example
 * const config = {
    html: {
      cspNonce: "abc123"
    }
  };

  钩子函数将插入以下 meta 标签到 HTML 的 <head> 部分：
  <meta property="csp-nonce" nonce="abc123">
 */
export function injectCspNonceMetaTagHook(
  config: ResolvedConfig
): IndexHtmlTransformHook {
  return () => {
    // 检查配置是否包含 CSP nonce：
    if (!config.html?.cspNonce) return;

    // 返回钩子函数，插入 CSP nonce 元素
    return [
      {
        tag: "meta",
        injectTo: "head",
        // use nonce attribute so that it's hidden
        // https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/nonce#accessing_nonces_and_nonce_hiding
        attrs: { property: "csp-nonce", nonce: config.html.cspNonce },
      },
    ];
  };
}

/**
 * 用于在 HTML 文件中的特定标签上插入 nonce 属性，以支持内容安全策略 (CSP)
 * @param config
 * @returns
 */
export function injectNonceAttributeTagHook(
  config: ResolvedConfig
): IndexHtmlTransformHook {
  // 定义要处理的 rel 类型集合
  const processRelType = new Set(["stylesheet", "modulepreload", "preload"]);

  // 返回钩子函数，插入 nonce 属性
  return async (html, { filename }) => {
    const nonce = config.html?.cspNonce;
    if (!nonce) return;

    // 创建一个 MagicString 实例，用于高效地处理字符串操作
    const s = new MagicString(html);

    await traverseHtml(html, filename, (node) => {
      // 如果节点不是元素节点，跳过处理
      if (!nodeIsElement(node)) {
        return;
      }

      // 获取节点的名称、属性 和源代码位置
      const { nodeName, attrs, sourceCodeLocation } = node;

      if (
        nodeName === "script" ||
        nodeName === "style" ||
        (nodeName === "link" &&
          attrs.some(
            (attr) =>
              attr.name === "rel" &&
              parseRelAttr(attr.value).some((a) => processRelType.has(a))
          ))
      ) {
        // 如果属性中已经存在 nonce，则跳过处理
        if (attrs.some(({ name }) => name === "nonce")) {
          return;
        }

        // 获取开始标签的结束偏移量
        const startTagEndOffset = sourceCodeLocation!.startTag!.endOffset;

        // 如果开始标签的结束包含 /，则偏移量应为 2，否则为 1
        const appendOffset = html[startTagEndOffset - 2] === "/" ? 2 : 1;

        // 在正确的位置插入 nonce 属性
        s.appendRight(startTagEndOffset - appendOffset, ` nonce="${nonce}"`);
      }
    });

    // 返回处理后的 HTML 字符串
    return s.toString();
  };
}

export function nodeIsElement(
  node: DefaultTreeAdapterMap["node"]
): node is DefaultTreeAdapterMap["element"] {
  return node.nodeName[0] !== "#";
}

/**
 * 用于遍历解析树中的节点(ast)，并对每个节点应用访问者提供的回调函数
 * @param node
 * @param visitor
 */
function traverseNodes(
  node: DefaultTreeAdapterMap["node"],
  visitor: (node: DefaultTreeAdapterMap["node"]) => void
) {
  // 将传入的 node 节点作为参数调用 visitor 访问者函数，即对当前节点进行处理
  visitor(node);
  if (
    // 检查当前节点是否是元素节点
    nodeIsElement(node) ||
    // 检查当前节点是否是文档节点
    node.nodeName === "#document" ||
    // 检查当前节点是否是文档片段节点
    node.nodeName === "#document-fragment"
  ) {
    // 遍历当前节点的子节点 childNodes，对每个子节点递归调用 traverseNodes 函数，继续应用相同的 visitor 访问者函数
    node.childNodes.forEach((childNode) => traverseNodes(childNode, visitor));
  }
}

const attrValueStartRE = /=\s*(.)/;

/**
 * 用于覆盖 HTML 标签的属性值
 * @param s
 * @param sourceCodeLocation
 * @param newValue
 * @returns
 */
export function overwriteAttrValue(
  s: MagicString,
  sourceCodeLocation: Token.Location,
  newValue: string
): MagicString {
  // 获取属性值的源字符串
  const srcString = s.slice(
    sourceCodeLocation.startOffset,
    sourceCodeLocation.endOffset
  );

  // 匹配属性值的开始位置
  const valueStart = srcString.match(attrValueStartRE);
  if (!valueStart) {
    // overwrite attr value can only be called for a well-defined value
    throw new Error(
      `[vite:html] internal error, failed to overwrite attribute value`
    );
  }

  // 计算包装偏移量
  // 判断属性值的包裹字符（引号或单引号），如果是引号或单引号，包装偏移量为 1，否则为 0
  const wrapOffset = valueStart[1] === '"' || valueStart[1] === "'" ? 1 : 0;
  // 计算属性值的偏移量
  const valueOffset = valueStart.index! + valueStart[0].length - 1;

  // 更新属性值
  s.update(
    sourceCodeLocation.startOffset + valueOffset + wrapOffset,
    sourceCodeLocation.endOffset - wrapOffset,
    newValue
  );

  /**
   * @example
   * <a href="https://example.com">Example</a>
   * 
   * 我们希望将 href 属性值从 https://example.com 改为 https://vitejs.dev
   * 
   * const sourceCodeLocation = {
      startOffset: 3,
      endOffset: 27
    }; // 假设我们已经知道了 href 属性的开始和结束偏移量
    const newValue = "https://vitejs.dev";

    overwriteAttrValue(s, sourceCodeLocation, newValue);
    console.log(s.toString()); // 输出：<a href="https://vitejs.dev">Example</a>
   */
  return s;
}

/**
 * 用于在 HTML 文件中处理导入映射（import map）相关的内容
 */
export function postImportMapHook(): IndexHtmlTransformHook {
  return (html) => {
    // 是否包含需要追加导入映射的内容。如果不包含，则直接返回原始的
    if (!importMapAppendRE.test(html)) return;

    let importMap: string | undefined;

    // 提取并移除原始的导入映射内容
    html = html.replace(importMapRE, (match) => {
      importMap = match;

      // 同时将匹配到的内容替换为空字符串，以移除原始的导入映射内容
      return "";
    });

    // 将提取的导入映射内容插入到最后的位置
    if (importMap) {
      html = html.replace(
        importMapAppendRE,
        (match) => `${importMap}\n${match}`
      );
    }

    return html;
  };
}

/**
 * 用于检测 HTML 中导入映射 (<script type="importmap">) 的位置是否正确，
 * 如果不正确则输出警告信息
 * @param config
 * @returns
 */
export function preImportMapHook(
  config: ResolvedConfig
): IndexHtmlTransformHook {
  return (html, ctx) => {
    const importMapIndex = html.search(importMapRE);
    if (importMapIndex < 0) return;

    const importMapAppendIndex = html.search(importMapAppendRE);
    if (importMapAppendIndex < 0) return;

    if (importMapAppendIndex < importMapIndex) {
      const relativeHtml = normalizePath(
        path.relative(config.root, ctx.filename)
      );
      config.logger.warnOnce(
        colors.yellow(
          colors.bold(
            `(!) <script type="importmap"> should come before <script type="module"> and <link rel="modulepreload"> in /${relativeHtml}`
          )
        )
      );
    }
  };
}

/**
 * 用于解析插件数组中的 HTML 转换钩子，
 * 并根据它们的顺序属性将它们分类为预处理钩子、普通钩子和后处理钩子
 * @param plugins
 * @param logger
 * @returns
 */
export function resolveHtmlTransforms(
  plugins: readonly Plugin[],
  logger: Logger
): [
  IndexHtmlTransformHook[],
  IndexHtmlTransformHook[],
  IndexHtmlTransformHook[]
] {
  const preHooks: IndexHtmlTransformHook[] = [];
  const normalHooks: IndexHtmlTransformHook[] = [];
  const postHooks: IndexHtmlTransformHook[] = [];

  // 遍历每个插件
  for (const plugin of plugins) {
    // 获取其 transformIndexHtml 方法作为钩子
    const hook = plugin.transformIndexHtml;
    if (!hook) continue;

    if (typeof hook === "function") {
      normalHooks.push(hook);
    } else {
      // 检查钩子是否包含了已废弃的属性 enforce 和 transform
      if (!("order" in hook) && "enforce" in hook) {
        // 输出警告信息，因为使用了已废弃的 'enforce' 选项
        logger.warnOnce(
          colors.yellow(
            `plugin '${plugin.name}' uses deprecated 'enforce' option. Use 'order' option instead.`
          )
        );
      }
      if (!("handler" in hook) && "transform" in hook) {
        // 输出警告信息，因为使用了已废弃的 'transform' 选项
        logger.warnOnce(
          colors.yellow(
            `plugin '${plugin.name}' uses deprecated 'transform' option. Use 'handler' option instead.`
          )
        );
      }

      // `enforce` had only two possible values for the `transformIndexHtml` hook
      // `'pre'` and `'post'` (the default). `order` now works with three values
      // to align with other hooks (`'pre'`, normal, and `'post'`). We map
      // both `enforce: 'post'` to `order: undefined` to avoid a breaking change

      /**
       * 在以前的实现中，transformIndexHtml 钩子的 enforce 属性仅支持两个可能的值：'pre' 和 'post'（默认值）
       *
       * order 属性的引入:为了与其他钩子保持一致，现在 transformIndexHtml 钩子的 order 属性支持三个可能的值：'pre'、undefined 和 'post'
       * 为了避免破坏现有代码，如果插件使用了 enforce: 'post'，将其映射到新的 order: undefined
       * 这样做可以确保现有插件在升级到新版本时仍能正常工作，而不需要进行大规模的代码更改。
       *
       */

      // 根据 order 属性的值将钩子分类到 preHooks（预处理）、postHooks（后处理）或 normalHooks（普通）数组中
      const order = hook.order ?? (hook.enforce === "pre" ? "pre" : undefined);
      // @ts-expect-error union type
      const handler = hook.handler ?? hook.transform;
      if (order === "pre") {
        preHooks.push(handler);
      } else if (order === "post") {
        postHooks.push(handler);
      } else {
        normalHooks.push(handler);
      }
    }
  }

  return [preHooks, normalHooks, postHooks];
}

/**
 * 用于遍历 HTML，并对每个节点应用访问者提供的回调函数
 */
export async function traverseHtml(
  html: string,
  filePath: string,
  visitor: (node: DefaultTreeAdapterMap["node"]) => void
): Promise<void> {
  // 动态加载 parse5 模块,确保只在需要时加载解析器，而不是在模块加载时立即加载
  const { parse } = await import("parse5");
  const ast = parse(html, {
    scriptingEnabled: false, // 禁用脚本解析
    sourceCodeLocationInfo: true, // 开启源码位置信息
    onParseError: (e: ParserError) => {
      // 在解析错误时调用的回调函数，用于处理解析错误
      handleParseError(e, html, filePath);
    },
  });
  // 遍历节点并应用访问者函数
  traverseNodes(ast, visitor);
}

export interface HtmlTagDescriptor {
  tag: string;
  attrs?: Record<string, string | boolean | undefined>;
  children?: string | HtmlTagDescriptor[];
  /**
   * default: 'head-prepend'
   */
  injectTo?: "head" | "body" | "head-prepend" | "body-prepend";
}

export type IndexHtmlTransformResult =
  | string
  | HtmlTagDescriptor[]
  | {
      html: string;
      tags: HtmlTagDescriptor[];
    };

export interface IndexHtmlTransformContext {
  /**
   * public path when served
   */
  path: string;
  /**
   * filename on disk
   */
  filename: string;
  server?: ViteDevServer;
  bundle?: OutputBundle;
  chunk?: OutputChunk;
  originalUrl?: string;
}

export type IndexHtmlTransformHook = (
  this: void,
  html: string,
  ctx: IndexHtmlTransformContext
) => IndexHtmlTransformResult | void | Promise<IndexHtmlTransformResult | void>;

const elementsAllowedInHead = new Set([
  "title",
  "base",
  "link",
  "style",
  "meta",
  "script",
  "noscript",
  "template",
]);

/**
 * 用于检查要插入 <head> 标签的标签描述符数组 tags 中是否包含不允许在 <head> 中使用的标签
 * @param tags
 * @param ctx
 * @returns
 */
function headTagInsertCheck(
  tags: HtmlTagDescriptor[],
  ctx: IndexHtmlTransformContext
) {
  if (!tags.length) return;
  const { logger } = ctx.server?.config || {};

  // 过滤出不允许在 <head> 中使用的标签
  const disallowedTags = tags.filter(
    (tagDescriptor) => !elementsAllowedInHead.has(tagDescriptor.tag)
  );

  if (disallowedTags.length) {
    // 将标签名连接成字符串，并通过 logger 发出警告，提醒用户检查插入位置。
    const dedupedTags = unique(
      disallowedTags.map((tagDescriptor) => `<${tagDescriptor.tag}>`)
    );
    logger?.warn(
      colors.yellow(
        colors.bold(
          `[${dedupedTags.join(
            ","
          )}] can not be used inside the <head> Element, please check the 'injectTo' value`
        )
      )
    );
  }
}

const headInjectRE = /([ \t]*)<\/head>/i;
const headPrependInjectRE = /([ \t]*)<head[^>]*>/i;

const htmlInjectRE = /<\/html>/i;
const htmlPrependInjectRE = /([ \t]*)<html[^>]*>/i;

const bodyInjectRE = /([ \t]*)<\/body>/i;
const bodyPrependInjectRE = /([ \t]*)<body[^>]*>/i;

const doctypePrependInjectRE = /<!doctype html>/i;

/**
 * 主要负责向 HTML 文档的 <head>  中注入标签。
 * 支持在 <head> 的开头或末尾插入标签，或者在没有 <head> 标签时进行兜底操作
 * @param html
 * @param tags
 * @param prepend
 * @returns
 */
function injectToHead(
  html: string,
  tags: HtmlTagDescriptor[],
  prepend = false
) {
  if (tags.length === 0) return html;

  if (prepend) {
    // 如果在 head 前插入
    if (headPrependInjectRE.test(html)) {
      return html.replace(
        headPrependInjectRE,
        (match, p1) => `${match}\n${serializeTags(tags, incrementIndent(p1))}`
      );
    }
  } else {
    // 如果在 head 末尾插入
    if (headInjectRE.test(html)) {
      return html.replace(
        headInjectRE,
        (match, p1) => `${serializeTags(tags, incrementIndent(p1))}${match}`
      );
    }
    // 尝试在 body 前插入
    if (bodyPrependInjectRE.test(html)) {
      return html.replace(
        bodyPrependInjectRE,
        (match, p1) => `${serializeTags(tags, p1)}\n${match}`
      );
    }
  }
  // 如果没有 head 标签存在，则在前后都插入标签
  return prependInjectFallback(html, tags);
}

/**
 * 主要负责向 HTML 文档的 <body> 中注入标签。
 * @param html
 * @param tags
 * @param prepend
 * @returns
 */
function injectToBody(
  html: string,
  tags: HtmlTagDescriptor[],
  prepend = false
) {
  if (tags.length === 0) return html;

  if (prepend) {
    // 如果在 body 开头插入
    if (bodyPrependInjectRE.test(html)) {
      return html.replace(
        bodyPrependInjectRE,
        (match, p1) => `${match}\n${serializeTags(tags, incrementIndent(p1))}`
      );
    }
    // 如果没有 body 标签，则在 head 后插入
    if (headInjectRE.test(html)) {
      return html.replace(
        headInjectRE,
        (match, p1) => `${match}\n${serializeTags(tags, p1)}`
      );
    }
    return prependInjectFallback(html, tags);
  } else {
    // 如果在 body 结尾插入
    if (bodyInjectRE.test(html)) {
      return html.replace(
        bodyInjectRE,
        (match, p1) => `${serializeTags(tags, incrementIndent(p1))}${match}`
      );
    }
    // 如果没有 body 标签，则在 html 标签后插入
    if (htmlInjectRE.test(html)) {
      return html.replace(htmlInjectRE, `${serializeTags(tags)}\n$&`);
    }

    // 否则直接在 html 末尾插入
    return html + `\n` + serializeTags(tags);
  }
}

// 自闭合标签
const unaryTags = new Set(["link", "meta", "base"]);

/**
 * 将单个 HtmlTagDescriptor 对象序列化为对应的 HTML 标签字符串
 * @param param0
 * @param indent
 * @returns
 */
function serializeTag(
  { tag, attrs, children }: HtmlTagDescriptor,
  indent: string = ""
): string {
  if (unaryTags.has(tag)) {
    return `<${tag}${serializeAttrs(attrs)}>`;
  } else {
    // 如果标签有子元素，则递归地将子元素序列化后嵌入到标签内部
    return `<${tag}${serializeAttrs(attrs)}>${serializeTags(
      children,
      incrementIndent(indent)
    )}</${tag}>`;
  }
}

/**
 * 用于将标签的属性对象转换为 HTML 属性字符串形式
 * @param attrs
 * @returns
 */
function serializeAttrs(attrs: HtmlTagDescriptor["attrs"]): string {
  let res = "";
  for (const key in attrs) {
    // 根据属性值的类型决定是否输出值的 JSON 字符串形式
    if (typeof attrs[key] === "boolean") {
      res += attrs[key] ? ` ${key}` : ``;
    } else {
      res += ` ${key}=${JSON.stringify(attrs[key])}`;
    }
  }
  return res;
}

/**
 * 用于将标签描述符数组转换为一组 HTML 标签字符串
 * @param tags
 * @param indent
 * @returns
 */
function serializeTags(
  tags: HtmlTagDescriptor["children"],
  indent: string = ""
): string {
  if (typeof tags === "string") {
    return tags;
  } else if (tags && tags.length) {
    // 逐个序列化每个标签描述符，并用指定的缩进格式化输出
    return tags
      .map((tag) => `${indent}${serializeTag(tag, indent)}\n`)
      .join("");
  }
  return "";
}

/**
 * 用于在 HTML 文档中找不到 <head> 或 <body> 标签时，
 * 将标签序列添加到文档的开头位置或者在文档的 <html> 标签之后
 *
 * 主要是做兜底操作
 */
function prependInjectFallback(html: string, tags: HtmlTagDescriptor[]) {
  if (htmlPrependInjectRE.test(html)) {
    return html.replace(htmlPrependInjectRE, `$&\n${serializeTags(tags)}`);
  }
  if (doctypePrependInjectRE.test(html)) {
    return html.replace(doctypePrependInjectRE, `$&\n${serializeTags(tags)}`);
  }

  // 如果没有找到任何匹配点，则直接将标签序列添加到 HTML 文档的开头位置
  return serializeTags(tags) + html;
}

function incrementIndent(indent: string = "") {
  return `${indent}${indent[0] === "\t" ? "\t" : "  "}`;
}

export function parseRelAttr(attr: string): string[] {
  return attr.split(spaceRe).map((v) => v.toLowerCase());
}

function handleParseError(
  parserError: ParserError,
  html: string,
  filePath: string
) {
  switch (parserError.code) {
    case "missing-doctype":
      // ignore missing DOCTYPE
      return;
    case "abandoned-head-element-child":
      // Accept elements without closing tag in <head>
      return;
    case "duplicate-attribute":
      // Accept duplicate attributes #9566
      // The first attribute is used, browsers silently ignore duplicates
      return;
    case "non-void-html-element-start-tag-with-trailing-solidus":
      // Allow self closing on non-void elements #10439
      return;
  }

  // const parseError = formatParseError(parserError, filePath, html);
  // throw new Error(
  //   `Unable to parse HTML; ${parseError.message}\n` +
  //     ` at ${parseError.loc.file}:${parseError.loc.line}:${parseError.loc.column}\n` +
  //     `${parseError.frame}`
  // );
}

/**
 * Format parse5 @type {ParserError} to @type {RollupError}
 */
function formatParseError(parserError: ParserError, id: string, html: string) {
  const formattedError = {
    code: parserError.code,
    message: `parse5 error code ${parserError.code}`,
    frame: generateCodeFrame(
      html,
      parserError.startOffset,
      parserError.endOffset
    ),
    loc: {
      file: id,
      line: parserError.startLine,
      column: parserError.startCol,
    },
  } satisfies RollupError;
  return formattedError;
}
