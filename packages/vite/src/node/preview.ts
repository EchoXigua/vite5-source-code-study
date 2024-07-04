import connect from "connect";
import type { Connect } from "dep-types/connect";
import type { InlineConfig, ResolvedConfig } from "./config";
import type {
  HttpServer,
  // ResolvedServerOptions,
  ResolvedServerUrls,
} from "./server";
import type { BindCLIShortcutsOptions } from "./shortcuts";

export interface PreviewServer {
  /**
   * 解析后的 Vite 配置对象,包含了所有经过解析和处理后的配置信息。
   */
  config: ResolvedConfig;
  /**
   * 停止服务器
   */
  close(): Promise<void>;
  /**
   * 一个 connect 应用实例
   * - 可以用于向预览服务器附加自定义中间件
   * -也可以用作自定义 HTTP 服务器的处理函数，或者用作任何 connect 风格的 Node.js 框架中的中间件
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server;
  /**
   * 原生的 Node.js HTTP 服务器实例
   */
  httpServer: HttpServer;
  /**
   * Vite 在 CLI 上打印的解析后的 URL
   * 在服务器开始监听之前，此值为 null
   */
  resolvedUrls: ResolvedServerUrls | null;
  /**
   * 打印服务器 URL 的方法
   */
  printUrls(): void;
  /**
   *  绑定 CLI 快捷键的方法
   */
  bindCLIShortcuts(options?: BindCLIShortcutsOptions<PreviewServer>): void;
}
