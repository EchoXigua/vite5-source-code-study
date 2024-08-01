import fsp from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import type { RollupError } from "rollup";
import colors from "picocolors";
import { CLIENT_DIR } from "../constants";
import type { CustomPayload, HMRPayload, Update } from "types/hmrPayload";
import { withTrailingSlash, wrapId } from "../../shared/utils";
import { createDebugger, normalizePath } from "../utils";
import type { ModuleNode } from "./moduleGraph";
import type { InferCustomEventPayload, ViteDevServer } from "..";
import { getEnvFilesForMode } from "../env";
import { restartServerWithUrls } from ".";
import { getAffectedGlobModules } from "../plugins/importMetaGlob";
import { isExplicitImportRequired } from "../plugins/importAnalysis";
import { isCSSRequest } from "../plugins/css";

export const debugHmr = createDebugger("vite:hmr");

const whitespaceRE = /\s/;

const normalizedClientDir = normalizePath(CLIENT_DIR);

export interface HmrOptions {
  protocol?: string;
  host?: string;
  port?: number;
  clientPort?: number;
  path?: string;
  timeout?: number;
  overlay?: boolean;
  server?: Server;
  /** @internal */
  channels?: HMRChannel[];
}

export interface HmrContext {
  file: string;
  timestamp: number;
  modules: Array<ModuleNode>;
  read: () => string | Promise<string>;
  server: ViteDevServer;
}

interface PropagationBoundary {
  boundary: ModuleNode;
  acceptedVia: ModuleNode;
  isWithinCircularImport: boolean;
}

export interface HMRBroadcasterClient {
  /**
   * Send event to the client
   */
  send(payload: HMRPayload): void;
  /**
   * Send custom event
   */
  send(event: string, payload?: CustomPayload["data"]): void;
}

export interface HMRChannel {
  /**
   * Unique channel name
   */
  name: string;
  /**
   * Broadcast events to all clients
   */
  send(payload: HMRPayload): void;
  /**
   * Send custom event
   */
  send<T extends string>(event: T, payload?: InferCustomEventPayload<T>): void;
  /**
   * Handle custom event emitted by `import.meta.hot.send`
   */
  on<T extends string>(
    event: T,
    listener: (
      data: InferCustomEventPayload<T>,
      client: HMRBroadcasterClient,
      ...args: any[]
    ) => void
  ): void;
  on(event: "connection", listener: () => void): void;
  /**
   * Unregister event listener
   */
  off(event: string, listener: Function): void;
  /**
   * Start listening for messages
   */
  listen(): void;
  /**
   * Disconnect all clients, called when server is closed or restarted.
   */
  close(): void;
}

export interface HMRBroadcaster extends Omit<HMRChannel, "close" | "name"> {
  /**
   * All registered channels. Always has websocket channel.
   */
  readonly channels: HMRChannel[];
  /**
   * Add a new third-party channel.
   */
  addChannel(connection: HMRChannel): HMRBroadcaster;
  close(): Promise<unknown[]>;
}

/**
 * 这块vite 热更新 更新处理逻辑
 * 用于处理文件的创建、删除和更新，并在这些事件发生时根据文件类型和依赖关系决定如何更新或重载模块
 * @param type
 * @param file 变化的文件路径
 * @param server Vite 的开发服务器实例
 * @returns
 */
export async function handleHMRUpdate(
  type: "create" | "delete" | "update",
  file: string,
  server: ViteDevServer
): Promise<void> {
  /**
   * 从服务器实例中解构出需要的属性
   *
   * hot: 用于发送 HMR 消息
   * config: Vite 的配置信息
   * moduleGraph: 模块图，用于跟踪模块之间的依赖关系
   */
  const { hot, config, moduleGraph } = server;

  /** 获取文件的简短名称，（移除文件的root路径前缀） */
  const shortFile = getShortName(file, config.root);

  // 检查修改的文件是否是 配置文件或者 配置文件的依赖文件
  const isConfig = file === config.configFile;
  const isConfigDependency = config.configFileDependencies.some(
    (name) => file === name
  );

  // 检查修改的文件是否 env 文件（如果行类配置没有明确禁止env环境的话）
  const isEnv =
    config.inlineConfig.envFile !== false &&
    getEnvFilesForMode(config.mode, config.envDir).includes(file);
  if (isConfig || isConfigDependency || isEnv) {
    // 如果是这些文件，则记录日志并重新启动服务器
    debugHmr?.(`[config change] ${colors.dim(shortFile)}`);
    config.logger.info(
      colors.green(
        `${path.relative(process.cwd(), file)} changed, restarting server...`
      ),
      { clear: true, timestamp: true }
    );
    try {
      await restartServerWithUrls(server);
    } catch (e) {
      config.logger.error(colors.red(e));
    }
    return;
  }

  debugHmr?.(`[file change] ${colors.dim(shortFile)}`);

  // (开发模式下)客户端本身不能热更新
  // 如果文件位于客户端目录中，发送一个 full-reload 消息以重新加载整个页面
  if (file.startsWith(withTrailingSlash(normalizedClientDir))) {
    hot.send({
      type: "full-reload",
      path: "*",
      triggeredBy: path.resolve(config.root, file),
    });
    return;
  }

  /**
   * 根据文件路径获取与该文件关联的模块集合，放入一个 Set 集合中，以确保模块是唯一的
   */
  const mods = new Set(moduleGraph.getModulesByFile(file));
  // 处理文件创建
  if (type === "create") {
    // 获取所有解析失败的模块,这些模块可能因为文件缺失等原因在之前的构建过程中无法解析
    // 将这些解析失败的模块添加到 mods 集合中, 这样做的目的是在新文件创建时重新尝试解析这些模块
    for (const mod of moduleGraph._hasResolveFailedErrorModules) {
      mods.add(mod);
    }
  }
  // 处理文件创建或文件删除
  if (type === "create" || type === "delete") {
    // 根据文件路径和服务器实例获取所有受影响的模块
    // 这通常用于处理使用 glob 模式导入的模块，因为这些模块的导入关系可能会随着文件的创建或删除而改变
    for (const mod of getAffectedGlobModules(file, server)) {
      mods.add(mod);
    }
  }

  // 检查是否有任何插件想要执行自定义HMR处理
  const timestamp = Date.now(); // 记录当前时间戳
  // 创建hmr上下文信息
  const hmrContext: HmrContext = {
    file, // 变化的文件路径
    timestamp, // 当前时间戳
    modules: [...mods], // 受影响的模块列表
    read: () => readModifiedFile(file), // 读取修改文件的函数
    server, //Vite 开发服务器实例
  };

  // 这里会处理 插件自定义的 HMR
  if (type === "update") {
    for (const hook of config.getSortedPluginHooks("handleHotUpdate")) {
      // 获取所有插件的 handleHotUpdate 钩子，并按顺序执行这些钩子
      const filteredModules = await hook(hmrContext);
      if (filteredModules) {
        // 如果钩子函数有返回值, 则更新 hmrContext.modules 为过滤后的模块列表。这允许插件自定义处理 HMR 逻辑
        hmrContext.modules = filteredModules;
      }
    }
  }

  // 处理没有受影响的模块
  if (!hmrContext.modules.length) {
    // 说明没有影响任何模块

    // html文件不支持热更新,这里会检查一下是不是html文件发现了变化,如果修改的是html,则触发重新加载
    if (file.endsWith(".html")) {
      // 记录日志信息
      config.logger.info(colors.green(`page reload `) + colors.dim(shortFile), {
        clear: true,
        timestamp: true,
      });
      // 让客户端重新加载页面
      hot.send({
        type: "full-reload",
        path: config.server.middlewareMode
          ? "*"
          : "/" + normalizePath(path.relative(config.root, file)),
      });
    } else {
      // 否则，可能修改的不是js文件,记录没有模块匹配的调试信息
      debugHmr?.(`[no modules matched] ${colors.dim(shortFile)}`);
    }
    return;
  }

  // 更新受影响的模块
  updateModules(shortFile, hmrContext.modules, timestamp, server);
}

type HasDeadEnd = boolean;

/**
 * 用于处理在 Vite 开发服务器中，当文件发生变化时的模块热更新
 * 它根据变化的文件及其相关模块，决定是进行局部模块更新还是全局页面重载，从而实现高效的开发体验
 * @param file 变化的文件路径
 * @param modules 受影响的模块列表
 * @param timestamp 当前时间戳
 * @param param3
 * @param afterInvalidation 表示是否在失效后执行
 * @returns
 */
export function updateModules(
  file: string,
  modules: ModuleNode[],
  timestamp: number,
  { config, hot, moduleGraph }: ViteDevServer,
  afterInvalidation?: boolean
): void {
  /**存储需要更新的模块信息 */
  const updates: Update[] = [];
  /**存储已失效的模块 */
  const invalidatedModules = new Set<ModuleNode>();
  /**存储已遍历的模块 */
  const traversedModules = new Set<ModuleNode>();
  // 如果根模块通过import.meta.hot.invalidate()失效，则模块可能为空。
  /**表示 此次文件发生变化没有模块受到影响，则需要进行全局页面重载 */
  let needFullReload: HasDeadEnd = modules.length === 0;

  // 遍历每个受影响的模块
  for (const mod of modules) {
    /**存储模块传播边界，记录哪些模块需要更新 */
    const boundaries: PropagationBoundary[] = [];

    // 这个函数会遍历模块的依赖关系，检查模块及其依赖是否可以被更新
    // 如果某个模块的依赖链中有任何一个模块无法被热更新（比如没有定义 HMR 处理逻辑），则认为存在“死胡同”（dead end）
    // 当我们说一个模块是“死胡同”时，指的是该模块的更新不能有效地传递给它的依赖模块。
    // 也就是说，它的更新不会导致其他模块的更新，因此系统需要采取更激进的措施，如全页面重新加载。
    /**表示当前模块的更新是否存在死胡同 */
    const hasDeadEnd = propagateUpdate(mod, traversedModules, boundaries);

    // 将当前模块标记为失效，并添加到已失效集合中,这样做的目的是失效的模块需要重新加载或重新编译
    // 传入 true 表示在失效过程中递归地处理模块依赖,确保所有依赖此模块的模块也被标记为失效
    moduleGraph.invalidateModule(mod, invalidatedModules, timestamp, true);

    // 需要全局重载则跳过,后续的遍历都会跳过,因为一旦确定需要全局重载就没有必要再处理剩余模块,节省性能开销
    if (needFullReload) {
      continue;
    }

    // 存在死胡同则跳过当前模块,设置needFullReload 的值,这代表后续的遍历都会跳过
    if (hasDeadEnd) {
      needFullReload = hasDeadEnd;
      continue;
    }

    updates.push(
      //  对数组中的每个元素进行遍历，创建一个新的对象,添加到 updates 中
      ...boundaries.map(
        /**
         * boundary：当前模块边界的信息。
         * acceptedVia：当前模块是通过哪个模块被接受的，即它的依赖关系
         * isWithinCircularImport：布尔值，指示当前模块是否在循环依赖中
         */
        ({ boundary, acceptedVia, isWithinCircularImport }) => ({
          // 更新类型,如 js和 -update 拼接起来，得到类似 js-update 的字符串,这里有js更新和css更新
          type: `${boundary.type}-update` as const,
          // 当前时间戳，用于标记更新的时间
          timestamp,
          // 更新模块的路径,并规范化路径
          path: normalizeHmrUrl(boundary.url),
          // 接受更新的模块路径,规范化路径
          acceptedPath: normalizeHmrUrl(acceptedVia.url),
          // 指示是否需要显式导入,对于js文件的更新 需要去进行检查
          explicitImportRequired:
            boundary.type === "js"
              ? isExplicitImportRequired(acceptedVia.url)
              : false,
          // 表示当前模块是否在循环依赖中
          isWithinCircularImport,
          // browser modules are invalidated by changing ?t= query,
          // but in ssr we control the module system, so we can directly remove them form cache
          /**
           * 1. 浏览器环境下的模块失效:
           * 在浏览器中，缓存的模块可以通过 URL 的变化来失效。添加或更新 ?t= 查询参数，可以让浏览器认为这是一个新的请求，从而重新加载模块
           * @example
           * /path/to/module.js?t=123456，这里的 ?t=123456 是时间戳或其他变化的值，用于强制浏览器重新加载模块
           *
           * 2. SSR 环境下的模块失效:
           * 在 SSR 环境中，开发者可以直接控制模块系统，因此可以精确地将失效的模块从缓存中移除
           * 在 Node.js 中，可以使用 require.cache 来直接操作模块缓存
           */

          // 获取需要在 SSR 环境中失效的模块
          ssrInvalidates: getSSRInvalidatedImporters(acceptedVia),
        })
      )
    );
  }

  // 遍历处理完受到影响的模块后,根据不同情况决定如何通知客户端进行更新

  if (needFullReload) {
    // 页面需要完全重新加载

    // 记录需要重新加载的原因,如果是字符串,将其作为原因附加到日志中
    const reason =
      typeof needFullReload === "string"
        ? colors.dim(` (${needFullReload})`)
        : "";

    // 记录日志信息,将文件路径和原因附加到日志中
    config.logger.info(
      colors.green(`page reload `) + colors.dim(file) + reason,
      { clear: !afterInvalidation, timestamp: true }
    );

    // 通知客户端需要进行页面的完全重新加载
    hot.send({
      type: "full-reload",
      triggeredBy: path.resolve(config.root, file), //表示触发重新加载的文件路径
    });
    return;
  }

  if (updates.length === 0) {
    // 表示没有需要更新的模块,记录没有发生更新的调试信息
    debugHmr?.(colors.yellow(`no update happened `) + colors.dim(file));
    return;
  }

  // 记录 HMR 更新的日志消息
  config.logger.info(
    colors.green(`hmr update `) +
      // 将所有更新的模块路径（去重后）合并成一个字符串，并附加到日志中
      colors.dim([...new Set(updates.map((u) => u.path))].join(", ")),
    { clear: !afterInvalidation, timestamp: true }
  );

  // 通知客户端需要进行模块的热更新,updates 包含了所有需要更新的模块信息
  hot.send({
    type: "update",
    updates,
  });
}

export function createHMRBroadcaster(): HMRBroadcaster {
  const channels: HMRChannel[] = [];
  const readyChannels = new WeakSet<HMRChannel>();
  const broadcaster: HMRBroadcaster = {
    get channels() {
      return [...channels];
    },
    addChannel(channel) {
      if (channels.some((c) => c.name === channel.name)) {
        throw new Error(`HMR channel "${channel.name}" is already defined.`);
      }
      channels.push(channel);
      return broadcaster;
    },
    on(event: string, listener: (...args: any[]) => any) {
      // emit connection event only when all channels are ready
      if (event === "connection") {
        // make a copy so we don't wait for channels that might be added after this is triggered
        const channels = this.channels;
        channels.forEach((channel) =>
          channel.on("connection", () => {
            readyChannels.add(channel);
            if (channels.every((c) => readyChannels.has(c))) {
              listener();
            }
          })
        );
        return;
      }
      channels.forEach((channel) => channel.on(event, listener));
      return;
    },
    off(event, listener) {
      channels.forEach((channel) => channel.off(event, listener));
      return;
    },
    send(...args: any[]) {
      channels.forEach((channel) => channel.send(...(args as [any])));
    },
    listen() {
      channels.forEach((channel) => channel.listen());
    },
    close() {
      return Promise.all(channels.map((channel) => channel.close()));
    },
  };
  return broadcaster;
}

export interface ServerHMRChannel extends HMRChannel {
  api: {
    innerEmitter: EventEmitter;
    outsideEmitter: EventEmitter;
  };
}

export function createServerHMRChannel(): ServerHMRChannel {
  const innerEmitter = new EventEmitter();
  const outsideEmitter = new EventEmitter();

  return {
    name: "ssr",
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
      outsideEmitter.emit("send", payload);
    },
    off(event, listener: () => void) {
      innerEmitter.off(event, listener);
    },
    on: ((event: string, listener: () => unknown) => {
      innerEmitter.on(event, listener);
    }) as ServerHMRChannel["on"],
    close() {
      innerEmitter.removeAllListeners();
      outsideEmitter.removeAllListeners();
    },
    listen() {
      innerEmitter.emit("connection");
    },
    api: {
      innerEmitter,
      outsideEmitter,
    },
  };
}

/**
 * 用于获取一个文件相对于某个根目录的相对路径。如果文件不在该根目录下，则返回文件的原始路径
 * @param file
 * @param root
 * @returns
 */
export function getShortName(file: string, root: string): string {
  return file.startsWith(withTrailingSlash(root))
    ? path.posix.relative(root, file)
    : file;
}

export function normalizeHmrUrl(url: string): string {
  if (url[0] !== "." && url[0] !== "/") {
    url = wrapId(url);
  }
  return url;
}

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray,
}

/**
 * Lex import.meta.hot.accept() for accepted deps.
 * Since hot.accept() can only accept string literals or array of string
 * literals, we don't really need a heavy @babel/parse call on the entire source.
 *
 * @returns selfAccepts
 */
export function lexAcceptedHmrDeps(
  code: string,
  start: number,
  urls: Set<{ url: string; start: number; end: number }>
): boolean {
  let state: LexerState = LexerState.inCall;
  // the state can only be 2 levels deep so no need for a stack
  let prevState: LexerState = LexerState.inCall;
  let currentDep: string = "";

  function addDep(index: number) {
    urls.add({
      url: currentDep,
      start: index - currentDep.length - 1,
      end: index + 1,
    });
    currentDep = "";
  }

  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i);
    switch (state) {
      case LexerState.inCall:
      case LexerState.inArray:
        if (char === `'`) {
          prevState = state;
          state = LexerState.inSingleQuoteString;
        } else if (char === `"`) {
          prevState = state;
          state = LexerState.inDoubleQuoteString;
        } else if (char === "`") {
          prevState = state;
          state = LexerState.inTemplateString;
        } else if (whitespaceRE.test(char)) {
          continue;
        } else {
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray;
            } else {
              // reaching here means the first arg is neither a string literal
              // nor an Array literal (direct callback) or there is no arg
              // in both case this indicates a self-accepting module
              return true; // done
            }
          } else if (state === LexerState.inArray) {
            if (char === `]`) {
              return false; // done
            } else if (char === ",") {
              continue;
            } else {
              error(i);
            }
          }
        }
        break;
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          addDep(i);
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false;
          } else {
            state = prevState;
          }
        } else {
          currentDep += char;
        }
        break;
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          addDep(i);
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false;
          } else {
            state = prevState;
          }
        } else {
          currentDep += char;
        }
        break;
      case LexerState.inTemplateString:
        if (char === "`") {
          addDep(i);
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false;
          } else {
            state = prevState;
          }
        } else if (char === "$" && code.charAt(i + 1) === "{") {
          error(i);
        } else {
          currentDep += char;
        }
        break;
      default:
        throw new Error("unknown import.meta.hot lexer state");
    }
  }
  return false;
}

export function lexAcceptedHmrExports(
  code: string,
  start: number,
  exportNames: Set<string>
): boolean {
  const urls = new Set<{ url: string; start: number; end: number }>();
  lexAcceptedHmrDeps(code, start, urls);
  for (const { url } of urls) {
    exportNames.add(url);
  }
  return urls.size > 0;
}

function error(pos: number) {
  const err = new Error(
    `import.meta.hot.accept() can only accept string literals or an ` +
      `Array of string literals.`
  ) as RollupError;
  err.pos = pos;
  throw err;
}

export function handlePrunedModules(
  mods: Set<ModuleNode>,
  { hot }: ViteDevServer
): void {
  // update the disposed modules' hmr timestamp
  // since if it's re-imported, it should re-apply side effects
  // and without the timestamp the browser will not re-import it!
  const t = Date.now();
  mods.forEach((mod) => {
    mod.lastHMRTimestamp = t;
    mod.lastHMRInvalidationReceived = false;
    debugHmr?.(`[dispose] ${colors.dim(mod.file)}`);
  });
  hot.send({
    type: "prune",
    paths: [...mods].map((m) => m.url),
  });
}

// vitejs/vite#610 when hot-reloading Vue files, we read immediately on file
// change event and sometimes this can be too early and get an empty buffer.
// Poll until the file's modified time has changed before reading again.
/**
 * 这个函数通过检测文件修改时间来处理文件可能正在被修改的情况，确保最终读取到的文件内容是完整的。这对于需要读取频繁被修改的文件时特别有用。
 *
 * @param file
 * @returns
 */
async function readModifiedFile(file: string): Promise<string> {
  // 读取文件内容
  const content = await fsp.readFile(file, "utf-8");

  // 检查文件内容是否为空
  if (!content) {
    // 获取文件的修改时间，并将其存储在 mtime 变量中
    const mtime = (await fsp.stat(file)).mtimeMs;

    // 使用一个循环等待最多 100 毫秒,每次等待后检查文件的修改时间是否发生变化。如果修改时间发生变化，则退出循环
    /**
     * 这个循环的目的是处理在文件系统事件触发后立即读取文件时可能出现的问题，特别是当文件正在被修改时，
     * 可能会读取到不完整或空的内容。通过轮询文件的修改时间，这段代码确保在文件完全修改完成之后再读取文件内容。
     */
    for (let n = 0; n < 10; n++) {
      await new Promise((r) => setTimeout(r, 10));
      // 获取文件的最新修改时间
      const newMtime = (await fsp.stat(file)).mtimeMs;
      // 如果修改时间发生变化，表示文件修改已经完成，退出循环
      if (newMtime !== mtime) {
        break;
      }
    }

    // 再次读取文件的内容，并返回该内容
    return await fsp.readFile(file, "utf-8");
  } else {
    // 返回读取到的内容
    return content;
  }
}

function populateSSRImporters(
  module: ModuleNode,
  timestamp: number,
  seen: Set<ModuleNode> = new Set()
) {
  module.ssrImportedModules.forEach((importer) => {
    if (seen.has(importer)) {
      return;
    }
    if (
      importer.lastHMRTimestamp === timestamp ||
      importer.lastInvalidationTimestamp === timestamp
    ) {
      seen.add(importer);
      populateSSRImporters(importer, timestamp, seen);
    }
  });
  return seen;
}

function getSSRInvalidatedImporters(module: ModuleNode) {
  return [...populateSSRImporters(module, module.lastHMRTimestamp)].map(
    (m) => m.file!
  );
}

/**
 * 这个函数的作用是确保一个模块的所有导入都能被它的导出接受，从而支持部分模块热更新
 *
 * @param importedBindings 模块导入的绑定名集合
 * @param acceptedExports 模块接受热更新的导出名集合
 * @returns
 * @example
 * 模块 A 导出 foo 和 bar
 * 模块 B 导入了 A 的 foo 和 baz
 * acceptedExports 是 {foo, bar}，importedBindings 是 {foo, baz}
 */
function areAllImportsAccepted(
  importedBindings: Set<string>,
  acceptedExports: Set<string>
) {
  // 遍历 导入绑定 中的每一个绑定
  for (const binding of importedBindings) {
    // 检查每个绑定是否在接受的导出中
    if (!acceptedExports.has(binding)) {
      // 表示并不是所有导入都被接受
      return false;
    }
  }
  return true;
}

/**
 * 这个函数的作用是递归地遍历模块的依赖树，以确定哪些模块需要进行更新，
 * 以及哪些模块的更新会导致无法继续热更新（需要完全重新加载页面）
 *
 * @param node 当前正在处理的模块节点
 * @param traversedModules 已经遍历过的模块集合，用于避免重复遍历
 * @param boundaries 存储边界模块的信息，边界模块是那些可以接受热更新的模块
 * @param currentChain 当前递归链中的模块数组，用于检测循环依赖
 * @returns
 */
function propagateUpdate(
  node: ModuleNode,
  traversedModules: Set<ModuleNode>,
  boundaries: PropagationBoundary[],
  currentChain: ModuleNode[] = [node]
): HasDeadEnd {
  // 如果当前模块已经遍历过，直接返回 false，表示没有遇到死胡同
  if (traversedModules.has(node)) {
    return false;
  }

  // 将当前模块添加到已遍历集合中,表示当前模块被处理
  traversedModules.add(node);

  // #7561
  // if the imports of `node` have not been analyzed, then `node` has not
  // been loaded in the browser and we should stop propagation.
  /**
   * 这段注释解释为什么在某些情况下需要停止传播更新
   *
   * 在热更新中，我们需要确定哪些模块需要更新，并且如何正确传播这些更新到依赖这些模块的其他模块
   * propagateUpdate 函数的作用是根据模块的导入和接受情况传播更新,
   * 如果模块或其导入者还没有被分析过，传播过程可能无法正常工作。
   *
   * 停止传播的条件:
   * node.id 的存在表明模块的基本信息已经被处理
   * isSelfAccepting 表示模块是否自我接受更新,如果尚未设置，这意味着该模块在浏览器中尚未被分析
   *
   * 停止传播的原因:
   * 如果模块的导入（即其依赖项）尚未被分析，那么该模块可能尚未加载到浏览器中。因为它的状态在浏览器中尚不可用，无法进行有效的热更新
   * 在这种情况下，继续传播更新可能会导致不一致的状态或无法正确地应用更新。
   */
  if (node.id && node.isSelfAccepting === undefined) {
    debugHmr?.(
      `[propagate update] stop propagation because not analyzed: ${colors.dim(
        node.id
      )}`
    );
    return false;
  }

  /**
   * 我们再来回顾一下在vite的hmr中，一个模块可以有不同的接受方式
   * 1. 完全自接受（self-accepting）：如果一个模块被标记为自我接受，它能够处理自己的更新。
   * 这种情况下，该模块在更新时不需要通知其他模块进行处理。这通常意味着这个模块的更新不会影响其他依赖于它的模块。
   *
   * 2. 部分自接受（partially self-accepting）：模块本身无法完全处理自身的更新，
   * 但它可以处理部分的更新，比如只接受某些导出的部分，它仍然可能需要通知其他模块，以确保整体应用的状态保持一致。
   *
   * 3. 完全不接受（not accepting）：模块无法处理自身的更新，需要重新加载整个模块或整个页面
   */
  // 处理模块自接受更新
  if (node.isSelfAccepting) {
    // 将模块添加到 boundaries 中
    boundaries.push({
      boundary: node, //当前模块
      /**
       * acceptedVia 表示一个模块是如何接受更新的。被设置为 node，这意味着 node 模块本身负责处理更新
       * 这有助于在 HMR 更新时追踪模块更新的来源。
       */
      acceptedVia: node, // 模块被自己接受
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain), //检查模块是否在循环导入中
    });

    // additionally check for CSS importers, since a PostCSS plugin like
    // Tailwind JIT may register any file as a dependency to a CSS file.
    /**
     * 这段注释的作用是解释为什么在传播更新的过程中，还需要额外检查 CSS 导入者
     * 这是为了处理一些特殊情况，例如 PostCSS 插件（如 Tailwind JIT）可能将其他文件注册为 CSS 文件的依赖
     *
     * PostCSS 插件（如 Tailwind JIT）的影响：
     *  1. PostCSS 是一个工具，用于处理 CSS 文件。在构建过程中，PostCSS 插件（如 Tailwind JIT）会对 CSS 文件进行转换和优化。
     *  2. Tailwind JIT（即时编译器）是一个 PostCSS 插件，它能够动态生成所需的 CSS 样式。
     *  在开发模式下，Tailwind JIT 可以将任意文件作为 CSS 文件的依赖项，这意味着 CSS 文件可能依赖于其他非 CSS 文件（例如 Js 文件）
     *
     * 额外检查的原因：
     *  1. 动态依赖：PostCSS 插件可能将非 CSS 文件（例如 Js 文件）作为 CSS 文件的依赖项。
     *  这意味着，在处理 CSS 文件的更新时，相关的非 CSS 文件也可能需要更新
     *
     *  2. 传播更新：在 HMR 过程中，当处理 CSS 文件的更新时，需要确保所有相关的模块
     * （包括那些由 PostCSS 插件动态注册的依赖项）也被正确处理。如果这些依赖项没有被检查和更新，可能会导致页面样式不一致或其他错误。
     */

    // 遍历模块的所有导入者
    for (const importer of node.importers) {
      // 检查导入者是否是 CSS 文件，确保当前链中不包含该导入者以避免循环依赖
      if (isCSSRequest(importer.url) && !currentChain.includes(importer)) {
        // 递归调用 处理 CSS 导入者，更新 boundaries
        // 这里递归是确保所有与当前模块 node 相关的 CSS 导入者也被正确更新
        // 确保 importer 不在 currentChain 中。如果 importer 已经在链中，则表示它已经被处理过，不需要重复处理
        propagateUpdate(
          importer,
          traversedModules,
          boundaries,
          currentChain.concat(importer)
        );
      }
    }

    // 返回 false，表示未遇到死胡同
    return false;
  }

  // A partially accepted module with no importers is considered self accepting,
  // because the deal is "there are parts of myself I can't self accept if they
  // are used outside of me".
  // Also, the imported module (this one) must be updated before the importers,
  // so that they do get the fresh imported module when/if they are reloaded.
  /**
   * 这段代码的注释解释了在 HMR 处理过程中的一个重要概念：部分接受的模块
   *
   * 1. 部分接受的模块：当一个模块接受 HMR 更新时，它可能只接受自己的一部分更改，而不是整个模块。这种情况称为“部分接受”
   *
   * 2. 没有导入者的情况：如果一个模块没有任何导入者（即没有其他模块依赖于它），它被认为是“自我接受”的。
   *    因为没有其他模块会受到这个模块的影响，这个模块的更新不会影响其他模块
   *
   * 如果模块的某些部分被其他模块使用，但它们不能完全自我接受（即不能完全处理这些更新），那么这个模块的更新可能会影响到其他模块。
   * 在这种情况下，模块本身可能需要更新，以确保它能正确处理更新并让其他模块得到最新的状态。
   *
   * 3. 更新顺序：
   * 当处理 HMR 更新时，必须确保被导入的模块（即当前模块）在其导入者之前更新。这是因为导入者依赖于被导入的模块的最新状态。
   * 如果导入者（即依赖于当前模块的其他模块）在当前模块更新之前进行了更新，可能会导致导入者获取到旧的、不一致的模块状态。
   */
  if (node.acceptedHmrExports) {
    // 说明当前模块可以自我处理更新（自我接受），它会被添加到 boundaries 列表中，表明它能接受自身的更新

    boundaries.push({
      boundary: node, // 当前模块
      acceptedVia: node, // 模块被自己接受
      // 检查模块是否在循环导入中
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    });
  } else {
    if (!node.importers.size) {
      // 模块没有导入者，表示它的更新不会影响其他模块（即它是“死胡同”）
      // 返回 true 表示需要强制全页面重新加载
      return true;
    }

    // #3716, #3913
    // For a non-CSS file, if all of its importers are CSS files (registered via
    // PostCSS plugins) it should be considered a dead end and force full reload.
    /**
     * 如果一个非 CSS 文件的所有导入者都是 CSS 文件，这意味着该非 CSS 文件的内容并没有直接影响到 JS 或其他逻辑代码，而只是影响了样式
     * 在这种情况下，当非 CSS 文件更新时，因为它的所有依赖（importers）都是 CSS 文件，这些 CSS 文件可能是由 PostCSS 等工具生成的，
     * 它们并不会处理这些非 CSS 文件的更新。因此，这个非 CSS 文件的更新实际上无法有效传递到其他非 CSS 文件上。
     */
    if (
      !isCSSRequest(node.url) &&
      // 模块的所有导入者都是 CSS 文件（例如通过 PostCSS 插件），这也被视为“死胡同”，
      // 因为非 CSS 文件的更新不会对这些 CSS 文件产生有效影响，导致全页面重新加载。
      [...node.importers].every((i) => isCSSRequest(i.url))
    ) {
      return true;
    }
  }

  // 这块循环逻辑负责在模块更新时传播更改并检查是否需要全页面重新加载。
  // 它主要处理的是在模块更新时如何递归地更新与之相关联的模块，并处理循环依赖和更新边界
  for (const importer of node.importers) {
    /**当前模块链的扩展版，包含当前模块和它的导入者，这用于追踪更新路径，并防止循环依赖问题 */
    const subChain = currentChain.concat(importer);

    // 检查当前的导入者是否已经接受了从当前模块传播的更新
    if (importer.acceptedHmrDeps.has(node)) {
      // 将当前导入者作为一个边界（boundary）添加到 boundaries 数组中。这表示当前导入者接受了更新。
      boundaries.push({
        boundary: importer,
        acceptedVia: node,
        isWithinCircularImport: isNodeWithinCircularImports(importer, subChain),
      });
      continue;
    }

    if (node.id && node.acceptedHmrExports && importer.importedBindings) {
      // 当前模块 node 有有效的 ID 和接受 HMR 导出的模块且导入者有导入绑定

      // 获取当前模块的导入绑定
      const importedBindingsFromNode = importer.importedBindings.get(node.id);
      if (
        importedBindingsFromNode &&
        // 检查从当前模块导入的所有绑定是否都已被接受
        // 这个检查确保了在模块更新时，如果所有依赖的绑定都已被接受，就不需要进一步处理该导入者
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
      ) {
        continue;
      }
    }

    if (
      // 确保当前模块链中不包含当前导入者，这是为了防止递归调用导致无限循环
      !currentChain.includes(importer) &&
      // 递归地调用 propagateUpdate 函数来处理导入者
      // 传递的 subChain 是当前模块链加上当前导入者，用于跟踪更新路径
      propagateUpdate(importer, traversedModules, boundaries, subChain)
    ) {
      // 如果递归调用返回 true，则表示存在死胡同（即无法继续传播更新），因此返回 true
      return true;
    }
  }

  // 这段代码的主要作用是确保模块的更新能够正确地传播到所有相关模块，并且在发现无法继续传播的情况下，能够准确地判断是否需要全页面重新加载
  return false;
}

/**
 * 当一个模块在导入循环中接受热更新（HMR）时，其执行顺序可能无法恢复，因此需要重新加载整个页面
 * 这是因为循环引用中的模块更新可能会导致无法预期的行为和错误
 *
 * @param node The node that accepts HMR and is a boundary
 * @param nodeChain 表示整个导入链,这条链记录了触发热更新的初始模块以及沿途所有经过的模块
 * @param currentChain 从当前模块节点追踪的节点链，默认为 [node],它用于记录当前递归调用过程中经过的所有模块
 * @param traversedModules 已经遍历过的模块集合，用于防止重复处理
 *
 * @example
 * 假设我们有以下模块导入关系：
 * A 导入 B
 * B 导入 C
 * C 导入 D
 * D 导入 E
 * E 导入 A（形成一个循环导入）
 * 
 * A -> B -> C -> D -> E -> A
 * 
 * 从模块 A 开始执行，看看如何检测到循环导入
 * 
 * 第一次递归：fn(A, [A], [A]);
 * A.importers，A 导入 B，B 不在 nodeChain 中，进行第二次递归
 *  const result = fn(
      importer, // B
      nodeChain, // [A]
      currentChain.concat(importer), // [A, B]
      traversedModules
    );

 * 第二次递归：fn(B, [A], [A,B]);
    B.importers，B 导入 C，C 不在 nodeChain 中，进行第三次次递归
    const result = fn(
      importer, // C
      nodeChain, // [A]
      currentChain.concat(importer), // [A, B, C]
      traversedModules
    );
    .....
    第五次递归：fn(E, [A], [A, B, C, D, E])（处理 E 的导入者 A，检测到循环）
    E.importers  E 导入 A  A 在 nodeChain 中，索引为 0
    发现循环导入
    
 */
function isNodeWithinCircularImports(
  node: ModuleNode,
  nodeChain: ModuleNode[],
  currentChain: ModuleNode[] = [node],
  traversedModules = new Set<ModuleNode>()
): boolean {
  // To help visualize how each parameters work, imagine this import graph:
  //
  // A -> B -> C -> ACCEPTED -> D -> E -> NODE
  //      ^--------------------------|
  //
  // ACCEPTED: 接受 HMR 的节点，这里是 node 参数
  // NODE    : 触发 HMR 的初始节点
  //
  // 这个函数将在上面的导入图中返回 true，其中
  // `node`         : ACCEPTED
  // `nodeChain`    : [NODE, E, D, ACCEPTED]
  // `currentChain` : [ACCEPTED, C, B]
  //
  // 这个函数的工作原理是通过检查 node 的任何导入者是否在 nodeChain 中，如果是，则意味着存在一个包含 HMR 接受模块的导入循环

  // 如果当前模块已经遍历过，则直接返回 false
  if (traversedModules.has(node)) {
    return false;
  }

  // 将当前模块加入已遍历集合
  traversedModules.add(node);

  // node.importers 是当前模块的导入者集合。这里遍历每个导入者 importer
  for (const importer of node.importers) {
    // 如果导入者是当前模块本身（自引用），则跳过
    // 自引用是指一个模块导入自己。在检测循环导入时，自引用被认为是安全的，不会导致循环导入问题。
    if (importer === node) continue;

    // a PostCSS plugin like Tailwind JIT may register
    // any file as a dependency to a CSS file.
    // But in that case, the actual dependency chain is separate.
    /**
     * PostCSS 插件（如 Tailwind JIT）可能会将任何文件注册为 CSS 文件的依赖项
     * 然而，这种情况下，依赖关系实际上是分离的：
     * 即这些非 CSS 文件并不直接依赖于 CSS 文件，或这些文件在实际导入链中并不构成直接的循环导入关系
     * 因此，在检测循环导入时，可以忽略这些通过 CSS 文件注册的依赖项，因为它们不会导致实际的循环导入问题
     */

    // 如果导入者是一个 CSS 文件，跳过
    if (isCSSRequest(importer.url)) continue;

    // 在 nodeChain 中查找导入者的索引。如果找到，说明存在循环导入。
    const importerIndex = nodeChain.indexOf(importer);
    if (importerIndex > -1) {
      // 记录额外的调试信息，以便用户可以修复和删除循环导入
      if (debugHmr) {
        // Following explanation above:
        // `importer`                    : E
        // `currentChain` reversed       : [B, C, ACCEPTED]
        // `nodeChain` sliced & reversed : [D, E]
        // Combined                      : [E, B, C, ACCEPTED, D, E]
        const importChain = [
          importer,
          ...[...currentChain].reverse(),
          ...nodeChain.slice(importerIndex, -1).reverse(),
        ];
        debugHmr(
          colors.yellow(`circular imports detected: `) +
            importChain.map((m) => colors.dim(m.url)).join(" -> ")
        );
      }
      return true;
    }

    // 如果当前链 currentChain 不包含导入者，递归调用，检查导入者的导入链
    if (!currentChain.includes(importer)) {
      const result = isNodeWithinCircularImports(
        importer,
        nodeChain,
        // 将导入者添加到当前链，以便在后续递归调用中检测到循环导入
        currentChain.concat(importer),
        traversedModules
      );
      // 如果递归结果为 true，函数立即返回 true
      if (result) return result;
    }
  }
  return false;
}
