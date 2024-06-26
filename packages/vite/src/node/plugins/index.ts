import type { HookHandler, Plugin, PluginWithRequiredHook } from "../plugin";

export function getHookHandler(hook: any) {
  return (typeof hook === "object" ? hook.handler : hook) as any;
}

/**
 * 根据指定钩子的顺序（pre、normal、post）对插件进行排序。
 * 排序后的插件将按照指定的钩子顺序插入到结果数组中。
 *
 * @param hookName 要排序的钩子名称
 * @param plugins 插件数组
 * @returns 包含指定钩子的插件数组
 */
export function getSortedPluginsByHook<K extends keyof Plugin>(
  hookName: K,
  plugins: readonly Plugin[]
): PluginWithRequiredHook<K>[] {
  //初始化排序数组和索引
  const sortedPlugins: Plugin[] = [];
  //使用索引来跟踪并直接将有序的插件插入到结果数组中，以避免每个钩子创建3个额外的临时数组

  //pre、normal、post，分别用于跟踪 pre、normal 和 post 插件的位置。
  let pre = 0,
    normal = 0,
    post = 0;

  //遍历插件数组
  for (const plugin of plugins) {
    //每个插件的指定钩子 hook
    const hook = plugin[hookName];
    if (hook) {
      if (typeof hook === "object") {
        //如果 hook 存在且是一个对象，根据 hook.order 的值插入插件到 sortedPlugins 数组的相应位置：
        if (hook.order === "pre") {
          //入到 pre 索引位置，并增加 pre 索引
          sortedPlugins.splice(pre++, 0, plugin);
          continue;
        }
        if (hook.order === "post") {
          //插入到 pre + normal + post 索引位置，并增加 post 索引
          sortedPlugins.splice(pre + normal + post++, 0, plugin);
          continue;
        }
      }

      //其他情况：插入到 pre + normal 索引位置，并增加 normal 索引。
      sortedPlugins.splice(pre + normal++, 0, plugin);
    }
  }

  //返回排序后的插件数组
  return sortedPlugins as PluginWithRequiredHook<K>[];
}
