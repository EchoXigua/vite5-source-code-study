export function getHookHandler(hook: any) {
  return (typeof hook === "object" ? hook.handler : hook) as any;
}
export function getSortedPluginsByHook(
  hookName: any,
  plugins: readonly Plugin[]
): PluginWithRequiredHook<K>[] {
  const sortedPlugins: Plugin[] = [];
  // Use indexes to track and insert the ordered plugins directly in the
  // resulting array to avoid creating 3 extra temporary arrays per hook
  let pre = 0,
    normal = 0,
    post = 0;
  for (const plugin of plugins) {
    const hook = plugin[hookName];
    if (hook) {
      if (typeof hook === "object") {
        if (hook.order === "pre") {
          sortedPlugins.splice(pre++, 0, plugin);
          continue;
        }
        if (hook.order === "post") {
          sortedPlugins.splice(pre + normal + post++, 0, plugin);
          continue;
        }
      }
      sortedPlugins.splice(pre + normal++, 0, plugin);
    }
  }

  return sortedPlugins as PluginWithRequiredHook<K>[];
}
