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

export function updateModules(
  file: string,
  modules: ModuleNode[],
  timestamp: number,
  { config, hot, moduleGraph }: ViteDevServer,
  afterInvalidation?: boolean
): void {
  const updates: Update[] = [];
  const invalidatedModules = new Set<ModuleNode>();
  const traversedModules = new Set<ModuleNode>();
  // Modules could be empty if a root module is invalidated via import.meta.hot.invalidate()
  let needFullReload: HasDeadEnd = modules.length === 0;

  for (const mod of modules) {
    const boundaries: PropagationBoundary[] = [];
    const hasDeadEnd = propagateUpdate(mod, traversedModules, boundaries);

    moduleGraph.invalidateModule(mod, invalidatedModules, timestamp, true);

    if (needFullReload) {
      continue;
    }

    if (hasDeadEnd) {
      needFullReload = hasDeadEnd;
      continue;
    }

    updates.push(
      ...boundaries.map(
        ({ boundary, acceptedVia, isWithinCircularImport }) => ({
          type: `${boundary.type}-update` as const,
          timestamp,
          path: normalizeHmrUrl(boundary.url),
          acceptedPath: normalizeHmrUrl(acceptedVia.url),
          explicitImportRequired:
            boundary.type === "js"
              ? isExplicitImportRequired(acceptedVia.url)
              : false,
          isWithinCircularImport,
          // browser modules are invalidated by changing ?t= query,
          // but in ssr we control the module system, so we can directly remove them form cache
          ssrInvalidates: getSSRInvalidatedImporters(acceptedVia),
        })
      )
    );
  }

  if (needFullReload) {
    const reason =
      typeof needFullReload === "string"
        ? colors.dim(` (${needFullReload})`)
        : "";
    config.logger.info(
      colors.green(`page reload `) + colors.dim(file) + reason,
      { clear: !afterInvalidation, timestamp: true }
    );
    hot.send({
      type: "full-reload",
      triggeredBy: path.resolve(config.root, file),
    });
    return;
  }

  if (updates.length === 0) {
    debugHmr?.(colors.yellow(`no update happened `) + colors.dim(file));
    return;
  }

  config.logger.info(
    colors.green(`hmr update `) +
      colors.dim([...new Set(updates.map((u) => u.path))].join(", ")),
    { clear: !afterInvalidation, timestamp: true }
  );
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
async function readModifiedFile(file: string): Promise<string> {
  const content = await fsp.readFile(file, "utf-8");
  if (!content) {
    const mtime = (await fsp.stat(file)).mtimeMs;

    for (let n = 0; n < 10; n++) {
      await new Promise((r) => setTimeout(r, 10));
      const newMtime = (await fsp.stat(file)).mtimeMs;
      if (newMtime !== mtime) {
        break;
      }
    }

    return await fsp.readFile(file, "utf-8");
  } else {
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

function areAllImportsAccepted(
  importedBindings: Set<string>,
  acceptedExports: Set<string>
) {
  for (const binding of importedBindings) {
    if (!acceptedExports.has(binding)) {
      return false;
    }
  }
  return true;
}

function propagateUpdate(
  node: ModuleNode,
  traversedModules: Set<ModuleNode>,
  boundaries: PropagationBoundary[],
  currentChain: ModuleNode[] = [node]
): HasDeadEnd {
  if (traversedModules.has(node)) {
    return false;
  }
  traversedModules.add(node);

  // #7561
  // if the imports of `node` have not been analyzed, then `node` has not
  // been loaded in the browser and we should stop propagation.
  if (node.id && node.isSelfAccepting === undefined) {
    debugHmr?.(
      `[propagate update] stop propagation because not analyzed: ${colors.dim(
        node.id
      )}`
    );
    return false;
  }

  if (node.isSelfAccepting) {
    boundaries.push({
      boundary: node,
      acceptedVia: node,
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    });

    // additionally check for CSS importers, since a PostCSS plugin like
    // Tailwind JIT may register any file as a dependency to a CSS file.
    for (const importer of node.importers) {
      if (isCSSRequest(importer.url) && !currentChain.includes(importer)) {
        propagateUpdate(
          importer,
          traversedModules,
          boundaries,
          currentChain.concat(importer)
        );
      }
    }

    return false;
  }

  // A partially accepted module with no importers is considered self accepting,
  // because the deal is "there are parts of myself I can't self accept if they
  // are used outside of me".
  // Also, the imported module (this one) must be updated before the importers,
  // so that they do get the fresh imported module when/if they are reloaded.
  if (node.acceptedHmrExports) {
    boundaries.push({
      boundary: node,
      acceptedVia: node,
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    });
  } else {
    if (!node.importers.size) {
      return true;
    }

    // #3716, #3913
    // For a non-CSS file, if all of its importers are CSS files (registered via
    // PostCSS plugins) it should be considered a dead end and force full reload.
    if (
      !isCSSRequest(node.url) &&
      [...node.importers].every((i) => isCSSRequest(i.url))
    ) {
      return true;
    }
  }

  for (const importer of node.importers) {
    const subChain = currentChain.concat(importer);

    if (importer.acceptedHmrDeps.has(node)) {
      boundaries.push({
        boundary: importer,
        acceptedVia: node,
        isWithinCircularImport: isNodeWithinCircularImports(importer, subChain),
      });
      continue;
    }

    if (node.id && node.acceptedHmrExports && importer.importedBindings) {
      const importedBindingsFromNode = importer.importedBindings.get(node.id);
      if (
        importedBindingsFromNode &&
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
      ) {
        continue;
      }
    }

    if (
      !currentChain.includes(importer) &&
      propagateUpdate(importer, traversedModules, boundaries, subChain)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check importers recursively if it's an import loop. An accepted module within
 * an import loop cannot recover its execution order and should be reloaded.
 *
 * @param node The node that accepts HMR and is a boundary
 * @param nodeChain The chain of nodes/imports that lead to the node.
 *   (The last node in the chain imports the `node` parameter)
 * @param currentChain The current chain tracked from the `node` parameter
 * @param traversedModules The set of modules that have traversed
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
  // ACCEPTED: the node that accepts HMR. the `node` parameter.
  // NODE    : the initial node that triggered this HMR.
  //
  // This function will return true in the above graph, which:
  // `node`         : ACCEPTED
  // `nodeChain`    : [NODE, E, D, ACCEPTED]
  // `currentChain` : [ACCEPTED, C, B]
  //
  // It works by checking if any `node` importers are within `nodeChain`, which
  // means there's an import loop with a HMR-accepted module in it.

  if (traversedModules.has(node)) {
    return false;
  }
  traversedModules.add(node);

  for (const importer of node.importers) {
    // Node may import itself which is safe
    if (importer === node) continue;

    // a PostCSS plugin like Tailwind JIT may register
    // any file as a dependency to a CSS file.
    // But in that case, the actual dependency chain is separate.
    if (isCSSRequest(importer.url)) continue;

    // Check circular imports
    const importerIndex = nodeChain.indexOf(importer);
    if (importerIndex > -1) {
      // Log extra debug information so users can fix and remove the circular imports
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

    // Continue recursively
    if (!currentChain.includes(importer)) {
      const result = isNodeWithinCircularImports(
        importer,
        nodeChain,
        currentChain.concat(importer),
        traversedModules
      );
      if (result) return result;
    }
  }
  return false;
}
