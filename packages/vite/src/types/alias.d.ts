import type { PluginHooks } from "rollup";

export interface Alias {
  find: string | RegExp;
  replacement: string;
  /**
   * Instructs the plugin to use an alternative resolving algorithm,
   * rather than the Rollup's resolver.
   * @default null
   */
  customResolver?: ResolverFunction | ResolverObject | null;
}
export type MapToFunction<T> = T extends Function ? T : never;

export type ResolverFunction = MapToFunction<PluginHooks["resolveId"]>;

export interface ResolverObject {
  buildStart?: PluginHooks["buildStart"];
  resolveId: ResolverFunction;
}

export type AliasOptions = readonly Alias[] | { [find: string]: string };
