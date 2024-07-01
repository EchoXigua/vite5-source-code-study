export const isWindows =
  typeof process !== "undefined" && process.platform === "win32";

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
