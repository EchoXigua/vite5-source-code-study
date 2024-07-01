import fsp from "node:fs/promises";
import path from "node:path";
import type { OutgoingHttpHeaders as HttpServerHeaders } from "node:http";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import type { Connect } from "dep-types/connect";
import type { HttpServer } from "./server";

export interface CommonServerOptions {
  /**
   * Specify server port. Note if the port is already being used, Vite will
   * automatically try the next available port so this may not be the actual
   * port the server ends up listening on.
   */
  port?: number;
  /**
   * If enabled, vite will exit if specified port is already in use
   */
  strictPort?: boolean;
  /**
   * Specify which IP addresses the server should listen on.
   * Set to 0.0.0.0 to listen on all addresses, including LAN and public addresses.
   */
  host?: string | boolean;
  /**
   * Enable TLS + HTTP/2.
   * Note: this downgrades to TLS only when the proxy option is also used.
   */
  https?: HttpsServerOptions;
  /**
   * Open browser window on startup
   */
  open?: boolean | string;
  /**
   * Configure custom proxy rules for the dev server. Expects an object
   * of `{ key: options }` pairs.
   * Uses [`http-proxy`](https://github.com/http-party/node-http-proxy).
   * Full options [here](https://github.com/http-party/node-http-proxy#options).
   *
   * Example `vite.config.js`:
   * ``` js
   * module.exports = {
   *   proxy: {
   *     // string shorthand: /foo -> http://localhost:4567/foo
   *     '/foo': 'http://localhost:4567',
   *     // with options
   *     '/api': {
   *       target: 'http://jsonplaceholder.typicode.com',
   *       changeOrigin: true,
   *       rewrite: path => path.replace(/^\/api/, '')
   *     }
   *   }
   * }
   * ```
   */
  proxy?: Record<string, string | ProxyOptions>;
  /**
   * Configure CORS for the dev server.
   * Uses https://github.com/expressjs/cors.
   * Set to `true` to allow all methods from any origin, or configure separately
   * using an object.
   */
  cors?: CorsOptions | boolean;
  /**
   * Specify server response headers.
   */
  headers?: HttpServerHeaders;
}

/**
 * 用于创建一个 HTTP 或 HTTPS 服务器，并根据配置选择使用 HTTP/1 或 HTTP/2 协议
 *
 * @param proxy 用于判断是否需要代理
 * @param app 表示 Connect 中间件
 * @param httpsOptions 用于配置 HTTPS 服务器
 * @returns
 */
export async function resolveHttpServer(
  { proxy }: CommonServerOptions,
  app: Connect.Server,
  httpsOptions?: HttpsServerOptions
): Promise<HttpServer> {
  if (!httpsOptions) {
    //没有https 的配置，说明需要创建http服务器
    //动态导入 node:http 模块并创建 HTTP 服务器
    const { createServer } = await import("node:http");
    return createServer(app);
  }

  // #484 fallback to http1 when proxy is needed.
  //判断是否需要代理
  if (proxy) {
    //需要代理，动态导入 node:https 模块并创建 HTTPS 服务器。

    const { createServer } = await import("node:https");
    return createServer(httpsOptions, app);
  } else {
    //不需要代理，动态导入 node:http2 模块并创建 HTTP/2 服务器
    const { createSecureServer } = await import("node:http2");
    return createSecureServer(
      {
        //手动增加会话内存，以防止在大量请求时出现 502 ENHANCE_YOUR_CALM 错误。
        maxSessionMemory: 1000,
        ...httpsOptions,
        allowHTTP1: true, // 允许 HTTP/1 协议
      },
      // @ts-expect-error TODO: is this correct?
      app
    );
  }
}

//解析 HTTPS 配置的异步函数
export async function resolveHttpsConfig(
  https: HttpsServerOptions | undefined
): Promise<HttpsServerOptions | undefined> {
  if (!https) return undefined;

  //并行地读取 https 对象中的 ca、cert、key 和 pfx 四个属性的文件内容，并等待所有的 Promise 完成
  const [ca, cert, key, pfx] = await Promise.all([
    readFileIfExists(https.ca),
    readFileIfExists(https.cert),
    readFileIfExists(https.key),
    readFileIfExists(https.pfx),
  ]);

  //替换ca、cert、key 和 pfx
  return { ...https, ca, cert, key, pfx };
}

//用于读取文件内容
async function readFileIfExists(value?: string | Buffer | any[]) {
  if (typeof value === "string") {
    //尝试读取对应路径的文件内容，并在读取失败时返回原始的 value
    return fsp.readFile(path.resolve(value)).catch(() => value);
  }
  //如果 value 不是字符串，则直接返回 value
  return value;
}
