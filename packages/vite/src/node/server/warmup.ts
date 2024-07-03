import fs from "node:fs/promises";
import path from "node:path";
import glob from "fast-glob";
import colors from "picocolors";
import { FS_PREFIX } from "../constants";
import { normalizePath } from "../utils";
import type { ViteDevServer } from "../index";

/**
 * 预热 Vite 开发服务器中的文件，以减少首次访问时的延迟
 * 通过预先请求一些特定的文件来实现这一点
 * @param server Vite 的开发服务器实例
 */
export function warmupFiles(server: ViteDevServer): void {
  // 从配置中获取预热的配置
  const options = server.config.server.warmup;
  // 根目录
  const root = server.config.root;

  // 预热客户端文件
  if (options?.clientFiles?.length) {
    // 调用 mapFiles 函数，将相对路径的文件列表转换为绝对路径
    mapFiles(options.clientFiles, root).then((files) => {
      // 遍历文件列表，对每个文件调用 warmupFile 函数，false 表示这些文件是客户端文件
      for (const file of files) {
        warmupFile(server, file, false);
      }
    });
  }

  // 预热ssr 文件
  if (options?.ssrFiles?.length) {
    mapFiles(options.ssrFiles, root).then((files) => {
      for (const file of files) {
        // true 表示这些文件是 SSR 文件
        warmupFile(server, file, true);
      }
    });
  }
}

/**
 * 实现了一个文件预热功能，在 Vite 开发服务器中预先处理一些指定的文件
 * 对不同的文件有不同的处理
 *
 * @param server
 * @param file
 * @param ssr
 */
async function warmupFile(server: ViteDevServer, file: string, ssr: boolean) {
  /**
   * 这段注释解释了在 warmupFile 函数中对 HTML 文件进行预处理的原因和可能的副作用
   *
   * 1. 使用 transformIndexHtml 钩子处理 HTML 文件。transformIndexHtml 是 Vite 提供的一个钩子，
   * 用于在 HTML 文件被处理时对其进行转换。该钩子允许插件在 HTML 文件中插入脚本、样式或其他内容
   *
   * 2. Vite 的内部机制会预先转换 HTML 文件中链接的导入的 JavaScript 模块。
   * 这意味着在 HTML 文件加载到浏览器之前，Vite 会处理其中引用的所有 JavaScript 模块，对其进行必要的转换（如编译、压缩等）。
   *
   * 3. 这种预处理可能会导致 transformIndexHtml 钩子被执行两次。即，当 HTML 文件被预热时，
   * transformIndexHtml 钩子会被调用一次，而当实际请求 HTML 文件时，钩子可能会再次被调用。
   *
   * 4. 但这可能是可以接受的。尽管钩子可能会被执行两次，但这种重复执行在大多数情况下不会带来显著的负面影响。
   */

  // 处理html文件
  if (file.endsWith(".html")) {
    // 将文件路径转换为 URL
    const url = htmlFileToUrl(file, server.config.root);
    if (url) {
      // 如果 URL 有效，读取 HTML 文件内容并调用 server.transformIndexHtml 进行预处理
      try {
        const html = await fs.readFile(file, "utf-8");
        await server.transformIndexHtml(url, html);
      } catch (e) {
        // Unexpected error, log the issue but avoid an unhandled exception
        server.config.logger.error(
          `Pre-transform error (${colors.cyan(file)}): ${e.message}`,
          {
            error: e,
            timestamp: true,
          }
        );
      }
    }
  }
  // 其他文件处理
  else {
    // 将文件路径转换为 URL
    const url = fileToUrl(file, server.config.root);
    // 通过 warmupRequest 进行预处理
    await server.warmupRequest(url, { ssr });
  }
}

/**
 * 用于将 HTML 文件路径转换为 URL
 * @param file
 * @param root
 * @returns
 */
function htmlFileToUrl(file: string, root: string) {
  const url = path.relative(root, file);
  // 如果文件路径在根目录之外（路径以 . 开头），返回 undefined
  if (url[0] === ".") return;
  // 返回根目录相对路径的标准化 URL
  return "/" + normalizePath(url);
}

/**
 * 用于将其他文件路径转换为 URL
 * @param file
 * @param root
 * @returns
 */
function fileToUrl(file: string, root: string) {
  // 计算文件相对于根目录的相对路径
  const url = path.relative(root, file);
  // 如果文件路径在根目录之外（路径以 . 开头），使用 /@fs/ 前缀构造 URL
  if (url[0] === ".") {
    /**
     * path.join 是一个通用的路径拼接函数，它会根据操作系统的不同自动选择适当的路径分隔符：
     * 在 Windows 上，使用反斜杠 (\) 作为路径分隔符。
     * 在 POSIX（如 Linux 和 macOS）上，使用正斜杠 (/) 作为路径分隔符。
     *
     * path.posix.join 是一个专门用于 POSIX 风格路径拼接的函数，
     * 它始终使用正斜杠 (/) 作为路径分隔符，不论在哪种操作系统上运行。
     */
    return path.posix.join(FS_PREFIX, normalizePath(file));
  }

  // 返回根目录相对路径的标准化 URL
  return "/" + normalizePath(url);
}

/**
 * 将一组相对路径的文件名转换为绝对路径。它利用了 glob 库来匹配文件路径。
 * @param files
 * @param root
 * @returns
 */
function mapFiles(files: string[], root: string) {
  return glob(files, {
    cwd: root, //将当前工作目录设置为项目的根目录 root
    absolute: true, //返回的文件路径将是绝对路径
  });
}
