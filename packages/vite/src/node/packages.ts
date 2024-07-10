import fs from "node:fs";
import path from "node:path";
import {
  createFilter,
  normalizePath,
  safeRealpathSync,
  tryStatSync,
} from "./utils";
import { isWindows, slash } from "../shared/utils";

let pnp: typeof import("pnpapi") | undefined;

export type PackageCache = Map<string, PackageData>;

export interface PackageData {
  dir: string;
  hasSideEffects: (id: string) => boolean | "no-treeshake" | null;
  webResolvedImports: Record<string, string | undefined>;
  nodeResolvedImports: Record<string, string | undefined>;
  setResolvedCache: (key: string, entry: string, targetWeb: boolean) => void;
  getResolvedCache: (key: string, targetWeb: boolean) => string | undefined;
  data: {
    [field: string]: any;
    name: string;
    type: string;
    version: string;
    main: string;
    module: string;
    browser: string | Record<string, string | false>;
    exports: string | Record<string, any> | string[];
    imports: Record<string, any>;
    dependencies: Record<string, string>;
  };
}

export function resolvePackageData(
  pkgName: string,
  basedir: string,
  preserveSymlinks = false,
  packageCache?: PackageCache
): PackageData | null {
  if (pnp) {
    const cacheKey = getRpdCacheKey(pkgName, basedir, preserveSymlinks);
    if (packageCache?.has(cacheKey)) return packageCache.get(cacheKey)!;

    try {
      const pkg = pnp.resolveToUnqualified(pkgName, basedir, {
        considerBuiltins: false,
      });
      if (!pkg) return null;

      const pkgData = loadPackageData(path.join(pkg, "package.json"));
      packageCache?.set(cacheKey, pkgData);
      return pkgData;
    } catch {
      return null;
    }
  }

  const originalBasedir = basedir;
  while (basedir) {
    if (packageCache) {
      const cached = getRpdCache(
        packageCache,
        pkgName,
        basedir,
        originalBasedir,
        preserveSymlinks
      );
      if (cached) return cached;
    }

    const pkg = path.join(basedir, "node_modules", pkgName, "package.json");
    try {
      if (fs.existsSync(pkg)) {
        const pkgPath = preserveSymlinks ? pkg : safeRealpathSync(pkg);
        const pkgData = loadPackageData(pkgPath);

        if (packageCache) {
          setRpdCache(
            packageCache,
            pkgData,
            pkgName,
            basedir,
            originalBasedir,
            preserveSymlinks
          );
        }

        return pkgData;
      }
    } catch {}

    const nextBasedir = path.dirname(basedir);
    if (nextBasedir === basedir) break;
    basedir = nextBasedir;
  }

  return null;
}

/**
 * 用于查找包含 name 字段的最近的 package.json 文件
 * 这个函数会递归地向上查找，直到找到一个包含 name 字段的 package.json 文件或到达文件系统的根目录为止
 * @param basedir 查找的起始目录
 * @param packageCache 缓存已经查找到的包数据
 * @returns
 */
export function findNearestMainPackageData(
  basedir: string,
  packageCache?: PackageCache
): PackageData | null {
  // 查找最近的 package.json 文件
  // 包含 dir（目录路径）和 data（解析后的 package.json 数据）的对象
  const nearestPackage = findNearestPackageData(basedir, packageCache);
  return (
    nearestPackage &&
    (nearestPackage.data.name
      ? nearestPackage
      : // 递归调用，继续向上一级目录查找
        findNearestMainPackageData(
          path.dirname(nearestPackage.dir),
          packageCache
        ))
  );
}

export function loadPackageData(pkgPath: string): PackageData {
  const data = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const pkgDir = normalizePath(path.dirname(pkgPath));
  const { sideEffects } = data;
  let hasSideEffects: (id: string) => boolean | null;
  if (typeof sideEffects === "boolean") {
    hasSideEffects = () => sideEffects;
  } else if (Array.isArray(sideEffects)) {
    if (sideEffects.length <= 0) {
      // createFilter always returns true if `includes` is an empty array
      // but here we want it to always return false
      hasSideEffects = () => false;
    } else {
      const finalPackageSideEffects = sideEffects.map((sideEffect) => {
        /*
         * The array accepts simple glob patterns to the relevant files... Patterns like *.css, which do not include a /, will be treated like **\/*.css.
         * https://webpack.js.org/guides/tree-shaking/
         * https://github.com/vitejs/vite/pull/11807
         */
        if (sideEffect.includes("/")) {
          return sideEffect;
        }
        return `**/${sideEffect}`;
      });

      hasSideEffects = createFilter(finalPackageSideEffects, null, {
        resolve: pkgDir,
      });
    }
  } else {
    hasSideEffects = () => null;
  }

  const pkg: PackageData = {
    dir: pkgDir,
    data,
    hasSideEffects,
    webResolvedImports: {},
    nodeResolvedImports: {},
    setResolvedCache(key: string, entry: string, targetWeb: boolean) {
      if (targetWeb) {
        pkg.webResolvedImports[key] = entry;
      } else {
        pkg.nodeResolvedImports[key] = entry;
      }
    },
    getResolvedCache(key: string, targetWeb: boolean) {
      if (targetWeb) {
        return pkg.webResolvedImports[key];
      } else {
        return pkg.nodeResolvedImports[key];
      }
    },
  };

  return pkg;
}

// package cache key for `resolvePackageData`
function getRpdCacheKey(
  pkgName: string,
  basedir: string,
  preserveSymlinks: boolean
) {
  return `rpd_${pkgName}_${basedir}_${preserveSymlinks}`;
}

/**
 * Get cached `resolvePackageData` value based on `basedir`. When one is found,
 * and we've already traversed some directories between `basedir` and `originalBasedir`,
 * we cache the value for those in-between directories as well.
 *
 * This makes it so the fs is only read once for a shared `basedir`.
 */
function getRpdCache(
  packageCache: PackageCache,
  pkgName: string,
  basedir: string,
  originalBasedir: string,
  preserveSymlinks: boolean
) {
  const cacheKey = getRpdCacheKey(pkgName, basedir, preserveSymlinks);
  const pkgData = packageCache.get(cacheKey);
  if (pkgData) {
    traverseBetweenDirs(originalBasedir, basedir, (dir) => {
      packageCache.set(getRpdCacheKey(pkgName, dir, preserveSymlinks), pkgData);
    });
    return pkgData;
  }
}

function setRpdCache(
  packageCache: PackageCache,
  pkgData: PackageData,
  pkgName: string,
  basedir: string,
  originalBasedir: string,
  preserveSymlinks: boolean
) {
  packageCache.set(getRpdCacheKey(pkgName, basedir, preserveSymlinks), pkgData);
  traverseBetweenDirs(originalBasedir, basedir, (dir) => {
    packageCache.set(getRpdCacheKey(pkgName, dir, preserveSymlinks), pkgData);
  });
}

/**
 * Traverse between `longerDir` (inclusive) and `shorterDir` (exclusive) and call `cb` for each dir.
 * @param longerDir Longer dir path, e.g. `/User/foo/bar/baz`
 * @param shorterDir Shorter dir path, e.g. `/User/foo`
 */
function traverseBetweenDirs(
  longerDir: string,
  shorterDir: string,
  cb: (dir: string) => void
) {
  while (longerDir !== shorterDir) {
    cb(longerDir);
    longerDir = path.dirname(longerDir);
  }
}

/**
 * 用于查找指定目录及其父目录中最近的 package.json 文件，并返回其数据
 *
 * @param basedir 从该目录开始向上查找 package.json 文件
 * @param packageCache 可选的包缓存，用于缓存查找结果，提高后续查找的效率
 * @returns
 */
export function findNearestPackageData(
  basedir: string,
  packageCache?: PackageCache
): PackageData | null {
  //保存原始的 basedir 值，以便在缓存中使用
  const originalBasedir = basedir;

  //在 basedir 不为空的情况下，进入循环
  while (basedir) {
    if (packageCache) {
      //如果提供了 packageCache，首先检查缓存中是否有该目录的缓存结果，如果有则直接返回。
      const cached = getFnpdCache(packageCache, basedir, originalBasedir);
      if (cached) return cached;
    }

    //检查 package.json 文件：
    const pkgPath = path.join(basedir, "package.json");
    //使用 tryStatSync 函数检查 pkgPath 是否是一个文件
    if (tryStatSync(pkgPath)?.isFile()) {
      //如果是文件，尝试加载其数据，并在缓存中存储结果。
      try {
        const pkgData = loadPackageData(pkgPath);

        if (packageCache) {
          setFnpdCache(packageCache, pkgData, basedir, originalBasedir);
        }

        return pkgData;
      } catch {}
    }

    //开始更新 basedir：
    const nextBasedir = path.dirname(basedir);
    if (nextBasedir === basedir) break;
    //更新 basedir 为其父目录。
    basedir = nextBasedir;
  }

  return null;
}

/**
 * Get cached `findNearestPackageData` value based on `basedir`. When one is found,
 * and we've already traversed some directories between `basedir` and `originalBasedir`,
 * we cache the value for those in-between directories as well.
 *
 * This makes it so the fs is only read once for a shared `basedir`.
 */
function getFnpdCache(
  packageCache: PackageCache,
  basedir: string,
  originalBasedir: string
) {
  const cacheKey = getFnpdCacheKey(basedir);
  const pkgData = packageCache.get(cacheKey);
  if (pkgData) {
    traverseBetweenDirs(originalBasedir, basedir, (dir) => {
      packageCache.set(getFnpdCacheKey(dir), pkgData);
    });
    return pkgData;
  }
}

function setFnpdCache(
  packageCache: PackageCache,
  pkgData: PackageData,
  basedir: string,
  originalBasedir: string
) {
  packageCache.set(getFnpdCacheKey(basedir), pkgData);
  traverseBetweenDirs(originalBasedir, basedir, (dir) => {
    packageCache.set(getFnpdCacheKey(dir), pkgData);
  });
}

// package cache key for `findNearestPackageData`
function getFnpdCacheKey(basedir: string) {
  return `fnpd_${basedir}`;
}
