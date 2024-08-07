import path, { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url)).toString()
);

export const VERSION = version as string;

export const DEFAULT_MAIN_FIELDS = [
  "browser",
  "module",
  "jsnext:main", // moment still uses this...
  "jsnext",
];

export const ESBUILD_MODULES_TARGET = [
  "es2020", // support import.meta.url
  "edge88",
  "firefox78",
  "chrome87",
  "safari14",
];

export const DEFAULT_EXTENSIONS = [
  ".mjs",
  ".js",
  ".mts",
  ".ts",
  ".jsx",
  ".tsx",
  ".json",
];

export const DEFAULT_CONFIG_FILES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
];

/**
 * 用于匹配特定的文件扩展名 (.js .mjs .cjs .ts .mts .cts)
 * 这个正则表达式通常用于检测文件路径，以确定是否应对这些文件进行某些优化处理，
 * 比如在构建工具中使用的代码分割和预处理
 */
export const OPTIMIZABLE_ENTRY_RE = /\.[cm]?[jt]s$/;

/**
 * 用于匹配 URL 查询参数中包含特定关键字的情况，包含 worker、sharedworker、raw 或 url 关键字的查询参数
 * 这个正则表达式通常用于解析 URL，以便识别出带有特定查询参数的请求
 * 可以根据这些查询参数执行特定的操作，如处理 Web Worker、原始文件或 URL 资源等
 * vite 天生支持导入 import txt from './a.txt?raw' 这种 就是通过这个正在匹配到之后做处理
 */
export const SPECIAL_QUERY_RE = /[?&](?:worker|sharedworker|raw|url)\b/;

/**匹配 js、jsx、ts、tsx、.mjs结尾的 */
export const JS_TYPES_RE = /\.(?:j|t)sx?$|\.mjs$/;

//css 类型
export const CSS_LANGS_RE =
  /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

export const VITE_PACKAGE_DIR = resolve(
  // import.meta.url is `dist/node/constants.js` after bundle
  fileURLToPath(import.meta.url),
  "../../.."
);

export const CLIENT_ENTRY = resolve(VITE_PACKAGE_DIR, "dist/client/client.mjs");
export const ENV_ENTRY = resolve(VITE_PACKAGE_DIR, "dist/client/env.mjs");
export const CLIENT_DIR = path.dirname(CLIENT_ENTRY);

/**
 * 在处理文件系统路径时，特别是在跨平台应用程序中，Windows 的文件路径可能不适合用作 URL。
 * 因此，需要一个前缀来标识和转换这些路径，以确保它们可以在 Web 环境中正确使用。
 */
export const FS_PREFIX = `/@fs/`;

export const ENV_PUBLIC_PATH = `/@vite/env`;
export const CLIENT_PUBLIC_PATH = `/@vite/client`;

export const DEFAULT_DEV_PORT = 5173;

export const DEFAULT_PREVIEW_PORT = 4173;

export const DEFAULT_ASSETS_INLINE_LIMIT = 4096;

//   中的 registerCustomMime 函数中添加相应的 MIME 类型。
/**
 *  提醒开发者在编辑 KNOWN_ASSET_TYPES 前需要注意几点：
 *  1. 如果你在 KNOWN_ASSET_TYPES 中添加了一个新的资源类型，确保同时在 TypeScript
 *  声明文件 packages/vite/client.d.ts 中也进行了添加。
 *
 *  2. 如果某个资源的 MIME 类型无法通过 mrmime 查找到，还需要在 packages/vite/src/node/plugin/assets.ts
 *  中的 registerCustomMime 函数中添加相应的 MIME 类型。
 */
export const KNOWN_ASSET_TYPES = [
  // images
  "apng",
  "png",
  "jpe?g",
  "jfif",
  "pjpeg",
  "pjp",
  "gif",
  "svg",
  "ico",
  "webp",
  "avif",

  // media
  "mp4",
  "webm",
  "ogg",
  "mp3",
  "wav",
  "flac",
  "aac",
  "opus",
  "mov",
  "m4a",
  "vtt",

  // fonts
  "woff2?",
  "eot",
  "ttf",
  "otf",

  // other
  "webmanifest",
  "pdf",
  "txt",
];

export const DEFAULT_ASSETS_RE = new RegExp(
  `\\.(` + KNOWN_ASSET_TYPES.join("|") + `)(\\?.*)?$`
);

export const loopbackHosts = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0000:0000:0000:0000:0000:0000:0000:0001",
]);
export const wildcardHosts = new Set([
  "0.0.0.0",
  "::",
  "0000:0000:0000:0000:0000:0000:0000:0000",
]);

export const DEP_VERSION_RE = /[?&](v=[\w.-]+)\b/;

export const METADATA_FILENAME = "_metadata.json";
