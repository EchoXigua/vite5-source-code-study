//用于配置 @rollup/plugin-dynamic-import-vars 插件的选项
export interface RollupDynamicImportVarsOptions {
  /**
   * 要包含在此插件中的文件（默认全部）
   * @default []
   */
  include?: string | RegExp | (string | RegExp)[];
  /**
   * 要排除在此插件中的文件（默认无）
   * @default []
   */
  exclude?: string | RegExp | (string | RegExp)[];
  /**
   * 默认情况下，当插件遇到错误时会终止构建过程。如果将此选项设置为 true，则插件会抛出警告而不会修改代码。
   * @default false
   */
  warnOnError?: boolean;
}
