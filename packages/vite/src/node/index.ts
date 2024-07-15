import type * as Rollup from "rollup";
export { formatPostcssSourceMap, preprocessCSS } from "./plugins/css";
export { transformWithEsbuild } from "./plugins/esbuild";

export * from "./publicUtils";

export type { Rollup };

export type { ResolvedConfig } from "./config";

export type { ViteDevServer } from "./server";
export type { PreviewServer } from "./preview";

export type {
  ModuleGraph,
  ModuleNode,
  ResolvedUrl,
} from "./server/moduleGraph";
export type { CorsOptions, CorsOrigin, CommonServerOptions } from "./http";

export type {
  ResolvedSSROptions,
  SsrDepOptimizationOptions,
  SSROptions,
  SSRTarget,
} from "./ssr";
