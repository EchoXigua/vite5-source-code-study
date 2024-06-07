import type {
  ErrorPayload,
  FullReloadPayload,
  PrunePayload,
  UpdatePayload,
} from "./hmrPayload";

export interface CustomEventMap {
  "vite:beforeUpdate": UpdatePayload;
  "vite:afterUpdate": UpdatePayload;
  "vite:beforePrune": PrunePayload; //资源修剪之前触发
  "vite:beforeFullReload": FullReloadPayload; //在执行完整重载之前触发。
  "vite:error": ErrorPayload; //用于在发生错误时触发
  "vite:invalidate": InvalidatePayload; //用于在使某些资源无效时触发。
  "vite:ws:connect": WebSocketConnectionPayload; //连接建立
  "vite:ws:disconnect": WebSocketConnectionPayload; //连接断开
}

export interface WebSocketConnectionPayload {
  /**
   * @experimental
   * We expose this instance experimentally to see potential usage.
   * This might be removed in the future if we didn't find reasonable use cases.
   * If you find this useful, please open an issue with details so we can discuss and make it stable API.
   */
  webSocket: WebSocket;
}

export interface InvalidatePayload {
  path: string;
  message: string | undefined;
}

export type InferCustomEventPayload<T extends string> =
  T extends keyof CustomEventMap ? CustomEventMap[T] : any;
