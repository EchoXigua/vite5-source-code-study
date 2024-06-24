export interface ResolveOptions {
  /**
   * @default ['browser', 'module', 'jsnext:main', 'jsnext']
   */
  mainFields?: string[];
  conditions?: string[];
  /**
   * @default ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']
   */
  extensions?: string[];
  dedupe?: string[];
  /**
   * @default false
   */
  preserveSymlinks?: boolean;
}
