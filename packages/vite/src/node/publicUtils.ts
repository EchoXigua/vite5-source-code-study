export { VERSION as version } from './constants'
export { version as esbuildVersion } from 'esbuild'

export {
    // splitVendorChunkPlugin,
    // splitVendorChunk,
    isCSSRequest,
  } from './plugins/splitVendorChunk'


export { normalizePath, mergeConfig, mergeAlias,createFilter } from "./utils";
