import path from "node:path";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import type { RollupError } from "rollup";

import type { CustomPayload, HMRPayload, Update } from "types/hmrPayload";
import { withTrailingSlash, wrapId } from "../../shared/utils";

const whitespaceRE = /\s/;

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
