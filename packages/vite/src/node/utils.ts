import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { builtinModules, createRequire } from "node:module";
import { isWindows, slash } from "../shared/utils";
import {
  type PackageCache,
  findNearestPackageData,
  resolvePackageData,
} from "./packages";

import { createFilter as _createFilter } from "@rollup/pluginutils";

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

export function mergeAlias(a?: any, b?: any) {
  if (!a) return b;
  if (!b) return a;
  if (isObject(a) && isObject(b)) {
    return { ...a, ...b };
  }
  // the order is flipped because the alias is resolved from top-down,
  // where the later should have higher priority
  return [...normalizeAlias(b), ...normalizeAlias(a)];
}
export function normalizeAlias(o = []) {
  return Array.isArray(o)
    ? o.map(normalizeSingleAlias)
    : Object.keys(o).map((find) =>
        normalizeSingleAlias({
          find,
          replacement: (o as any)[find],
        })
      );
}

function normalizeSingleAlias({ find, replacement, customResolver }: any) {
  if (
    typeof find === "string" &&
    find[find.length - 1] === "/" &&
    replacement[replacement.length - 1] === "/"
  ) {
    find = find.slice(0, find.length - 1);
    replacement = replacement.slice(0, replacement.length - 1);
  }

  const alias: any = {
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

export const requireResolveFromRootWithFallback = (
  root: string,
  id: string
): string => {
  // check existence first, so if the package is not found,
  // it won't be cached by nodejs, since there isn't a way to invalidate them:
  // https://github.com/nodejs/node/issues/44663
  const found =
    resolvePackageData(id, root) || resolvePackageData(id, _dirname);
  if (!found) {
    const error = new Error(`${JSON.stringify(id)} not found.`);
    (error as any).code = "MODULE_NOT_FOUND";
    throw error;
  }

  // actually resolve
  // Search in the root directory first, and fallback to the default require paths.
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
