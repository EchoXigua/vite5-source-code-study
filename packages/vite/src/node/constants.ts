import path, { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url)).toString()
);

export const VERSION = version as string;

export const DEFAULT_MAIN_FIELDS = [
  "browser",
  "module",
  "jsnext:main", // moment still uses this...
  "jsnext",
];

export const ESBUILD_MODULES_TARGET = [
  "es2020", // support import.meta.url
  "edge88",
  "firefox78",
  "chrome87",
  "safari14",
];

export const DEFAULT_EXTENSIONS = [
  ".mjs",
  ".js",
  ".mts",
  ".ts",
  ".jsx",
  ".tsx",
  ".json",
];

export const DEFAULT_CONFIG_FILES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
];

export const VITE_PACKAGE_DIR = resolve(
  // import.meta.url is `dist/node/constants.js` after bundle
  fileURLToPath(import.meta.url),
  "../../.."
);

export const CLIENT_ENTRY = resolve(VITE_PACKAGE_DIR, "dist/client/client.mjs");
export const ENV_ENTRY = resolve(VITE_PACKAGE_DIR, "dist/client/env.mjs");
export const CLIENT_DIR = path.dirname(CLIENT_ENTRY);

//在处理文件系统路径时，特别是在跨平台应用程序中，Windows 的文件路径可能不适合用作 URL。
//因此，需要一个前缀来标识和转换这些路径，以确保它们可以在 Web 环境中正确使用。
export const FS_PREFIX = `/@fs/`;

export const DEFAULT_DEV_PORT = 5173;

export const DEFAULT_PREVIEW_PORT = 4173;

export const DEFAULT_ASSETS_INLINE_LIMIT = 4096;
