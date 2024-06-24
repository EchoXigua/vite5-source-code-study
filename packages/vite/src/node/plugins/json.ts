//定义了处理 JSON 文件加载选项的配置
export interface JsonOptions {
  /**
   * 是否为 JSON 对象的每个属性生成命名导出。
   * 当设置为 true 时，每个属性都会作为独立的导出项在模块中可用
   * @default true
   */
  namedExports?: boolean;
  /**
   * 是否以性能为目标生成输出，形式为 JSON.parse("stringified")。
   * 启用此选项会禁用 namedExports。这种输出形式在某些情况下可能会提高解析效率。
   * @default false
   */
  stringify?: boolean;
}
