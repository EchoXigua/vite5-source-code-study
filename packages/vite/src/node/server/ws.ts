import path from "node:path";
import type { IncomingMessage, Server } from "node:http";
import { STATUS_CODES, createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import colors from "picocolors";
import type { WebSocket as WebSocketRaw } from "ws";
import { WebSocketServer as WebSocketServerRaw_ } from "ws";
import type { WebSocket as WebSocketTypes } from "dep-types/ws";

import type { CustomPayload, ErrorPayload, HMRPayload } from "types/hmrPayload";
import type { InferCustomEventPayload } from "types/customEvent";

import { isObject } from "../utils";
import type { ResolvedConfig } from "..";
import type { HMRChannel } from "./hmr";
import type { HttpServer } from ".";

/* In Bun, the `ws` module is overridden to hook into the native code. Using the bundled `js` version
 * of `ws` will not work as Bun's req.socket does not allow reading/writing to the underlying socket.
 */
const WebSocketServerRaw = process.versions.bun
  ? // @ts-expect-error: Bun defines `import.meta.require`
    import.meta.require("ws").WebSocketServer
  : WebSocketServerRaw_;

export const HMR_HEADER = "vite-hmr";

export type WebSocketCustomListener<T> = (
  data: T,
  client: WebSocketClient
) => void;

export interface WebSocketServer extends HMRChannel {
  /**
   * 用于在指定的端口和主机上监听 WebSocket 连接
   */
  listen(): void;
  /**
   * 表示所有已连接的客户端
   */
  clients: Set<WebSocketClient>;
  /**
   * 用于断开所有客户端连接并终止服务器，返回一个 Promise，表示关闭操作完成时的承诺
   */
  close(): Promise<void>;
  /**
   * 用于处理由 import.meta.hot.send 发出的自定义事件
   * 扩展了 WebSocketTypes.Server["on"] 的功能，并添加了一个新的签名
   */
  on: WebSocketTypes.Server["on"] & {
    <T extends string>(
      event: T,
      listener: WebSocketCustomListener<InferCustomEventPayload<T>>
    ): void;
  };
  /**
   * 用于取消注册事件监听器，扩展了 WebSocketTypes.Server["off"] 的功能，并添加了一个新的签名
   */
  off: WebSocketTypes.Server["off"] & {
    (event: string, listener: Function): void;
  };
}

export interface WebSocketClient {
  /**
   * 用于向客户端发送事件，payload 表示热模块替换（HMR）的负载。
   */
  send(payload: HMRPayload): void;
  /**
   *    这是另一个 send 方法（函数重载），用于发送自定义事件
   */
  send(event: string, payload?: CustomPayload["data"]): void;
  /**
   * 表示原始的 WebSocket 实例。
   * @advanced
   * 注释 @advanced 表明这是一个高级属性，可能用于需要直接操作 WebSocket 实例的高级用例。
   */
  socket: WebSocketTypes;
}

const wsServerEvents = [
  "connection",
  "error",
  "headers",
  "listening",
  "message",
];

/**
 * 用于创建一个 WebSocket 服务器，该服务器可以处理热模块替换（HMR）请求和连接
 * @param server  // 传入的 HTTP 服务器实例，可能为空
 * @param config // 已解析的 Vite 配置
 * @param httpsOptions // 可选的 HTTPS 配置选项
 * @returns  // 返回一个 WebSocket 服务器实例
 */
export function createWebSocketServer(
  server: HttpServer | null,
  config: ResolvedConfig,
  httpsOptions?: HttpsServerOptions
): WebSocketServer {
  // 声明一个原始 WebSocket 服务器变量
  let wss: WebSocketServerRaw_;
  // 声明一个可选的 HTTP 服务器变量
  let wsHttpServer: Server | undefined = undefined;
  // 检查并获取 HMR（热模块替换）配置
  const hmr = isObject(config.server.hmr) && config.server.hmr;
  // 获取 HMR 服务器配置
  const hmrServer = hmr && hmr.server;
  // 获取 HMR 端口配置
  const hmrPort = hmr && hmr.port;
  // 检查 HMR 端口是否与服务器端口兼容
  const portsAreCompatible = !hmrPort || hmrPort === config.server.port;
  // 确定 WebSocket 服务器，优先使用 HMR 服务器，否则使用传入的 HTTP 服务器
  const wsServer = hmrServer || (portsAreCompatible && server);

  // 定义一个 HMR WebSocket 服务器监听器
  let hmrServerWsListener: (
    req: InstanceType<typeof IncomingMessage>,
    socket: Duplex,
    head: Buffer
  ) => void;

  // 定义一个映射，用于存储自定义监听器
  const customListeners = new Map<string, Set<WebSocketCustomListener<any>>>();
  // 定义一个弱映射，用于存储 WebSocket 客户端
  const clientsMap = new WeakMap<WebSocketRaw, WebSocketClient>();
  // 如果没有指定 HMR 端口，则使用默认端口 24678
  const port = hmrPort || 24678; // 获取 HMR 主机配置
  const host = (hmr && hmr.host) || undefined;

  if (wsServer) {
    // 如果 WebSocket 服务器存在
    // 获取基础路径
    let hmrBase = config.base;
    // 获取 HMR 路径
    const hmrPath = hmr ? hmr.path : undefined;
    if (hmrPath) {
      // 连接基础路径和 HMR 路径
      hmrBase = path.posix.join(hmrBase, hmrPath);
    }
    // 创建一个不绑定服务器的原始 WebSocket 服务器
    wss = new WebSocketServerRaw({ noServer: true });
    // 定义 HMR WebSocket 服务器监听器
    hmrServerWsListener = (req, socket, head) => {
      if (
        // 检查请求头是否为 HMR
        req.headers["sec-websocket-protocol"] === HMR_HEADER &&
        req.url === hmrBase // 检查请求 URL 是否为 HMR 基础路径
      ) {
        // 处理 WebSocket 升级请求
        wss.handleUpgrade(req, socket as Socket, head, (ws) => {
          // 触发连接事件
          wss.emit("connection", ws, req);
        });
      }
    };
    // 在 WebSocket 服务器上绑定升级事件监听器
    wsServer.on("upgrade", hmrServerWsListener);
  } else {
    // 如果 WebSocket 服务器不存在
    // HTTP 服务器请求处理器，发送 426 状态码响应
    const route = ((_, res) => {
      const statusCode = 426;
      // 获取状态码对应的消息
      const body = STATUS_CODES[statusCode];
      if (!body)
        throw new Error(`No body text found for the ${statusCode} status code`);

      res.writeHead(statusCode, {
        "Content-Length": body.length,
        "Content-Type": "text/plain",
      });
      // 发送响应
      res.end(body);
    }) as Parameters<typeof createHttpServer>[1];

    /**
     * as Parameters<typeof createHttpServer>[1]
     * 将 route 的类型指定为 createHttpServer 函数的第二个参数的类型
     *
     * Parameters：用来获取一个函数类型的参数类型元组
     * 例如，如果 createHttpServer 函数签名是 (arg1: number, arg2: string) => void，
     * 那么 Parameters<typeof createHttpServer> 将返回 [number, string]。
     */

    if (httpsOptions) {
      // 如果提供了 HTTPS 选项，创建https服务器
      wsHttpServer = createHttpsServer(httpsOptions, route);
    } else {
      // 否则创建http服务器
      wsHttpServer = createHttpServer(route);
    }
    //中间件模式下的Vite开发服务器需要手动调用ws侦听
    // 绑定服务器的原始 WebSocket 服务器
    wss = new WebSocketServerRaw({ server: wsHttpServer });
  }

  //监听连接事件
  wss.on("connection", (socket) => {
    //监听 message 事件
    socket.on("message", (raw) => {
      // 如果没有自定义监听器，直接返回
      if (!customListeners.size) return;
      let parsed: any;
      try {
        //尝试解析消息
        parsed = JSON.parse(String(raw));
      } catch {}
      // 如果消息类型不是自定义，直接返回
      if (!parsed || parsed.type !== "custom" || !parsed.event) return;
      // 获取事件对应的监听器
      const listeners = customListeners.get(parsed.event);
      // 如果没有监听器，直接返回
      if (!listeners?.size) return;
      // 获取 WebSocket 客户端
      const client = getSocketClient(socket);
      // 触发所有监听器
      listeners.forEach((listener) => listener(parsed.data, client));
    });
    //监听错误（通信的过程中出现的错误）
    socket.on("error", (err) => {
      config.logger.error(`${colors.red(`ws error:`)}\n${err.stack}`, {
        timestamp: true,
        error: err,
      });
    });

    // 发送连接成功消息
    socket.send(JSON.stringify({ type: "connected" }));

    // 如果有缓存的错误消息
    if (bufferedError) {
      //发送缓存的错误消息
      socket.send(JSON.stringify(bufferedError));
      //清空缓存的错误消息
      bufferedError = null;
    }
  });

  //监听错误事件（没有连接上产生的错误）
  wss.on("error", (e: Error & { code: string }) => {
    if (e.code === "EADDRINUSE") {
      // 如果端口已被占用
      config.logger.error(
        colors.red(`WebSocket server error: Port is already in use`),
        { error: e }
      );
    } else {
      config.logger.error(
        colors.red(`WebSocket server error:\n${e.stack || e.message}`),
        { error: e }
      );
    }
  });

  // 提供一个包装器，用于管理 WebSocket 客户端和发送消息
  function getSocketClient(socket: WebSocketRaw) {
    if (!clientsMap.has(socket)) {
      // 如果客户端不存在
      clientsMap.set(socket, {
        // 定义发送消息方法
        send: (...args) => {
          let payload: HMRPayload;
          //如果第一个参数是字符串
          if (typeof args[0] === "string") {
            payload = {
              type: "custom",
              event: args[0],
              data: args[1],
            };
          } else {
            payload = args[0];
          }
          // 发送消息
          socket.send(JSON.stringify(payload));
        },
        socket,
      });
    }
    return clientsMap.get(socket)!;
  }

  /**
   * 在页面重新加载时，如果文件编译失败并返回500，则服务器在客户端连接建立之前发送错误负载。
   * 如果我们没有打开的客户端，缓冲错误并将其发送到下一个连接的客户端。
   */
  // 初始化缓存的错误消息
  let bufferedError: ErrorPayload | null = null;

  // 返回一个 WebSocket 服务器实例，包含多个方法
  return {
    name: "ws",
    listen: () => {
      // 启动 WebSocket 服务器监听
      wsHttpServer?.listen(port, host);
    },
    // 绑定事件监听器
    on: ((event: string, fn: () => void) => {
      // 如果是 WebSocket 服务器事件
      if (wsServerEvents.includes(event)) wss.on(event, fn);
      else {
        //自定义事件
        if (!customListeners.has(event)) {
          customListeners.set(event, new Set());
        }
        customListeners.get(event)!.add(fn);
      }
    }) as WebSocketServer["on"],

    //卸载事件监听器
    off: ((event: string, fn: () => void) => {
      //ws 自己的服务器事件
      if (wsServerEvents.includes(event)) {
        wss.off(event, fn);
      } else {
        //自定义事件
        customListeners.get(event)?.delete(fn);
      }
    }) as WebSocketServer["off"],

    //获取所有的客户端
    get clients() {
      return new Set(Array.from(wss.clients).map(getSocketClient));
    },

    send(...args: any[]) {
      let payload: HMRPayload;
      if (typeof args[0] === "string") {
        payload = {
          type: "custom",
          event: args[0],
          data: args[1],
        };
      } else {
        payload = args[0];
      }

      // 如果消息类型是错误且没有客户端
      if (payload.type === "error" && !wss.clients.size) {
        // 缓存错误消息
        bufferedError = payload;
        return;
      }

      // 序列化消息
      const stringified = JSON.stringify(payload);
      wss.clients.forEach((client) => {
        // readyState 1表示连接是打开的
        if (client.readyState === 1) {
          //发送消息给所有连接是打开的客户端
          client.send(stringified);
        }
      });
    },

    // 关闭 WebSocket 服务器
    close() {
      /**
       * 如果 hmr.server 已设置，应移除监听器。否则，旧的监听器会拦截所有的 WebSocket 连接。
       *
       * 当 hmr.server 已设置时，意味着可能存在自定义的 HMR（热模块替换）服务器。
       * 在这种情况下，我们需要移除先前添加的监听器，以确保新设置的 HMR 服务器
       * 能够正常接收和处理 WebSocket 连接。如果不移除旧的监听器，
       * 所有的 WebSocket 连接都会被旧的监听器拦截，导致新设置的 HMR 服务器无法正常工作。
       */

      if (hmrServerWsListener && wsServer) {
        // 取消升级事件监听器
        //为了确保在关闭 WebSocket 服务器时，不会有旧的监听器继续拦截新的 WebSocket 连接。
        wsServer.off("upgrade", hmrServerWsListener);
      }
      return new Promise((resolve, reject) => {
        wss.clients.forEach((client) => {
          // 终止所有客户端连接
          client.terminate();
        });
        // 关闭 WebSocket 服务器
        wss.close((err) => {
          if (err) {
            reject(err);
          } else {
            if (wsHttpServer) {
              // 关闭 HTTP 服务器
              wsHttpServer.close((err) => {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              });
            } else {
              resolve();
            }
          }
        });
      });
    },
  };
}
