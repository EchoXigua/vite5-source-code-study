import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { URL, fileURLToPath } from "node:url";
import { builtinModules, createRequire } from "node:module";
import fsp from "node:fs/promises";
import type { AddressInfo, Server } from "node:net";
import { promises as dns } from "node:dns";
import debug from "debug";

import { createFilter as _createFilter } from "@rollup/pluginutils";

import type { Alias, AliasOptions } from "dep-types/alias";

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
  // OPTIMIZABLE_ENTRY_RE,
  loopbackHosts,
  wildcardHosts,
} from "./constants";
import type { PreviewServer } from "./preview";

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

//用于判断给定的模块 ID 是否是内置模块，这里函数考虑了多种运行时环境（Node.js、Deno、Bun）中的内置模块命名空间。
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

export const externalRE = /^(https?:)?\/\//;
export const isExternalUrl = (url: string): boolean => externalRE.test(url);

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

function testCaseInsensitiveFS() {
  if (!CLIENT_ENTRY.endsWith("client.mjs")) {
    throw new Error(
      `cannot test case insensitive FS, CLIENT_ENTRY const doesn't contain client.mjs`
    );
  }
  if (!fs.existsSync(CLIENT_ENTRY)) {
    throw new Error(
      "cannot test case insensitive FS, CLIENT_ENTRY does not point to an existing file: " +
        CLIENT_ENTRY
    );
  }
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
