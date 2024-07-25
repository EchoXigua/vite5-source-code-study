import type { InferCustomEventPayload } from "../../types/customEvent";
import { HMRClient, HMRContext } from "../shared/hmr";
import type { ViteHotContext } from "../../types/hot";
import type { ErrorPayload, HMRPayload } from "../../types/hmrPayload";
import { ErrorOverlay, overlayId } from "./overlay";

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

//服务器主机名，直接从注入的全局常量获取。
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

function cleanUrl(pathname: string): string {
  const url = new URL(pathname, "http://vitejs.dev");
  url.searchParams.delete("direct");
  return url.pathname + url.search;
}

//用于跟踪是否是第一次更新。初始值为 true，表示第一次更新。
let isFirstUpdate = true;
//用于存储过时的 <link> 元素,用于在更新时检测和处理过时的样式表链接
//WeakSet 弱引用，会被被垃圾回收机制自动清除
const outdatedLinkTags = new WeakSet<HTMLLinkElement>();

const debounceReload = (time: number) => {
  let timer: ReturnType<typeof setTimeout> | null;
  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    timer = setTimeout(() => {
      location.reload();
    }, time);
  };
};
const pageReload = debounceReload(50);

const hmrClient = new HMRClient(
  console,
  {
    isReady: () => socket && socket.readyState === 1,
    send: (message) => socket.send(message),
  },
  async function importUpdatedModule({
    acceptedPath,
    timestamp,
    explicitImportRequired,
    isWithinCircularImport,
  }) {
    const [acceptedPathWithoutQuery, query] = acceptedPath.split("?");
    const importPromise = import(
      base +
        acceptedPathWithoutQuery.slice(1) +
        `?${explicitImportRequired ? "import&" : ""}t=${timestamp}${
          query ? `&${query}` : ""
        }`
    );

    if (isWithinCircularImport) {
      importPromise.catch(() => {
        console.info(
          `[hmr] ${acceptedPath} failed to apply HMR as it's within a circular import. Reloading page to reset the execution order. ` +
            `To debug and break the circular import, you can run \`vite --debug hmr\` to log the circular dependency path if a file change triggered it.`
        );
        pageReload();
      });
    }
    return await importPromise;
  }
);

//根据不同的消息类型执行不同的操作
async function handleMessage(payload: HMRPayload) {
  switch (payload.type) {
    case "connected":
      console.debug(`[vite] connected.`);
      //刷新消息传递器（Messenger），确保之前积累的消息都被发送出去。
      hmrClient.messenger.flush();

      //nginx docker 的热更新可能会超时，所有定期向服务器发送 ping 消息以保持 WebSocket 连接的活跃状态（心跳检测）。
      setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          socket.send('{"type":"ping"}');
        }
      }, __HMR_TIMEOUT__);
      break;
    case "update":
      //在更新之前，触发 'vite' 事件通知。
      notifyListeners("vite:beforeUpdate", payload);
      if (hasDocument) {
        /**
         * 处理模块更新时有一种特殊情况：
         *  如果这是第一次更新，并且已经存在错误覆盖层（error overlay），这意味着页面在加载时出现了服务器编译错误，
         *  ，整个模块脚本加载失败（因为其中一个嵌套导入返回 500 状态码）。在这种情况下，仅仅进行普通的模块更新是不够的，
         * 需要执行完整的页面重新加载，以确保页面能够正确加载并显示。
         */
        if (isFirstUpdate && hasErrorOverlay()) {
          window.location.reload();
          return;
        } else {
          if (enableOverlay) {
            clearErrorOverlay();
          }
          isFirstUpdate = false;
        }
      }

      /**
       * 对于每个更新，根据更新类型执行不同的操作：
       *    1. 如果是 JavaScript 更新，则将更新放入更新队列中等待处理
       *    2. 如果是 CSS 更新，则在页面上加载新的样式表，同时移除旧的样式表，以避免页面上出现未样式内容
       */

      await Promise.all(
        payload.updates.map(async (update): Promise<void> => {
          if (update.type === "js-update") {
            return hmrClient.queueUpdate(update);
          }

          //css 更新
          const { path, timestamp } = update;
          const searchUrl = cleanUrl(path);

          /**
           * 这里不能使用带有' [href*=] '的querySelector，因为链接可能使用相对路径，
           * 所以我们需要使用link.href获取包含检查的完整URL。
           */

          //查找页面中引用了该 CSS 文件的 <link> 元素。
          const el = Array.from(
            document.querySelectorAll<HTMLLinkElement>("link")
          ).find(
            (e) =>
              !outdatedLinkTags.has(e) && cleanUrl(e.href).includes(searchUrl)
          );

          if (!el) return;

          const newPath = `${base}${searchUrl.slice(1)}${
            searchUrl.includes("?") ? "&" : "?"
          }t=${timestamp}
                `;

          /**
           * 通过创建一个新的 <link> 标签来更新 CSS 文件，而不是直接替换现有标签的 href 属性。
           * 这么做的好处是可以避免在新样式表加载之前出现闪烁的无样式内容 (FOUC)
           */
          return new Promise((resolve) => {
            //克隆现有的 <link> 标签。
            const newLinkTag = el.cloneNode() as HTMLLinkElement;
            //设置新的 href 属性，指向新的 CSS 文件路径。
            newLinkTag.href = new URL(newPath, el.href).href;

            //定义一个函数，当新的样式表加载成功或失败时，移除旧的 <link> 标签。
            const removeOldEl = () => {
              el.remove();
              console.debug(`[vite] css hot updated: ${searchUrl}`);
              resolve();
            };
            newLinkTag.addEventListener("load", removeOldEl);
            newLinkTag.addEventListener("error", removeOldEl);
            //将旧的 <link> 标签添加到 outdatedLinkTags 集合中，标记为过时。
            outdatedLinkTags.add(el);
            //在旧的 <link> 标签后插入新的 <link> 标签。
            el.after(newLinkTag);
          });
        })
      );
      notifyListeners("vite:afterUpdate", payload);
      break;
    case "custom": {
      notifyListeners(payload.event, payload.data);
      break;
    }
    case "full-reload":
      notifyListeners("vite:beforeFullReload", payload);

      //通过处理 full-reload 事件，在 HMR 过程中确保浏览器在适当的时候重新加载页面，
      //保证开发者在修改 HTML 文件或其他无法热替换的资源时，浏览器能够及时反映这些更改
      if (hasDocument) {
        //只有在浏览器环境下才会执行以下逻辑

        //检查路径和文件类型
        if (payload.path && payload.path.endsWith(".html")) {
          //如果编辑了HTML文件，只有当浏览器当前在该页面上时才重新加载该页。

          //使用 decodeURI(location.pathname) 获取当前页面的路径，并对路径进行解码，处理 URL 编码字符。
          const pagePath = decodeURI(location.pathname);
          //计算 payload 的完整路径
          //base 是基路径，payload.path.slice(1) 去掉路径的第一个字符（通常是 /），然后与 base 拼接成完整路径。
          const payloadPath = base + payload.path.slice(1);
          if (
            pagePath === payloadPath ||
            payload.path === "/index.html" ||
            (pagePath.endsWith("/") && pagePath + "index.html" === payloadPath)
          ) {
            pageReload();
          }
          return;
        } else {
          // 如果路径不存在或不是 '.html' 结尾，直接重新加载页面
          pageReload();
        }
      }
      break;
    case "prune":
      notifyListeners("vite:beforePrune", payload);
      await hmrClient.prunePaths(payload.paths);
      break;
    case "error": {
      notifyListeners("vite:error", payload);
      if (hasDocument) {
        const err = payload.err;
        if (enableOverlay) {
          createErrorOverlay(err);
        } else {
          console.error(
            `[vite] Internal Server Error\n${err.message}\n${err.stack}`
          );
        }
      }
      break;
    }
    default: {
      const check: never = payload;
      return check;
    }
  }

  //case 增加 {} 是为了块级作用域，避免 在case 中变量冲突
}

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

const enableOverlay = __HMR_ENABLE_OVERLAY__;
const hasDocument = "document" in globalThis;

function createErrorOverlay(err: ErrorPayload["err"]) {
  clearErrorOverlay();
  // document.body.appendChild(new ErrorOverlay(err));
}
function clearErrorOverlay() {
  document.querySelectorAll<ErrorOverlay>(overlayId).forEach((n) => n.close());
}

function hasErrorOverlay() {
  return document.querySelectorAll(overlayId).length;
}

/**
 * 不断尝试对指定的 WebSocket 地址进行 ping 操作，直到成功为止
 * @param socketProtocol WebSocket 协议（如 wss 或 ws）
 * @param hostAndPath 主机名和路径
 * @param ms 每次 ping 之间的等待时间，默认为 1000 毫秒
 * @returns
 */
async function waitForSuccessfulPing(
  socketProtocol: string,
  hostAndPath: string,
  ms = 1000
) {
  const pingHostProtocol = socketProtocol === "wss" ? "https" : "http";

  const ping = async () => {
    // A fetch on a websocket URL will return a successful promise with status 400,
    // but will reject a networking error.
    // When running on middleware mode, it returns status 426, and an cors error happens if mode is not no-cors
    try {
      await fetch(`${pingHostProtocol}://${hostAndPath}`, {
        mode: "no-cors", //表示跨域请求
        headers: {
          //使用 Accept 头来识别 ping 请求
          // Custom headers won't be included in a request with no-cors so (ab)use one of the
          // safelisted headers to identify the ping request
          Accept: "text/x-vite-ping",
        },
      });
      //如果请求成功（即使状态码是 400），返回 true，否则返回 false
      return true;
    } catch {}
    return false;
  };

  //如果首次 ping 成功，直接返回。
  if (await ping()) {
    return;
  }
  //等待一段时间
  await wait(ms);

  //轮询等待成功
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (document.visibilityState === "visible") {
      //如果页面可见，尝试 ping。如果成功，跳出循环。
      if (await ping()) {
        break;
      }
      await wait(ms);
    } else {
      //如果页面不可见，调用 waitForWindowShow() 等待页面显示。
      await waitForWindowShow();
    }
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForWindowShow() {
  return new Promise<void>((resolve) => {
    const onChange = async () => {
      if (document.visibilityState === "visible") {
        resolve();
        document.removeEventListener("visibilitychange", onChange);
      }
    };
    document.addEventListener("visibilitychange", onChange);
  });
}
