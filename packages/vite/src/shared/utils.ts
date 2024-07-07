import { NULL_BYTE_PLACEHOLDER, VALID_ID_PREFIX } from "./constants";

export const isWindows =
  typeof process !== "undefined" && process.platform === "win32";

export function wrapId(id: string): string {
  return id.startsWith(VALID_ID_PREFIX)
    ? id
    : VALID_ID_PREFIX + id.replace("\0", NULL_BYTE_PLACEHOLDER);
}

const windowsSlashRE = /\\/g;
export function slash(p: string): string {
  return p.replace(windowsSlashRE, "/");
}

//匹配 URL 中以 ? 或 # 开头的字符序列，包括 ? 或 # 本身及其后面的任意字符
const postfixRE = /[?#].*$/;
//用于清理 URL，移除其末尾的查询字符串和哈希部分。
export function cleanUrl(url: string): string {
  return url.replace(postfixRE, "");
}

/**
 * 以/结尾，如果不是末尾添加/
 * @param path
 * @returns
 */
export function withTrailingSlash(path: string): string {
  if (path[path.length - 1] !== "/") {
    return `${path}/`;
  }
  return path;
}

/**
 * 将经过特殊处理的模块 ID 转换回其原始形式
 *
 * 在 Rollup 构建工具中，有些插件可能会使用特殊的模块 ID，
 * 例如虚拟模块 ID，这些 ID 可能会被添加特定的前缀和占位符以区分它们与普通文件模块 ID
 * 这种特殊处理可以防止其他插件（比如节点解析器）误解这些 ID，并且核心功能如源映射能够识别和区分这些虚拟模块。
 * @param id
 * @returns
 */
export function unwrapId(id: string): string {
  // 如果模块 ID 符合特定前缀，那么函数将去除前缀部分，
  // 并且将特定的占位符 NULL_BYTE_PLACEHOLDER 替换为实际的 \0 字符。
  // 这样就能够有效地恢复原始的模块 ID
  return id.startsWith(VALID_ID_PREFIX)
    ? id.slice(VALID_ID_PREFIX.length).replace(NULL_BYTE_PLACEHOLDER, "\0")
    : id;
}
