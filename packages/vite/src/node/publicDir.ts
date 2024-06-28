import fs from "node:fs";
import path from "node:path";
import type { ResolvedConfig } from "./config";
import {
  ERR_SYMLINK_IN_RECURSIVE_READDIR,
  normalizePath,
  recursiveReaddir,
} from "./utils";

// 用于存储每个 ResolvedConfig 对象对应的公共文件集合。
const publicFilesMap = new WeakMap<ResolvedConfig, Set<string>>();

export async function initPublicFiles(
  config: ResolvedConfig
): Promise<Set<string> | undefined> {
  let fileNames: string[];
  try {
    //递归读取 config.publicDir 目录下的所有文件，并将文件名存储在 fileNames 数组中
    fileNames = await recursiveReaddir(config.publicDir);
  } catch (e) {
    if (e.code === ERR_SYMLINK_IN_RECURSIVE_READDIR) {
      return;
    }
    throw e;
  }
  //去重
  const publicFiles = new Set(
    fileNames.map((fileName) => fileName.slice(config.publicDir.length))
  );
  //设置该配置文件的，公共文件映射
  publicFilesMap.set(config, publicFiles);
  return publicFiles;
}
