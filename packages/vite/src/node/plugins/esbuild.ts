import type { TransformOptions } from "esbuild";

export interface ESBuildOptions extends TransformOptions {
  include?: string | RegExp | string[] | RegExp[];
  exclude?: string | RegExp | string[] | RegExp[];
  jsxInject?: string;
  /**
   * This option is not respected. Use `build.minify` instead.
   */
  minify?: never;
}
