import fs from "node:fs";
import { dirname, join } from "node:path";
import { isFileReadable } from "../utils";

// https://github.com/vitejs/vite/issues/2820#issuecomment-812495079
const ROOT_FILES = [
  // '.git',

  // https://pnpm.io/workspaces/
  "pnpm-workspace.yaml",

  // https://rushjs.io/pages/advanced/config_files/
  // 'rush.json',

  // https://nx.dev/latest/react/getting-started/nx-setup
  // 'workspace.json',
  // 'nx.json',

  // https://github.com/lerna/lerna#lernajson
  "lerna.json",
];

// npm: https://docs.npmjs.com/cli/v7/using-npm/workspaces#installing-workspaces
// yarn: https://classic.yarnpkg.com/en/docs/workspaces/#toc-how-to-use-it
/**
 * 检查指定目录中的 package.json 文件是否包含 workspaces 字段，以确定该目录是否为一个工作区根目录。
 * @param root
 * @returns
 */
function hasWorkspacePackageJSON(root: string): boolean {
  const path = join(root, "package.json");
  // 检查 package.json 文件是否存在且可读。如果文件不可读，直接返回 false
  if (!isFileReadable(path)) {
    return false;
  }
  try {
    // 读取 package.json 文件内容
    const content = JSON.parse(fs.readFileSync(path, "utf-8")) || {};
    // 判断是否包含workspaces 字段
    return !!content.workspaces;
  } catch {
    return false;
  }
}

/**
 * 用于检查指定目录 root 是否包含工作区根目录文件
 * @param root
 * @returns
 */
function hasRootFile(root: string): boolean {
  // existsSync 检查文件是否存在
  return ROOT_FILES.some((file) => fs.existsSync(join(root, file)));
}

/**
 * 用于检查指定目录 root 是否包含 package.json 文件
 * @param root
 * @returns
 */
function hasPackageJSON(root: string) {
  const path = join(root, "package.json");
  return fs.existsSync(path);
}

/**
 * 在当前目录及其父目录中搜索最接近的 package.json 文件，以确定项目的根目录。
 */
export function searchForPackageRoot(current: string, root = current): string {
  // 找到了 package.json 文件 直接返回当前路径
  if (hasPackageJSON(current)) return current;

  // 获取当前目录的父目录路径
  const dir = dirname(current);
  // 检查是否到达文件系统的根目录
  if (!dir || dir === current) return root;

  // 递归调用搜索
  return searchForPackageRoot(dir, root);
}

/**
 * 用于从当前目录向上搜索最近的工作区根目录
 *
 * 从当前目录开始，向上一级一级地搜索，直到找到包含工作区根目录的文件或 package.json 文件的目录
 */
export function searchForWorkspaceRoot(
  current: string, //当前目录路径，从这个目录开始搜索
  root = searchForPackageRoot(current) //工作区根目录
): string {
  // 如果当前目录包含工作区根目录的文件，返回当前目录
  if (hasRootFile(current)) return current;
  // 如果当前目录包含工作区的 package.json 文件，返回当前目录
  if (hasWorkspacePackageJSON(current)) return current;

  // 获取当前目录的父目录
  const dir = dirname(current);
  // 如果已经到达文件系统的根目录，返回 root
  if (!dir || dir === current) return root;

  // 递归调用，继续向上一级目录搜索
  return searchForWorkspaceRoot(dir, root);
}
