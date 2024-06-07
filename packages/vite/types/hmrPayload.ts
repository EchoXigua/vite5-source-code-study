export interface ConnectedPayload {
  type: "connected";
}

export interface UpdatePayload {
  type: "update";
  updates: Update[];
}
export interface Update {
  type: "js-update" | "css-update";
  path: string; //发生更新的模块路径
  acceptedPath: string; //被接受的模块路径。在一些情况下，接受的路径可能与实际更新的路径不同。
  timestamp: number; //更新发生的时间戳
  /** @internal */
  explicitImportRequired?: boolean; //是否需要显式导入更新后的模块
  /** @internal */
  isWithinCircularImport?: boolean; //更新是否发生在循环导入的情况下
  /** @internal */
  ssrInvalidates?: string[]; //表示服务端渲染失效的模块路径列表
}
export interface PrunePayload {
  type: "prune";
  paths: string[];
}
export interface FullReloadPayload {
  type: "full-reload";
  path?: string;
  /** @internal */
  triggeredBy?: string;
}
export interface ErrorPayload {
  type: "error";
  err: {
    [name: string]: any;
    message: string;
    stack: string;
    id?: string;
    frame?: string;
    plugin?: string;
    pluginCode?: string;
    loc?: {
      file?: string;
      line: number;
      column: number;
    };
  };
}
