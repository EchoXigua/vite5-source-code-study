// 用于处理 Rollup 构建过程中的模块标识符
/**
 * 用于标识那些不是有效的浏览器导入规范的解析后的 ID。
 * 在浏览器环境中，这些前缀可以用于区分虚拟模块和常规文件。
 */
export const VALID_ID_PREFIX = `/@id/`;

/**
 * 用作虚拟模块中空字节 \0 的占位符
 *
 * 关于虚拟模块在 Rollup 生态系统中使用的约定和处理方式
 *
 * 1. Virtual Modules: 插件可以使用虚拟模块，例如用于辅助函数等目的。
 * 这些模块的模块 ID 以 \0 开头，这是 Rollup 生态系统中的一种约定。
 *
 * 2. Preventing Processing by Other Plugins: 使用 \0 前缀可以防止其他插件（
 * 例如节点解析插件）尝试处理这些 ID。这确保了核心功能如源映射（sourcemaps）能够区分虚拟模块和常规文件。
 *
 * 3. Encoding and Decoding: 因为 \0 字符在导入 URL 中不允许使用，
 * 所以在导入分析过程中需要将其替换为占位符 __x00__。在进入插件管道之前，
 * 这些编码后的虚拟 ID 将被解码回原始形式。
 *
 * 4. Final Browser Representation: 在浏览器中，这些编码后的虚拟 ID 还会被 VALID_ID_PREFIX 前缀，
 * 因此最终浏览器中的虚拟模块的标识符可能看起来像 /@id/__x00__{id}。
 */
export const NULL_BYTE_PLACEHOLDER = `__x00__`;
