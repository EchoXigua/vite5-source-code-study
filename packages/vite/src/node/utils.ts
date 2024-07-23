import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { URL, fileURLToPath } from "node:url";
import { builtinModules, createRequire } from "node:module";
import fsp from "node:fs/promises";
import type { AddressInfo, Server } from "node:net";
import { promises as dns } from "node:dns";
import debug from "debug";
import colors from "picocolors";
import type { FSWatcher } from "chokidar";
import remapping from "@ampproject/remapping";
import type { DecodedSourceMap, RawSourceMap } from "@ampproject/remapping";
import type MagicString from "magic-string";
import { createFilter as _createFilter } from "@rollup/pluginutils";
import type { Alias, AliasOptions } from "dep-types/alias";
import type { TransformResult } from "rollup";

import { cleanUrl, isWindows, slash, withTrailingSlash } from "../shared/utils";
import {
  type PackageCache,
  findNearestPackageData,
  resolvePackageData,
} from "./packages";
import type { CommonServerOptions } from ".";
import type { ResolvedConfig } from "./config";
import type { ResolvedServerUrls, ViteDevServer } from "./server";
import { VALID_ID_PREFIX } from "../shared/constants";
import {
  CLIENT_ENTRY,
  CLIENT_PUBLIC_PATH,
  ENV_PUBLIC_PATH,
  FS_PREFIX,
  OPTIMIZABLE_ENTRY_RE,
  loopbackHosts,
  wildcardHosts,
} from "./constants";
import type { DepOptimizationConfig } from "./optimizer";

import type { PreviewServer } from "./preview";

/**
 * 用于匹配所谓的“裸导入”，即没有相对或绝对路径前缀的模块导入。
 *
 * (?![a-zA-Z]:)  负向前瞻，确保字符串不以驱动器号（如 C: 或 D:）开头。这通常用于排除 Windows 文件路径
 * [\w@]   匹配一个单词字符（字母、数字或下划线）或 @ 符号
 * (?!.*:\/\/)   负向前瞻，确保字符串中不包含 ://（用于排除完整的 URL，如 http:// 或 https://）
 *  * @example
 * 匹配 react lodash @babel/core
 * 不匹配 ./utils C:/path/to/module  http://example.com/module
 */
export const bareImportRE = /^(?![a-zA-Z]:)[\w@](?!.*:\/\/)/;

/**
 * 用于检测深度导入，即模块内部的子路径导入
 *
 * @example
 * ([^@][^/]*)\/  匹配不以 @ 开头并且不包含 / 的字符串后跟一个 /
 * 例如，匹配 lodash/es 中的 lodash/
 *
 * (@[^/]+\/[^/]+)\/  匹配以 @ 开头的作用域包，且后面有两个路径段。
 * 例如，匹配 @babel/core/lib 中的 @babel/core/
 */
export const deepImportRE = /^([^@][^/]*)\/|^(@[^/]+\/[^/]+)\//;

/**
 * Inlined to keep `@rollup/pluginutils` in devDependencies
 */
export type FilterPattern =
  | ReadonlyArray<string | RegExp>
  | string
  | RegExp
  | null;
export const createFilter = _createFilter as (
  include?: FilterPattern,
  exclude?: FilterPattern,
  options?: { resolve?: string | false | null }
) => (id: string | unknown) => boolean;

export function isObject(value: unknown): value is Record<string, any> {
  return Object.prototype.toString.call(value) === "[object Object]";
}
export function arraify<T>(target: T | T[]): T[] {
  return Array.isArray(target) ? target : [target];
}

//对包含异步任务的嵌套数组进行展平操作，并确保所有异步任务都已完成
export async function asyncFlatten<T>(arr: T[]): Promise<T[]> {
  do {
    //对传入的数组进行 Promise.all 操作，等待所有异步任务完成，
    //然后使用 flat(Infinity) 方法对数组进行无限深度展平
    //此时展开后的数组，可能还有promise，需要通过检查arr 里面是否还有promise
    //如果有通过await promise.all 将数组中的异步任务完成
    arr = (await Promise.all(arr)).flat(Infinity) as any;
  } while (arr.some((v: any) => v?.then));
  //some 方法检查数组中是否仍有未完成的 Promise
  //如果某个值 v 有 then 方法（即它是一个 Promise），则继续循环
  //在 do...while 循环中，不断对数组进行 Promise.all 和 flat 操作，直到数组中不再包含任何未完成的 Promise。

  return arr;
  /**
   * demo：
   * const nestedPromises = [
      Promise.resolve([1, 2, Promise.resolve([3, 4, Promise.resolve(5)])]),
      6,
      [7, Promise.resolve(8)]
    ];

    asyncFlatten(nestedPromises).then(flattened => {
      console.log(flattened); // 输出: [1, 2, 3, 4, 5, 6, 7, 8]
    });
   */
}

/**
 * 将路径转换为 POSIX 规范化格式，以确保路径在不同操作系统上具有一致的表示形式。
 * 特别是，它会将 Windows 上的路径转换为使用斜杠 (/) 的形式。
 * 
 *
 * @param id
 * @returns
 * 
 * @example
 *  windows:
 *  const path = 'C:\\Users\\John\\Documents\\project';
    console.log(normalizePath(path));  //输出: 'C:/Users/John/Documents/project'

    非windows:
    const path = '/Users/John/Documents/project';
    console.log(normalizePath(path)); //输出: '/Users/John/Documents/project'
 * 
 * 
 */
export function normalizePath(id: string): string {
  return path.posix.normalize(isWindows ? slash(id) : id);
}

/**匹配斜杠 / 或冒号 : */
const replaceSlashOrColonRE = /[/:]/g;
/**匹配点 . */
const replaceDotRE = /\./g;
/**
 * 匹配嵌套关系符号 > 及其周围的空白字符
 * 它匹配零个或多个空白字符（\s*），后跟一个 > 字符，再跟零个或多个空白字符（\s*）
 */
const replaceNestedIdRE = /(\s*>\s*)/g;
/**匹配井号 # */
const replaceHashRE = /#/g;

/**
 * 通过多次调用 replace 方法，将 ID 字符串中的特定字符替换为特定的字符串
 * @param id
 * @returns
 */
export const flattenId = (id: string): string => {
  const flatId = limitFlattenIdLength(
    id
      // / 或 : 替换为 _
      .replace(replaceSlashOrColonRE, "_")
      // . 替换为 __
      .replace(replaceDotRE, "__")
      // 嵌套关系符号 > 及其周围的空白字符替换为 ___
      .replace(replaceNestedIdRE, "___")
      // # 替换为 ____
      .replace(replaceHashRE, "____")
  );
  return flatId;
};

/**用于生成哈希值的长度 */
const FLATTEN_ID_HASH_LENGTH = 8;
/**扁平化 ID 的最大长度 */
const FLATTEN_ID_MAX_FILE_LENGTH = 170;
/**
 *
 * @param id
 * @param limit
 * @returns
 */
const limitFlattenIdLength = (
  id: string,
  limit: number = FLATTEN_ID_MAX_FILE_LENGTH
): string => {
  if (id.length <= limit) {
    return id;
  }
  // 截取 ID 的前 limit - (FLATTEN_ID_HASH_LENGTH + 1) 个字符，并在其后附加一个下划线 _ 和 ID 的哈希值
  return id.slice(0, limit - (FLATTEN_ID_HASH_LENGTH + 1)) + "_" + getHash(id);
};

/**
 * 将匹配 replaceNestedIdRE 正则表达式的部分替换为 " > "
 * @param id
 * @returns 返回一个规范化后的字符串
 * @example
 * console.log(normalizeId("div>span"));       // "div > span"
 * console.log(normalizeId("div > span"));     // "div > span"
 * console.log(normalizeId("div    >    span"));// "div > span"
 */
export const normalizeId = (id: string): string =>
  id.replace(replaceNestedIdRE, " > ");

//Node.js（Node, Deno, Bun） 支持的内置模块命名空间前缀为 node:
const NODE_BUILTIN_NAMESPACE = "node:";
//Deno 支持的内置模块命名空间，前缀为 npm:。
const NPM_BUILTIN_NAMESPACE = "npm:";
// Bun 支持的内置模块命名空间，前缀为 bun:。
const BUN_BUILTIN_NAMESPACE = "bun:";

// 有些运行时(如Bun)在这里注入了命名空间模块，这不是一个内置的节点,所以通过: 做过滤

//builtinModules: 这是一个数组，包含 Node.js 的所有内置模块名称，例如 fs、path 等。
//通过 .filter 方法过滤掉所有包含 : 的模块名称，这些模块名称被认为是带有命名空间的模块。
//Node.js 内置模块名称不包含 :，因此这一步是为了获取纯粹的 Node.js 内置模块列表
const nodeBuiltins = builtinModules.filter((id) => !id.includes(":"));

/**
 * 用于判断给定的模块 ID 是否是内置模块
 * 这里函数考虑了多种运行时环境（Node.js、Deno、Bun）中的内置模块命名空间
 * @param id
 * @returns
 */
export function isBuiltin(id: string): boolean {
  if (process.versions.deno && id.startsWith(NPM_BUILTIN_NAMESPACE))
    //当前运行环境是 Deno，是否以npm: 开头，
    return true;

  //示当前运行环境是 Bun，是否以bun: 开头
  if (process.versions.bun && id.startsWith(BUN_BUILTIN_NAMESPACE)) return true;

  //调用 isNodeBuiltin 函数判断 id 是否是一个 Node.js 内置模块。
  return isNodeBuiltin(id);
}

export function isNodeBuiltin(id: string): boolean {
  //如果以node: 开头，这是一个带命名空间的 Node.js 内置模块
  if (id.startsWith(NODE_BUILTIN_NAMESPACE)) return true;

  //检查 nodeBuiltins 数组是否包含 id。如果包含，则返回 true，表示这是一个 Node.js 原生内置模块。
  return nodeBuiltins.includes(id);
}

function mergeConfigRecursively(
  defaults: Record<string, any>,
  overrides: Record<string, any>,
  rootPath: string
) {
  const merged: Record<string, any> = { ...defaults };
  for (const key in overrides) {
    const value = overrides[key];
    if (value == null) {
      continue;
    }

    const existing = merged[key];

    if (existing == null) {
      merged[key] = value;
      continue;
    }

    // fields that require special handling
    if (key === "alias" && (rootPath === "resolve" || rootPath === "")) {
      merged[key] = mergeAlias(existing, value);
      continue;
    } else if (key === "assetsInclude" && rootPath === "") {
      merged[key] = [].concat(existing, value);
      continue;
    } else if (
      key === "noExternal" &&
      rootPath === "ssr" &&
      (existing === true || value === true)
    ) {
      merged[key] = true;
      continue;
    } else if (key === "plugins" && rootPath === "worker") {
      merged[key] = () => [
        ...backwardCompatibleWorkerPlugins(existing),
        ...backwardCompatibleWorkerPlugins(value),
      ];
      continue;
    }

    if (Array.isArray(existing) || Array.isArray(value)) {
      merged[key] = [...arraify(existing), ...arraify(value)];
      continue;
    }
    if (isObject(existing) && isObject(value)) {
      merged[key] = mergeConfigRecursively(
        existing,
        value,
        rootPath ? `${rootPath}.${key}` : key
      );
      continue;
    }

    merged[key] = value;
  }
  return merged;
}

export function mergeConfig<
  D extends Record<string, any>,
  O extends Record<string, any>
>(
  defaults: D extends Function ? never : D,
  overrides: O extends Function ? never : O,
  isRoot = true
): Record<string, any> {
  if (typeof defaults === "function" || typeof overrides === "function") {
    throw new Error(`Cannot merge config in form of callback`);
  }

  return mergeConfigRecursively(defaults, overrides, isRoot ? "" : ".");
}

function backwardCompatibleWorkerPlugins(plugins: any) {
  if (Array.isArray(plugins)) {
    return plugins;
  }
  if (typeof plugins === "function") {
    return plugins();
  }
  return [];
}

export function mergeAlias(
  a?: AliasOptions,
  b?: AliasOptions
): AliasOptions | undefined {
  if (!a) return b;
  if (!b) return a;
  if (isObject(a) && isObject(b)) {
    return { ...a, ...b };
  }
  //顺序颠倒是因为别名是从自顶向下解析的，后者应该具有更高的优先级
  return [...normalizeAlias(b), ...normalizeAlias(a)];
}
export function normalizeAlias(o: AliasOptions = []): Alias[] {
  return Array.isArray(o)
    ? o.map(normalizeSingleAlias)
    : Object.keys(o).map((find) =>
        normalizeSingleAlias({
          find,
          replacement: (o as any)[find],
        })
      );
}

/**
 * 用于处理单个别名配置，规范化其 find 和 replacement 属性，并返回一个新的 Alias 对象
 * 主要就是去掉末尾的 /
 * @param param0
 * @returns
 * 
 * @example 
 * const aliasConfig = {
    find: "@src/",
    replacement: "/src/",
  };

  调用后返回：
  {
    find: "@src",
    replacement: "/src",
  }
 */
function normalizeSingleAlias({
  find,
  replacement,
  customResolver,
}: Alias): Alias {
  //检查 find 和 replacement 是否都是以 / 结尾的字符串
  if (
    typeof find === "string" &&
    find[find.length - 1] === "/" &&
    replacement[replacement.length - 1] === "/"
  ) {
    //如果两者都以 / 结尾，去掉末尾的 /
    find = find.slice(0, find.length - 1);
    replacement = replacement.slice(0, replacement.length - 1);
  }

  //构建新的 Alias 对象
  const alias: Alias = {
    find,
    replacement,
  };
  if (customResolver) {
    alias.customResolver = customResolver;
  }
  return alias;
}

/**
 * 用于同步地获取文件或目录的状态信息。这个方法返回一个 fs.Stats 对象，
 * 其中包含有关文件或目录的详细信息，例如大小、创建时间、修改时间等
 *
 * @param file
 * @returns
 */
export function tryStatSync(file: string): fs.Stats | undefined {
  try {
    /**
     * throwIfNoEntry 为false 表示在文件或目录不存在时不抛出错误，而是返回 undefined。
     */
    return fs.statSync(file, { throwIfNoEntry: false });
  } catch {
    // Ignore errors
  }
}

/**匹配外部url （http、https） */
export const externalRE = /^(https?:)?\/\//;
export const isExternalUrl = (url: string): boolean => externalRE.test(url);

/**匹配 data url */
export const dataUrlRE = /^\s*data:/i;
export const isDataUrl = (url: string): boolean => dataUrlRE.test(url);

/** 匹配虚拟模块 */
export const virtualModuleRE = /^virtual-module:.*/;
/**虚拟模块前缀 */
export const virtualModulePrefix = "virtual-module:";

const _dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

//用于解析相对于指定根目录 (root) 的包模块 (id) 的路径
export const requireResolveFromRootWithFallback = (
  root: string,
  id: string
): string => {
  //首先检查是否存在，所以如果没有找到包，它不会被nodejs缓存，因为没有办法使它们无效
  // https://github.com/nodejs/node/issues/44663

  //它尝试使用 resolvePackageData 函数从两个不同的位置解析包
  const found =
    resolvePackageData(id, root) || resolvePackageData(id, _dirname);
  if (!found) {
    //如果包在任何位置都未找到 (!found)，则抛出错误，指示找不到该包 (id)。
    //错误的代码标记为模块未找到 (MODULE_NOT_FOUND)。
    const error = new Error(`${JSON.stringify(id)} not found.`);
    (error as any).code = "MODULE_NOT_FOUND";
    throw error;
  }

  //找到了包，开始解析包。
  //首先尝试从指定的 root 目录解析包 (root 在搜索路径数组中优先)。
  //如果在该位置找不到，则会回退到默认的 Node.js require 路径 (_dirname)。
  return _require.resolve(id, { paths: [root, _dirname] });
};

/**
 * 用于确定给定的文件路径是否是 ECMAScript 模块（ESM）
 *
 * @param filePath 要检查的文件路径。
 * @param packageCache 可选的包缓存，用于提高查找 package.json 文件的效率。
 * @returns
 */
export function isFilePathESM(
  filePath: string,
  packageCache?: PackageCache
): boolean {
  if (/\.m[jt]s$/.test(filePath)) {
    //如果文件扩展名是 .mjs 或 .mts，直接返回 true，表示这是一个 ESM 模块。
    return true;
  } else if (/\.c[jt]s$/.test(filePath)) {
    //如果文件扩展名是 .cjs 或 .cts，直接返回 false，表示这是一个 CommonJS 模块。
    return false;
  } else {
    //检查 package.json 中的 type: "module"
    try {
      const pkg = findNearestPackageData(path.dirname(filePath), packageCache);
      return pkg?.data.type === "module";
    } catch {
      return false;
    }
  }
}

//递归读取文件错误
export const ERR_SYMLINK_IN_RECURSIVE_READDIR =
  "ERR_SYMLINK_IN_RECURSIVE_READDIR";
export async function recursiveReaddir(dir: string): Promise<string[]> {
  if (!fs.existsSync(dir)) {
    return [];
  }
  let dirents: fs.Dirent[];
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "EACCES") {
      // Ignore permission errors
      return [];
    }
    throw e;
  }
  if (dirents.some((dirent) => dirent.isSymbolicLink())) {
    const err: any = new Error(
      "Symbolic links are not supported in recursiveReaddir"
    );
    err.code = ERR_SYMLINK_IN_RECURSIVE_READDIR;
    throw err;
  }
  const files = await Promise.all(
    dirents.map((dirent) => {
      const res = path.resolve(dir, dirent.name);
      return dirent.isDirectory() ? recursiveReaddir(res) : normalizePath(res);
    })
  );
  return files.flat(1);
}

/**
 * 用于匹配 URL 中的 import 查询参数部分
 * (\?|&)：匹配问号 ? 或者 &，表示查询参数的起始位置
 * import=?：匹配 import，后面可以有一个等号 =
 * (?:&|$)：非捕获分组，表示后面跟着 & 或者字符串的结尾 $
 */
const importQueryRE = /(\?|&)import=?(?:&|$)/;

//用来匹配 URL 中结尾的分隔符
///[?&]$/：匹配最后一个字符是 ? 或 & 的位置
//用于确保在移除 import 查询参数后，URL 的结尾没有多余的分隔符。
const trailingSeparatorRE = /[?&]$/;

//用于移除 URL 中的 import 查询参数以及可能的结尾分隔符（? 或 &）。
export function removeImportQuery(url: string): string {
  //$1 在 replace 方法中用于替换，表示保留匹配到的第一个捕获组（即 (\?|&)），移除 import 查询参数部分。
  return url.replace(importQueryRE, "$1").replace(trailingSeparatorRE, "");
}

/**
 * 用于匹配 URL 中的时间戳查询参数
 * \bt=：匹配 t=，确保 t 是一个单词边界（即其前面是非单词字符，后面是单词字符）。
 * \d{13}：匹配 13 位数字，即时间戳的长度
 * &?：匹配可选的 & 符号
 * \b：确保匹配到的部分是一个单词边界，避免匹配到更长的字符串。
 */
const timestampRE = /\bt=\d{13}&?\b/;
//用于移除 URL 中时间戳查询参数的函数
export function removeTimestampQuery(url: string): string {
  return url.replace(timestampRE, "").replace(trailingSeparatorRE, "");
}

export let safeRealpathSync = isWindows
  ? windowsSafeRealPathSync
  : fs.realpathSync.native;

const windowsNetworkMap = new Map();
function windowsMappedRealpathSync(path: string) {
  const realPath = fs.realpathSync.native(path);
  if (realPath.startsWith("\\\\")) {
    for (const [network, volume] of windowsNetworkMap) {
      if (realPath.startsWith(network))
        return realPath.replace(network, volume);
    }
  }
  return realPath;
}

const parseNetUseRE = /^(\w+)? +(\w:) +([^ ]+)\s/;
let firstSafeRealPathSyncRun = false;

function windowsSafeRealPathSync(path: string): string {
  if (!firstSafeRealPathSyncRun) {
    optimizeSafeRealPathSync();
    firstSafeRealPathSyncRun = true;
  }
  return fs.realpathSync(path);
}

function optimizeSafeRealPathSync() {
  // Skip if using Node <18.10 due to MAX_PATH issue: https://github.com/vitejs/vite/issues/12931
  const nodeVersion = process.versions.node.split(".").map(Number);
  if (nodeVersion[0] < 18 || (nodeVersion[0] === 18 && nodeVersion[1] < 10)) {
    safeRealpathSync = fs.realpathSync;
    return;
  }
  // Check the availability `fs.realpathSync.native`
  // in Windows virtual and RAM disks that bypass the Volume Mount Manager, in programs such as imDisk
  // get the error EISDIR: illegal operation on a directory
  try {
    fs.realpathSync.native(path.resolve("./"));
  } catch (error) {
    if (error.message.includes("EISDIR: illegal operation on a directory")) {
      safeRealpathSync = fs.realpathSync;
      return;
    }
  }
  exec("net use", (error, stdout) => {
    if (error) return;
    const lines = stdout.split("\n");
    // OK           Y:        \\NETWORKA\Foo         Microsoft Windows Network
    // OK           Z:        \\NETWORKA\Bar         Microsoft Windows Network
    for (const line of lines) {
      const m = line.match(parseNetUseRE);
      if (m) windowsNetworkMap.set(m[3], m[2]);
    }
    if (windowsNetworkMap.size === 0) {
      safeRealpathSync = fs.realpathSync.native;
    } else {
      safeRealpathSync = windowsMappedRealpathSync;
    }
  });
}

export function promiseWithResolvers<T>(): PromiseWithResolvers<T> {
  let resolve: any;
  let reject: any;
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

export interface Hostname {
  /** undefined sets the default behaviour of server.listen */
  host: string | undefined;
  /** resolve to localhost when possible */
  name: string;
}

/**
 * 用于解析主机名
 * @param optionsHost
 * @returns 包含主机和名称的对象
 */
export async function resolveHostname(
  optionsHost: string | boolean | undefined
): Promise<Hostname> {
  let host: string | undefined;
  if (optionsHost === undefined || optionsHost === false) {
    // 使用默认值 "localhost"
    host = "localhost";
  } else if (optionsHost === true) {
    // 表示在 CLI 中传递了 --host 而没有参数，
    host = undefined; // host 设置为 undefined（这通常意味着监听所有 IP 地址）
  } else {
    host = optionsHost;
  }

  // 尽可能将主机名设置为localhost
  let name = host === undefined || wildcardHosts.has(host) ? "localhost" : host;

  // 处理 localhost 特殊情况：
  if (host === "localhost") {
    // See #8647 for more details.
    const localhostAddr = await getLocalhostAddressIfDiffersFromDNS();
    if (localhostAddr) {
      name = localhostAddr;
    }
  }

  return { host, name };
}

/**
 * 用于解析服务器的本地和网络 URL。这个函数主要是为了在启动服务器后，生成服务器的本地和网络访问地址。
 * @param server 服务器实例
 * @param options 包含服务器配置选项
 * @param config 解析后的配置
 * @returns
 */
export async function resolveServerUrls(
  server: Server,
  options: CommonServerOptions,
  config: ResolvedConfig
): Promise<ResolvedServerUrls> {
  // 获取服务器地址
  const address = server.address();

  // 检查地址是否有效，如果地址无效，则返回空的本地和网络地址数组。
  const isAddressInfo = (x: any): x is AddressInfo => x?.address;
  if (!isAddressInfo(address)) {
    return { local: [], network: [] };
  }

  // 初始化变量
  const local: string[] = [];
  const network: string[] = [];
  const hostname = await resolveHostname(options.host);
  const protocol = options.https ? "https" : "http";
  const port = address.port;
  const base =
    config.rawBase === "./" || config.rawBase === "" ? "/" : config.rawBase;

  // 处理特定的主机名
  if (hostname.host !== undefined && !wildcardHosts.has(hostname.host)) {
    // !wildcardHosts.has(hostname.host)：
    // 检查 hostname.host 是否不在 wildcardHosts 集合中，确保主机名不是通配符
    let hostnameName = hostname.name;
    // ipv6 host
    if (hostnameName.includes(":")) {
      // 如果主机名包含冒号（表示是 IPv6 地址），则将其包裹在方括号中
      hostnameName = `[${hostnameName}]`;
    }
    // 构建完整的 URL
    const address = `${protocol}://${hostnameName}:${port}${base}`;
    if (loopbackHosts.has(hostname.host)) {
      local.push(address);
    } else {
      network.push(address);
    }
  } else {
    // 通配符主机名情况处理

    // 获取所有网络接口
    Object.values(os.networkInterfaces())
      // 使用 flatMap 展开每个网络接口的细节数组（处理 undefined 的情况）
      .flatMap((nInterface) => nInterface ?? [])
      .filter(
        // 使用 filter 过滤出有效的 IPv4 地址（包括处理 Node 18.0 - 18.3 返回数字的情况）
        (detail) =>
          detail &&
          detail.address &&
          (detail.family === "IPv4" ||
            // @ts-expect-error Node 18.0 - 18.3 returns number
            detail.family === 4)
      )
      .forEach((detail) => {
        // 遍历每个网络接口的细节，构建主机名和 URL
        let host = detail.address.replace("127.0.0.1", hostname.name);
        // ipv6 host
        if (host.includes(":")) {
          host = `[${host}]`;
        }
        const url = `${protocol}://${host}:${port}${base}`;
        if (detail.address.includes("127.0.0.1")) {
          local.push(url);
        } else {
          network.push(url);
        }
      });
  }
  return { local, network };
}

/**
 * 用于检查 Node.js 内部解析的 localhost 地址和 DNS 系统解析的 localhost 地址是否相同。
 * 如果两者不同，则返回 Node.js 内部解析的地址；如果相同，则返回 undefined。
 * @returns
 */
export async function getLocalhostAddressIfDiffersFromDNS(): Promise<
  string | undefined
> {
  // 同时进行两次 localhost 的 DNS 查找：
  const [nodeResult, dnsResult] = await Promise.all([
    dns.lookup("localhost"), //Node.js 的默认 localhost 查找方式
    dns.lookup("localhost", { verbatim: true }), //按照 DNS 系统解析顺序进行的查找
  ]);

  // 比较查找结果：
  // family：表示地址族（例如 IPv4 或 IPv6）
  // address：表示解析后的 IP 地址
  const isSame =
    nodeResult.family === dnsResult.family &&
    nodeResult.address === dnsResult.address;
  return isSame ? undefined : nodeResult.address;
}

export function resolveDependencyVersion(
  dep: string,
  pkgRelativePath = "../../package.json"
): string {
  const pkgPath = path.resolve(_require.resolve(dep), pkgRelativePath);
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
}

export const rollupVersion = resolveDependencyVersion("rollup");

const filter = process.env.VITE_DEBUG_FILTER;
const DEBUG = process.env.DEBUG;

interface DebuggerOptions {
  onlyWhenFocused?: boolean | string;
}
export type ViteDebugScope = `vite:${string}`;

export function createDebugger(
  namespace: ViteDebugScope,
  options: DebuggerOptions = {}
): debug.Debugger["log"] | undefined {
  const log = debug(namespace);
  const { onlyWhenFocused } = options;

  let enabled = log.enabled;
  if (enabled && onlyWhenFocused) {
    const ns =
      typeof onlyWhenFocused === "string" ? onlyWhenFocused : namespace;
    enabled = !!DEBUG?.includes(ns);
  }

  if (enabled) {
    return (...args: [string, ...any[]]) => {
      if (!filter || args.some((a) => a?.includes?.(filter))) {
        log(...args);
      }
    };
  }
}

/**
 * 目的是测试当前文件系统是否是区分大小写的
 * @returns
 */
function testCaseInsensitiveFS() {
  // 检查 CLIENT_ENTRY 是否以 "client.mjs" 结尾
  if (!CLIENT_ENTRY.endsWith("client.mjs")) {
    throw new Error(
      `cannot test case insensitive FS, CLIENT_ENTRY const doesn't contain client.mjs`
    );
  }
  // 检查 CLIENT_ENTRY 指向的文件是否存在
  if (!fs.existsSync(CLIENT_ENTRY)) {
    throw new Error(
      "cannot test case insensitive FS, CLIENT_ENTRY does not point to an existing file: " +
        CLIENT_ENTRY
    );
  }
  // 测试文件系统是否区分大小写
  // 替换 CLIENT_ENTRY 中的 "client.mjs" 为 "cLiEnT.mjs"，然后再次使用 fs.existsSync 检查文件是否存在。
  // 如果存在，说明文件系统不区分大小写，返回 true；否则，返回 false。
  return fs.existsSync(CLIENT_ENTRY.replace("client.mjs", "cLiEnT.mjs"));
}

export const isCaseInsensitiveFS = testCaseInsensitiveFS();

export function isParentDirectory(dir: string, file: string): boolean {
  dir = withTrailingSlash(dir);
  return (
    file.startsWith(dir) ||
    (isCaseInsensitiveFS && file.toLowerCase().startsWith(dir.toLowerCase()))
  );
}

export function isInNodeModules(id: string): boolean {
  return id.includes("node_modules");
}

export function moduleListContains(
  moduleList: string[] | undefined,
  id: string
): boolean | undefined {
  return moduleList?.some(
    (m) => m === id || id.startsWith(withTrailingSlash(m))
  );
}

export function isFileReadable(filename: string): boolean {
  if (!tryStatSync(filename)) {
    return false;
  }

  try {
    // Check if current process has read permission to the file
    fs.accessSync(filename, fs.constants.R_OK);

    return true;
  } catch {
    return false;
  }
}

/**
 * 用于比较旧的和新的服务器 URL 是否相同
 * 如果 URL 或 DNS 顺序发生变化，它返回 true；否则返回 false
 * @param oldUrls
 * @param newUrls
 * @returns
 */
export function diffDnsOrderChange(
  oldUrls: ViteDevServer["resolvedUrls"],
  newUrls: ViteDevServer["resolvedUrls"]
): boolean {
  return !(
    oldUrls === newUrls ||
    (oldUrls &&
      newUrls &&
      arrayEqual(oldUrls.local, newUrls.local) &&
      arrayEqual(oldUrls.network, newUrls.network))
  );
}

/**
 * 比较两个数组是否相等
 * 如果两个数组在引用、长度和每个元素上都相等，返回 true；否则返回 false
 * @param a
 * @param b
 * @returns
 */
export function arrayEqual(a: any[], b: any[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function isDevServer(
  server: ViteDevServer | PreviewServer
): server is ViteDevServer {
  return "pluginContainer" in server;
}

// 用于匹配 Windows 文件路径的卷标部分（如 "C:" 或 "D:"） i 忽略大小写
const VOLUME_RE = /^[A-Z]:/i;

/**
 * 用于将路径标识符或 URL 转换为文件系统路径
 * 主要就是去除掉 FS_PREFIX 开头的前缀
 * @param id 路径标识符
 * @returns
 */
export function fsPathFromId(id: string): string {
  const fsPath = normalizePath(
    // 如果以特定前缀（FS_PREFIX）开头则去掉，否则保持原样
    id.startsWith(FS_PREFIX) ? id.slice(FS_PREFIX.length) : id
  );
  // 如果规范化后的路径以 / 开头，或者匹配卷标的正则表达式 VOLUME_RE（即是 Windows 文件路径），则返回该路径
  // 否则，在路径前加上 /，使其成为绝对路径
  return fsPath[0] === "/" || VOLUME_RE.test(fsPath) ? fsPath : `/${fsPath}`;
}

export function fsPathFromUrl(url: string): string {
  return fsPathFromId(cleanUrl(url));
}

/**
 * 用于检查两个文件名是否相同。
 * 该函数的功能是比较两个标准化的绝对路径，以确定它们是否指向同一个文件
 *
 * @param file1 - normalized absolute path
 * @param file2 - normalized absolute path
 * @returns true if both files url are identical
 */
export function isSameFileUri(file1: string, file2: string): boolean {
  return (
    file1 === file2 ||
    (isCaseInsensitiveFS && file1.toLowerCase() === file2.toLowerCase())
  );
}

/**
 * 去掉/ 开头
 * @param str
 * @returns
 */
export function removeLeadingSlash(str: string): string {
  return str[0] === "/" ? str.slice(1) : str;
}

const internalPrefixes = [
  FS_PREFIX,
  VALID_ID_PREFIX,
  CLIENT_PUBLIC_PATH,
  ENV_PUBLIC_PATH,
];
const InternalPrefixRE = new RegExp(`^(?:${internalPrefixes.join("|")})`);
/** 用于匹配内部请求 */
export const isInternalRequest = (url: string): boolean =>
  InternalPrefixRE.test(url);

export const isImportRequest = (url: string): boolean =>
  importQueryRE.test(url);

export function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function joinUrlSegments(a: string, b: string): string {
  if (!a || !b) {
    return a || b || "";
  }
  if (a[a.length - 1] === "/") {
    a = a.substring(0, a.length - 1);
  }
  if (b[0] !== "/") {
    b = "/" + b;
  }
  return a + b;
}

export function ensureWatchedFile(
  watcher: FSWatcher,
  file: string | null,
  root: string
): void {
  if (
    file &&
    // only need to watch if out of root
    !file.startsWith(withTrailingSlash(root)) &&
    // some rollup plugins use null bytes for private resolved Ids
    !file.includes("\0") &&
    fs.existsSync(file)
  ) {
    // resolve file to normalized system path
    watcher.add(path.resolve(file));
  }
}

export function getHash(text: Buffer | string, length = 8): string {
  const h = createHash("sha256")
    .update(text)
    .digest("hex")
    .substring(0, length);
  if (length <= 64) return h;
  return h.padEnd(length, "_");
}

interface ImageCandidate {
  url: string;
  descriptor: string;
}
const escapedSpaceCharacters = /( |\\t|\\n|\\f|\\r)+/g;
const imageSetUrlRE = /^(?:[\w\-]+\(.*?\)|'.*?'|".*?"|\S*)/;
function joinSrcset(ret: ImageCandidate[]) {
  return ret
    .map(({ url, descriptor }) => url + (descriptor ? ` ${descriptor}` : ""))
    .join(", ");
}

function splitSrcSetDescriptor(srcs: string): ImageCandidate[] {
  return splitSrcSet(srcs)
    .map((s) => {
      const src = s.replace(escapedSpaceCharacters, " ").trim();
      const url = imageSetUrlRE.exec(src)?.[0] ?? "";

      return {
        url,
        descriptor: src.slice(url.length).trim(),
      };
    })
    .filter(({ url }) => !!url);
}

export const blankReplacer = (match: string): string =>
  " ".repeat(match.length);
const cleanSrcSetRE =
  /(?:url|image|gradient|cross-fade)\([^)]*\)|"([^"]|(?<=\\)")*"|'([^']|(?<=\\)')*'|data:\w+\/[\w.+\-]+;base64,[\w+/=]+|\?\S+,/g;
function splitSrcSet(srcs: string) {
  const parts: string[] = [];
  /**
   * There could be a ',' inside of:
   * - url(data:...)
   * - linear-gradient(...)
   * - "data:..."
   * - data:...
   * - query parameter ?...
   */
  const cleanedSrcs = srcs.replace(cleanSrcSetRE, blankReplacer);
  let startIndex = 0;
  let splitIndex: number;
  do {
    splitIndex = cleanedSrcs.indexOf(",", startIndex);
    parts.push(
      srcs.slice(startIndex, splitIndex !== -1 ? splitIndex : undefined)
    );
    startIndex = splitIndex + 1;
  } while (splitIndex !== -1);
  return parts;
}

export function processSrcSetSync(
  srcs: string,
  replacer: (arg: ImageCandidate) => string
): string {
  return joinSrcset(
    splitSrcSetDescriptor(srcs).map(({ url, descriptor }) => ({
      url: replacer({ url, descriptor }),
      descriptor,
    }))
  );
}

const replacePercentageRE = /%/g;
export function injectQuery(url: string, queryToInject: string): string {
  // encode percents for consistent behavior with pathToFileURL
  // see #2614 for details
  const resolvedUrl = new URL(
    url.replace(replacePercentageRE, "%25"),
    "relative:///"
  );
  const { search, hash } = resolvedUrl;
  let pathname = cleanUrl(url);
  pathname = isWindows ? slash(pathname) : pathname;
  return `${pathname}?${queryToInject}${search ? `&` + search.slice(1) : ""}${
    hash ?? ""
  }`;
}

const knownJsSrcRE =
  /\.(?:[jt]sx?|m[jt]s|vue|marko|svelte|astro|imba|mdx)(?:$|\?)/;
export const isJSRequest = (url: string): boolean => {
  url = cleanUrl(url);
  if (knownJsSrcRE.test(url)) {
    return true;
  }
  if (!path.extname(url) && url[url.length - 1] !== "/") {
    return true;
  }
  return false;
};

const knownTsRE = /\.(?:ts|mts|cts|tsx)(?:$|\?)/;
export const isTsRequest = (url: string): boolean => knownTsRE.test(url);

export function stripBase(path: string, base: string): string {
  if (path === base) {
    return "/";
  }
  const devBase = withTrailingSlash(base);
  return path.startsWith(devBase) ? path.slice(devBase.length - 1) : path;
}

/**
 * 用于从给定的 importPath 中提取 NPM 包的名称
 * @param importPath
 * @returns
 * @example
 * getNpmPackageName("@scope/package"); // "@scope/package"
 * getNpmPackageName("package"); // "package"
 * getNpmPackageName("@scope") // null
 */
export function getNpmPackageName(importPath: string): string | null {
  const parts = importPath.split("/");
  if (parts[0][0] === "@") {
    // 检查第一个部分的第一个字符是否为 @，即判断是否为作用域包（如 @scope/package）

    // parts[1] 不存在，即没有包名部分
    if (!parts[1]) return null;

    // 存在包名部分，返回完整的作用域包名
    return `${parts[0]}/${parts[1]}`;
  } else {
    // 不是作用域包，直接返回第一个部分作为包名
    return parts[0];
  }
}

/**
 * 用于判断给定的 id 是否可以优化
 * @param id
 * @param optimizeDeps
 * @returns
 */
export function isOptimizable(
  id: string,
  optimizeDeps: DepOptimizationConfig
): boolean {
  const { extensions } = optimizeDeps;
  return (
    // 匹配可以优化的文件扩展名
    OPTIMIZABLE_ENTRY_RE.test(id) ||
    // 检查 id 是否以 extensions 中的某个扩展名结尾
    (extensions?.some((ext) => id.endsWith(ext)) ?? false)
  );
}

const nullSourceMap: RawSourceMap = {
  names: [],
  sources: [],
  mappings: "",
  version: 3,
};

const windowsDriveRE = /^[A-Z]:/;
const replaceWindowsDriveRE = /^([A-Z]):\//;
const linuxAbsolutePathRE = /^\/[^/]/;
function escapeToLinuxLikePath(path: string) {
  if (windowsDriveRE.test(path)) {
    return path.replace(replaceWindowsDriveRE, "/windows/$1/");
  }
  if (linuxAbsolutePathRE.test(path)) {
    return `/linux${path}`;
  }
  return path;
}

const revertWindowsDriveRE = /^\/windows\/([A-Z])\//;
function unescapeToLinuxLikePath(path: string) {
  if (path.startsWith("/linux/")) {
    return path.slice("/linux".length);
  }
  if (path.startsWith("/windows/")) {
    return path.replace(revertWindowsDriveRE, "$1:/");
  }
  return path;
}

export function combineSourcemaps(
  filename: string,
  sourcemapList: Array<DecodedSourceMap | RawSourceMap>
): RawSourceMap {
  if (
    sourcemapList.length === 0 ||
    sourcemapList.every((m) => m.sources.length === 0)
  ) {
    return { ...nullSourceMap };
  }

  // hack for parse broken with normalized absolute paths on windows (C:/path/to/something).
  // escape them to linux like paths
  // also avoid mutation here to prevent breaking plugin's using cache to generate sourcemaps like vue (see #7442)
  sourcemapList = sourcemapList.map((sourcemap) => {
    const newSourcemaps = { ...sourcemap };
    newSourcemaps.sources = sourcemap.sources.map((source) =>
      source ? escapeToLinuxLikePath(source) : null
    );
    if (sourcemap.sourceRoot) {
      newSourcemaps.sourceRoot = escapeToLinuxLikePath(sourcemap.sourceRoot);
    }
    return newSourcemaps;
  });
  const escapedFilename = escapeToLinuxLikePath(filename);

  // We don't declare type here so we can convert/fake/map as RawSourceMap
  let map; //: SourceMap
  let mapIndex = 1;
  const useArrayInterface =
    sourcemapList.slice(0, -1).find((m) => m.sources.length !== 1) ===
    undefined;
  if (useArrayInterface) {
    map = remapping(sourcemapList, () => null);
  } else {
    map = remapping(sourcemapList[0], function loader(sourcefile) {
      if (sourcefile === escapedFilename && sourcemapList[mapIndex]) {
        return sourcemapList[mapIndex++];
      } else {
        return null;
      }
    });
  }
  if (!map.file) {
    delete map.file;
  }

  // unescape the previous hack
  map.sources = map.sources.map((source) =>
    source ? unescapeToLinuxLikePath(source) : source
  );
  map.file = filename;

  return map as RawSourceMap;
}

export function timeFrom(start: number, subtract = 0): string {
  const time: number | string = performance.now() - start - subtract;
  const timeString = (time.toFixed(2) + `ms`).padEnd(5, " ");
  if (time < 10) {
    return colors.green(timeString);
  } else if (time < 50) {
    return colors.yellow(timeString);
  } else {
    return colors.red(timeString);
  }
}

/**
 * pretty url for logging.
 */
export function prettifyUrl(url: string, root: string): string {
  url = removeTimestampQuery(url);
  const isAbsoluteFile = url.startsWith(root);
  if (isAbsoluteFile || url.startsWith(FS_PREFIX)) {
    const file = path.posix.relative(
      root,
      isAbsoluteFile ? url : fsPathFromId(url)
    );
    return colors.dim(file);
  } else {
    return colors.dim(url);
  }
}

const windowsDrivePathPrefixRE = /^[A-Za-z]:[/\\]/;

/**
 * path.isAbsolute also returns true for drive relative paths on windows (e.g. /something)
 * this function returns false for them but true for absolute paths (e.g. C:/something)
 */
export const isNonDriveRelativeAbsolutePath = (p: string): boolean => {
  if (!isWindows) return p[0] === "/";
  return windowsDrivePathPrefixRE.test(p);
};

export function lookupFile(
  dir: string,
  fileNames: string[]
): string | undefined {
  while (dir) {
    for (const fileName of fileNames) {
      const fullPath = path.join(dir, fileName);
      if (tryStatSync(fullPath)?.isFile()) return fullPath;
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) return;

    dir = parentDir;
  }
}

const escapeRegexRE = /[-/\\^$*+?.()|[\]{}]/g;
export function escapeRegex(str: string): string {
  return str.replace(escapeRegexRE, "\\$&");
}

/**
 * Transforms transpiled code result where line numbers aren't altered,
 * so we can skip sourcemap generation during dev
 */
export function transformStableResult(
  s: MagicString,
  id: string,
  config: ResolvedConfig
): TransformResult {
  return {
    code: s.toString(),
    map:
      config.command === "build" && config.build.sourcemap
        ? s.generateMap({ hires: "boundary", source: id })
        : null,
  };
}

export function evalValue<T = any>(rawValue: string): T {
  const fn = new Function(`
    var console, exports, global, module, process, require
    return (\n${rawValue}\n)
  `);
  return fn();
}

// Taken from https://stackoverflow.com/a/36328890
export const multilineCommentsRE = /\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g;
export const singlelineCommentsRE = /\/\/.*/g;
export const requestQuerySplitRE = /\?(?!.*[/|}])/;
export const requestQueryMaybeEscapedSplitRE = /\\?\?(?!.*[/|}])/;

// strip UTF-8 BOM
export function stripBomTag(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }

  return content;
}
export function isDefined<T>(value: T | undefined | null): value is T {
  return value != null;
}

export const urlRE = /(\?|&)url(?:&|$)/;

// 用于匹配换行符（包括 Windows 和 Unix 格式的换行符 \r\n 和 \n）
export const splitRE = /\r?\n/g;

/**
 * 在字符串每一行前面添加一定数量的空格，常用于格式化输出或者生成缩进文本的场景
 *
 * 原生有 padStart，不知道是不是很早之前处理的了
 * @param source 待处理的字符串
 * @param n 要添加的空格数
 * @returns
 */
export function pad(source: string, n = 2): string {
  // 将 source 字符串分割成行数组 lines
  const lines = source.split(splitRE);
  // 在每行前面添加指定数量的空格
  return lines.map((l) => ` `.repeat(n) + l).join(`\n`);
}

type Pos = {
  /** 1-based */
  line: number;
  /** 0-based */
  column: number;
};
const range: number = 2;

export function posToNumber(source: string, pos: number | Pos): number {
  if (typeof pos === "number") return pos;
  const lines = source.split(splitRE);
  const { line, column } = pos;
  let start = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    start += lines[i].length + 1;
  }
  return start + column;
}

export function generateCodeFrame(
  source: string,
  start: number | Pos = 0,
  end?: number | Pos
): string {
  start = Math.max(posToNumber(source, start), 0);
  end = Math.min(
    end !== undefined ? posToNumber(source, end) : start,
    source.length
  );
  const lines = source.split(splitRE);
  let count = 0;
  const res: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    count += lines[i].length;
    if (count >= start) {
      for (let j = i - range; j <= i + range || end > count; j++) {
        if (j < 0 || j >= lines.length) continue;
        const line = j + 1;
        res.push(
          `${line}${" ".repeat(Math.max(3 - String(line).length, 0))}|  ${
            lines[j]
          }`
        );
        const lineLength = lines[j].length;
        if (j === i) {
          // push underline
          const pad = Math.max(start - (count - lineLength), 0);
          const length = Math.max(
            1,
            end > count ? lineLength - pad : end - start
          );
          res.push(`   |  ` + " ".repeat(pad) + "^".repeat(length));
        } else if (j > i) {
          if (end > count) {
            const length = Math.max(Math.min(end - count, lineLength), 1);
            res.push(`   |  ` + "^".repeat(length));
          }
          count += lineLength + 1;
        }
      }
      break;
    }
    count++;
  }
  return res.join("\n");
}
