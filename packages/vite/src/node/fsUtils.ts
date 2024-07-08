import fs from "node:fs";
import path from "node:path";
import type { ResolvedConfig } from "./config";
import type { FSWatcher } from "dep-types/chokidar";
import {
  // isInNodeModules,
  normalizePath,
  safeRealpathSync,
  tryStatSync,
} from "./utils";

export interface FsUtils {
  existsSync: (path: string) => boolean;
  isDirectory: (path: string) => boolean;

  tryResolveRealFile: (
    path: string,
    preserveSymlinks?: boolean
  ) => string | undefined;
  tryResolveRealFileWithExtensions: (
    path: string,
    extensions: string[],
    preserveSymlinks?: boolean
  ) => string | undefined;
  tryResolveRealFileOrType: (
    path: string,
    preserveSymlinks?: boolean
  ) => { path?: string; type: "directory" | "file" } | undefined;

  initWatcher?: (watcher: FSWatcher) => void;
}

export const commonFsUtils: FsUtils = {
  existsSync: fs.existsSync,
  isDirectory,

  // tryResolveRealFile,
  // tryResolveRealFileWithExtensions,
  // tryResolveRealFileOrType,
};

const cachedFsUtilsMap = new WeakMap<ResolvedConfig, FsUtils>();
export function getFsUtils(config: ResolvedConfig): FsUtils {
  let fsUtils = cachedFsUtilsMap.get(config) || {
    existsSync: fs.existsSync,
    isDirectory,
  };
  if (!fsUtils) {
    if (
      config.command !== "serve" ||
      config.server.fs.cachedChecks === false ||
      config.server.watch?.ignored ||
      process.versions.pnp
    ) {
      // cached fsUtils is only used in the dev server for now
      // it is enabled by default only when there aren't custom watcher ignored patterns configured
      // and if yarn pnp isn't used
      fsUtils = commonFsUtils;
    } else if (
      !config.resolve.preserveSymlinks &&
      config.root !== getRealPath(config.root)
    ) {
      fsUtils = commonFsUtils;
    } else {
      // fsUtils = createCachedFsUtils(config);
    }
    cachedFsUtilsMap.set(config, fsUtils);
  }

  return fsUtils;
}

function getRealPath(resolved: string, preserveSymlinks?: boolean): string {
  if (!preserveSymlinks) {
    resolved = safeRealpathSync(resolved);
  }
  return normalizePath(resolved);
}

function isDirectory(path: string): boolean {
  const stat = tryStatSync(path);
  return stat?.isDirectory() ?? false;
}
