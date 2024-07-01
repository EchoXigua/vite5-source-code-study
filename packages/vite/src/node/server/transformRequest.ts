import type { PartialResolvedId, SourceDescription, SourceMap } from "rollup";

export interface TransformResult {
  code: string;
  map: SourceMap | { mappings: "" } | null;
  etag?: string;
  deps?: string[];
  dynamicDeps?: string[];
}
