export const isWindows =
  typeof process !== "undefined" && process.platform === "win32";

const windowsSlashRE = /\\/g;
export function slash(p: string): string {
  return p.replace(windowsSlashRE, "/");
}
