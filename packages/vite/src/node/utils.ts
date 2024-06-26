import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { builtinModules, createRequire } from "node:module";
import fsp from "node:fs/promises";

import { createFilter as _createFilter } from "@rollup/pluginutils";

import type { Alias, AliasOptions } from "dep-types/alias";

import { isWindows, slash } from "../shared/utils";
import {
  type PackageCache,
  findNearestPackageData,
  resolvePackageData,
} from "./packages";

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
