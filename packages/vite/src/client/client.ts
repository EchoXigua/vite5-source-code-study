import type { InferCustomEventPayload } from "../../types/customEvent";
import { HMRClient, HMRContext } from "../shared/hmr";
import type { ViteHotContext } from "../../types/hot";

import "@vite/env";

//当服务运行的时候这些常量会被注入
//代表应用程序的基础 URL 路径
declare const __BASE__: string;
//服务器主机名
declare const __SERVER_HOST__: string;
//HMR 使用的协议（例如 ws 或 wss）
declare const __HMR_PROTOCOL__: string | null;
//HMR 使用的主机名
declare const __HMR_HOSTNAME__: string | null;
//HMR 使用的端口号
declare const __HMR_PORT__: number | null;
//HMR 的直接目标 URL 或路径
declare const __HMR_DIRECT_TARGET__: string;
//HMR 使用的基础路径
declare const __HMR_BASE__: string;
//HMR 连接的超时时间
declare const __HMR_TIMEOUT__: number;
//是否启用 HMR 的错误覆盖层
declare const __HMR_ENABLE_OVERLAY__: boolean;

console.debug("[vite] connecting...");

//import.meta.url 返回当前模块的 URL
//new URL(import.meta.url) 将其解析为一个 URL 对象，方便访问其各个组成部分（如协议、主机名、端口等）
const importMetaUrl = new URL(import.meta.url);
/**
 * 以下代码展示了如何使用注入的全局常量和 import.meta.url 处理热模块替换（HMR）的相关配置
 */

//服务器主机名，直接从注入的全局常量 __SERVER_HOST__ 获取。
const serverHost = __SERVER_HOST__;
//优先使用注入的协议，没有的话根据当前模块的URL 协议来推断，https使用 wss，否则使用 ws
const socketProtocol =
  __HMR_PROTOCOL__ || (importMetaUrl.protocol === "https:" ? "wss" : "ws");
//从全局常量中获取HMR的端口号
const hmrPort = __HMR_PORT__;

//socketHost 是 HMR WebSocket 的主机地址。优先从注入的常量中获取，没有则通过importMetaUrl获取
const socketHost = `${__HMR_HOSTNAME__ || importMetaUrl.hostname}:${
  hmrPort || importMetaUrl.port
}${__HMR_BASE__}`;

//从注入的常量中获取直接目标地址
const directSocketHost = __HMR_DIRECT_TARGET__;
//优先使用BASE，没有则默认为 /
const base = __BASE__ || "/";

let socket: WebSocket;

//开始尝试建立与 HMR 服务器的 websocket连接
try {
  let fallback: (() => void) | undefined;
  //首先检查是否存在一个端口号（hmrPort），如果不存在，则尝试使用回退方式建立连接
  if (!hmrPort) {
    fallback = () => {
      socket = setupWebSocket(socketProtocol, directSocketHost, () => {
        const currentScriptHostURL = new URL(import.meta.url);
        const currentScriptHost =
          currentScriptHostURL.host +
          currentScriptHostURL.pathname.replace(/@vite\/client$/, "");

        console.error(
          "[vite] failed to connect to websocket.\n" +
            "your current setup:\n" +
            `  (browser) ${currentScriptHost} <--[HTTP]--> ${serverHost} (server)\n` +
            `  (browser) ${socketHost} <--[WebSocket (failing)]--> ${directSocketHost} (server)\n` +
            "Check out your Vite / network configuration and https://vitejs.dev/config/server-options.html#server-hmr ."
        );
      });

      socket.addEventListener(
        "open",
        () => {
          console.info(
            "[vite] Direct websocket connection fallback. Check out https://vitejs.dev/config/server-options.html#server-hmr to remove the previous connection error."
          );
        },
        { once: true }
      );
    };
  }
  socket = setupWebSocket(socketProtocol, socketHost, fallback);
} catch (error) {
  console.error(`[vite] failed to connect to websocket (${error}). `);
}

/**
 * 用于创建 WebSocket 连接
 *
 * @param protocol 连接的协议
 * @param hostAndPath 主机和路径 hostAndPath
 * @param onCloseWithoutOpen 在连接未成功打开时执行的回调函数
 */
function setupWebSocket(
  protocol: string,
  hostAndPath: string,
  onCloseWithoutOpen?: () => void
) {
  //子协议为 'vite-hmr'，以确保与服务器端的通信能够正常进行。
  const socket = new WebSocket(`${protocol}://${hostAndPath}`, "vite-hmr");
  let isOpened = false;

  //连接状态监听
  socket.addEventListener(
    "open",
    () => {
      //当连接成功打开时候，将isOpened标志设置true
      isOpened = true;
      //notifyListeners 函数通知所有监听器连接已建立
    },

    { once: true }
  );

  //消息处理
  socket.addEventListener("message", async ({ data }) => {
    //处理从服务器端发来的消息
    handleMessage(JSON.parse(data));
  });

  socket.addEventListener("close", async ({ wasClean }) => {
    //如果连接是因为正常关闭而关闭的，则直接返回，不执行后续操作
    if (wasClean) return;

    //如果连接未成功，且存在onCloseWithoutOpen 函数，则执行onCloseWithoutOpen 并返回
    if (!isOpened && onCloseWithoutOpen) {
      onCloseWithoutOpen();
      return;
    }

    //通知所有的事件监听器，关闭连接
    notifyListeners("vite:ws:disconnect", { webSocket: socket });

    if (hasDocument) {
      //如果在浏览器环境中运行，则输出日志并尝试进行服务器重启轮询，并在轮询成功后刷新页面。
      console.log(`[vite] server connection lost. polling for restart...`);
      await waitForSuccessfulPing(protocol, hostAndPath);
      location.reload();
    }
  });

  return socket;
}

const hmrClient = new HMRClient();

/**
 * 函数重载
 *
 * 第一个函数签名是泛型函数，用于处理具有特定事件类型的数据。它使用 TypeScript 中的泛型类型来实现。
 *
 * 第二个函数签名是默认函数签名，用于处理一般的事件和数据。
 */

function notifyListeners<T extends string>(
  event: T,
  data: InferCustomEventPayload<T>
): void;
function notifyListeners(event: string, data: any): void {
  //会将事件和数据传递给 HMR（热模块替换）客户端的监听器。
  //发布订阅
  hmrClient.notifyListeners(event, data);
}

/**
 * 
 *  第一个重载函数签名的使用示例
    notifyListeners('vite:ws:connect', { webSocket: socket });

    第二个重载函数签名的使用示例
    notifyListeners('custom-event', { key: 'value' });
 * 
 */

export function createHotContext(ownerPath: string): ViteHotContext {
  return new HMRContext(hmrClient, ownerPath);
}
