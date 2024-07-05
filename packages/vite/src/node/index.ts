import type * as Rollup from "rollup";

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
