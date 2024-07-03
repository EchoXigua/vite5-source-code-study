import path from "node:path";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";

import type { CustomPayload, HMRPayload, Update } from "types/hmrPayload";
import { withTrailingSlash } from "../../shared/utils";

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
