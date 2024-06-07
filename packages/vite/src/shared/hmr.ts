import type { ModuleNamespace, ViteHotContext } from "../../types/hot";
import type { Update } from "../../types/hmrPayload";
import type { InferCustomEventPayload } from "../../types/customEvent";

type CustomListenersMap = Map<string, ((data: any) => void)[]>;

interface HotModule {
  id: string;
  callbacks: HotCallback[];
}

interface HotCallback {
  // the dependencies must be fetchable paths
  deps: string[];
  fn: (modules: Array<ModuleNamespace | undefined>) => void;
}

export interface HMRLogger {
  error(msg: string | Error): void;
  debug(...msg: unknown[]): void;
}
export interface HMRConnection {
  /**
   * 用于检查连接是否准备就绪，即是否可以向客户端发送消息。
   * 通常在发送消息之前会调用这个方法来确保连接处于可用状态。
   */
  isReady(): boolean;
  /**
   * 用于向客户端发送消息
   */
  send(messages: string): void;
}

/**
 * 为了提供在模块热替换（Hot Module Replacement，HMR）过程中操作相关上下文的方法
 */
export class HMRContext implements ViteHotContext {
  private newListeners: CustomListenersMap;

  constructor(
    private hmrClient: HMRClient,
    private ownerPath: string //当前模块路径的字符串
  ) {
    if (!hmrClient.dataMap.has(ownerPath)) {
      //检查是否有关联于当前路径的数据，如果没有，则创建一个新的映射
      hmrClient.dataMap.set(ownerPath, {});
    }

    //清除与当前路径相关的旧的回调和自定义事件监听器，为新的监听器创建一个新的映射，并将它们添加到相应的地方
    const mod = hmrClient.hotModulesMap.get(ownerPath);
    if (mod) {
      mod.callbacks = [];
    }

    const staleListeners = hmrClient.ctxToListenersMap.get(ownerPath);
    if (staleListeners) {
      for (const [event, staleFns] of staleListeners) {
        const listeners = hmrClient.customListenersMap.get(event);
        if (listeners) {
          hmrClient.customListenersMap.set(
            event,
            listeners.filter((l) => !staleFns.includes(l))
          );
        }
      }
    }

    this.newListeners = new Map();
    hmrClient.ctxToListenersMap.set(ownerPath, this.newListeners);
  }

  //返回当前模块路径的数据。在构造函数中创建了一个与路径关联的数据映射，这里返回了它。
  get data(): any {
    return this.hmrClient.dataMap.get(this.ownerPath);
  }

  /**
   * 用于接受模块热替换的更新,它可以接受三种不同的用法
   * 1. 没有参数或者参数是函数，表示接受当前模块的更新
   * 2. 参数是字符串，表示接受指定模块的更新
   * 3. 参数是字符串数组，表示接受指定模块数组的更新
   * @param deps
   * @param callback
   */
  accept(deps?: any, callback?: any): void {
    if (typeof deps === "function" || !deps) {
      this.acceptDeps([this.ownerPath], ([mod]) => deps?.(mod));
    } else if (Array.isArray(deps)) {
      this.acceptDeps(deps, callback);
    } else {
      throw new Error("invalid hot.accept() usage");
    }
  }

  /**
   * 用于接受导出的模块，并注册相应的回调函数。
   * @param _   接受导出的模块的名称,在客户端，这个参数通常是无关紧要的，
   * 因为导出的模块通常是在服务器端进行处理并传播给客户端的,
   * 这个参数可以是一个字符串或一个字符串数组，但在客户端并不使用它。
   * @param callback 用于处理接受到的导出模块的操作
   */
  acceptExports(
    _: string | readonly string[],
    callback: (data: any) => void
  ): void {
    this.acceptDeps([this.ownerPath], ([mod]) => callback?.(mod));
  }

  //用于清除模块的副作用
  dispose(cb: (data: any) => void): void {
    this.hmrClient.disposeMap.set(this.ownerPath, cb);
  }

  //用于修剪模块的副作用
  prune(cb: (data: any) => void): void {
    this.hmrClient.pruneMap.set(this.ownerPath, cb);
  }

  decline(): void {}

  //这个方法用于使当前模块失效。它通知 HMR 客户端模块失效，并触发相应的自定义事件。
  invalidate(message: string): void {
    this.hmrClient.notifyListeners("vite:invalidate", {
      path: this.ownerPath,
      message,
    });

    this.send("vite:invalidate", { path: this.ownerPath, message });
    this.hmrClient.logger.debug(
      `[vite] invalidate ${this.ownerPath}${message ? `: ${message}` : ""}`
    );
  }

  //用于注册自定义事件监听器
  on<T extends string>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void
  ) {
    const addToMap = (map: Map<string, any[]>) => {
      const existing = map.get(event) || [];
      existing.push(cb);
      map.set(event, existing);
    };
    addToMap(this.hmrClient.customListenersMap);
    addToMap(this.newListeners);
  }

  //用于取消注册自定义事件监听器
  off<T extends string>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void
  ) {
    const removeFromMap = (map: Map<string, any[]>) => {
      const existing = map.get(event);
      if (existing === undefined) {
        return;
      }
      const pruned = existing.filter((l) => l !== cb);
      if (pruned.length === 0) {
        map.delete(event);
        return;
      }
      map.set(event, pruned);
    };
    removeFromMap(this.hmrClient.customListenersMap);
    removeFromMap(this.newListeners);
  }

  send<T extends string>(event: T, data?: InferCustomEventPayload<T>): void {
    this.hmrClient.messenger.send(
      JSON.stringify({ type: "custom", event, data })
    );
  }

  /**
   * 用于接受模块的更新依赖，并注册相应的回调函数
   * @param deps 表示当前模块更新依赖的路径数组,当这些依赖中的任何一个发生更新时，相关的回调函数将被触发
   * @param callback 用于处理模块更新依赖发生变化时的操作
   */
  private acceptDeps(
    deps: string[],
    callback: HotCallback["fn"] = () => {}
  ): void {
    const mod: HotModule = this.hmrClient.hotModulesMap.get(this.ownerPath) || {
      id: this.ownerPath,
      callbacks: [],
    };
    //将当前模块更新依赖的路径数组和回调函数添加到 HotModule 对象的 callbacks 属性中，
    //以便在更新发生时执行相应的操作
    mod.callbacks.push({
      deps,
      fn: callback,
    });

    //将更新后的 HotModule 对象重新存储到 HMRClient 实例的 hotModulesMap 中，以更新模块的回调函数列表。
    this.hmrClient.hotModulesMap.set(this.ownerPath, mod);
  }
}

//用于管理 HMR 消息的发送。
class HMRMessenger {
  constructor(private connection: HMRConnection) {}

  //一个存储消息的队列，用于暂时保存要发送的消息
  private queue: string[] = [];

  //向消息队列中添加消息,每次调用 send 方法都会将消息添加到队列中，并尝试立即发送队列中的所有消息。
  public send(message: string): void {
    this.queue.push(message);
    this.flush();
  }

  //用于将队列中的消息发送到客户端
  public flush(): void {
    //它会检查连接是否准备就绪，如果连接就绪，则将队列中的所有消息发送出去，并清空队列。
    if (this.connection.isReady()) {
      this.queue.forEach((msg) => this.connection.send(msg));
      this.queue = [];
    }
  }
}

//用于管理模块的热模块替换
export class HMRClient {
  //存储模块的热模块信息
  public hotModulesMap = new Map<string, HotModule>();
  //存储模块的清理函数，用于清理模块的副作用
  public disposeMap = new Map<string, (data: any) => void | Promise<void>>();
  //存储模块的修剪函数，用于清理不再导入的模块的副作用
  public pruneMap = new Map<string, (data: any) => void | Promise<void>>();
  //存储模块的数据。
  public dataMap = new Map<string, any>();
  //存储自定义事件的监听器
  public customListenersMap: CustomListenersMap = new Map();
  //存储上下文到监听器的映射。
  public ctxToListenersMap = new Map<string, CustomListenersMap>();

  //用于发送和接收 HMR 消息的实例。
  public messenger: HMRMessenger;

  constructor(
    public logger: HMRLogger,
    connection: HMRConnection,
    private importUpdatedModule: (update: Update) => Promise<ModuleNamespace>
  ) {
    this.messenger = new HMRMessenger(connection);
  }

  public async notifyListeners<T extends string>(
    event: T,
    data: InferCustomEventPayload<T>
  ): Promise<void>;
  public async notifyListeners(event: string, data: any): Promise<void> {
    const cbs = this.customListenersMap.get(event);
    if (cbs) {
      await Promise.allSettled(cbs.map((cb) => cb(data)));
    }
  }

  public clear(): void {
    this.hotModulesMap.clear();
    this.disposeMap.clear();
    this.pruneMap.clear();
    this.dataMap.clear();
    this.customListenersMap.clear();
    this.ctxToListenersMap.clear();
  }

  /**
   * 用于清理页面上不再导入的模块的副作用，例如样式注入等
   * @param paths 表示要清理的模块路径
   */
  public async prunePaths(paths: string[]): Promise<void> {
    /**
     * 使用 Promise.all() 来并行处理所有路径，对每个路径执行对应模块的清理函数。
     * 清理函数从 disposeMap 中获取，然后调用以清理模块的副作用。
     * 如果模块的清理函数存在，就调用它，并传递模块的数据给它
     */
    await Promise.all(
      paths.map((path) => {
        const disposer = this.disposeMap.get(path);
        if (disposer) return disposer(this.dataMap.get(path));
      })
    );

    //遍历 paths 数组，对每个路径执行相应的修剪函数。
    //修剪函数从 pruneMap 中获取，然后调用以执行模块的修剪操作。
    paths.forEach((path) => {
      const fn = this.pruneMap.get(path);
      if (fn) {
        fn(this.dataMap.get(path));
      }
    });
  }

  protected warnFailedUpdate(err: Error, path: string | string[]): void {
    if (!err.message.includes("fetch")) {
      this.logger.error(err);
    }
    this.logger.error(
      `[hmr] Failed to reload ${path}. ` +
        `This could be due to syntax errors or importing non-existent ` +
        `modules. (see errors above)`
    );
  }

  //存储要执行的更新操作的 Promise 数组。每个 Promise 表示一个热更新操作，它返回一个函数，该函数用于执行更新
  private updateQueue: Promise<(() => void) | undefined>[] = [];
  //表示是否有更新操作在队列中等待执行。
  private pendingUpdateQueue = false;

  /**
   * 用于将更新操作添加到队列中
   * @param payload 表示要执行的更新操作
   */
  public async queueUpdate(payload: Update): Promise<void> {
    this.updateQueue.push(this.fetchUpdate(payload));

    //如果队列中没有待执行的更新操作,用于缓冲多个热更新操作的机制
    if (!this.pendingUpdateQueue) {
      this.pendingUpdateQueue = true;
      //等待一个微任务队列执行完毕,这一步是为了确保前面的赋值操作已经完成，将任务添加到微任务队列中。
      await Promise.resolve();
      //表示队列中的更新操作已经开始执行。
      this.pendingUpdateQueue = false;

      //将当前更新队列中的所有待执行的更新操作保存到 loading 数组中。
      //这么做是为了避免在遍历更新队列时，因为队列的修改而导致意外的行为
      const loading = [...this.updateQueue];
      //将更新队列清空，以便接受新的更新操作。
      this.updateQueue = [];

      //等待所有更新操作的 Promise 都执行完毕。这样可以确保所有更新操作都已经完成。
      (await Promise.all(loading)).forEach((fn) => fn && fn());

      /**
       * 这段代码的作用是在确保没有其他更新操作在队列中等待执行的情况下，执行当前队列中的所有更新操作，
       * 并在执行完毕后清空队列。这种机制确保了热更新操作按照它们被触发的顺序执行，避免了由于异步操作导致的执行顺序混乱问题。
       */
    }
  }

  /**
   * 用于处理从服务器获取更新后的模块，并执行相应的回调函数来触发模块更新
   * @param update 要更新的模块的信息
   */
  private async fetchUpdate(update: Update): Promise<(() => void) | undefined> {
    const { path, acceptedPath } = update;
    const mod = this.hotModulesMap.get(path);

    //如果获取不到模块对象，可能是因为在代码分割项目中，热更新模块尚未加载，这种情况是常见的。
    if (!mod) return;

    let fetchedModule: ModuleNamespace | undefined;
    const isSelfUpdate = path === acceptedPath;

    //确定哪些回调函数需要执行更新
    const qualifiedCallbacks = mod.callbacks.filter(({ deps }) =>
      deps.includes(acceptedPath)
    );

    //如果是自身更新或者有学语言执行更新的回调函数存在，则执行相关的清理工作和模块更新操作
    if (isSelfUpdate || qualifiedCallbacks.length > 0) {
      const disposer = this.disposeMap.get(acceptedPath);
      if (disposer) await disposer(this.dataMap.get(acceptedPath));

      //尝试重新导入更新后的模块，并将其赋值给 fetchedModule 变量。
      try {
        fetchedModule = await this.importUpdatedModule(update);
      } catch (e) {
        this.warnFailedUpdate(e, acceptedPath);
      }
    }

    return () => {
      for (const { deps, fn } of qualifiedCallbacks) {
        fn(
          deps.map((dep) => (dep === acceptedPath ? fetchedModule : undefined))
        );
      }
      const loggedPath = isSelfUpdate ? path : `${acceptedPath} via ${path}`;
      this.logger.debug(`[vite] hot updated: ${loggedPath}`);
    };
  }
}
