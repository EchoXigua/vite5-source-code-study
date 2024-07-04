import readline from "node:readline";
import colors from "picocolors";
import { restartServerWithUrls } from "./server";
import type { ViteDevServer } from "./server";
import { isDevServer } from "./utils";
import type { PreviewServer } from "./preview";
import { openBrowser } from "./server/openBrowser";

export type BindCLIShortcutsOptions<Server = ViteDevServer | PreviewServer> = {
  /**
   * 是否在终端打印一行快捷键提示 help
   */
  print?: boolean;
  /**
   * 自定义快捷键数组。这些快捷键优先于默认快捷键。
   * 如果定义了与默认快捷键相同的键但 action 为 undefined，则禁用该默认快捷键
   */
  customShortcuts?: CLIShortcut<Server>[];
};

export type CLIShortcut<Server = ViteDevServer | PreviewServer> = {
  key: string;
  description: string;
  action?(server: Server): void | Promise<void>;
};

/**
 * 用于绑定 CLI 快捷键,以便在 Vite 开发服务器或预览服务器运行时可以通过键盘输入触发某些操作
 * @param server
 * @param opts
 * @returns
 * 
 * @example 
 * bindCLIShortcuts(server, {
      print: true,
      customShortcuts: [
        {
          key: 'r',
          description: 'Restart the server',
          action: async (server) => {
            await server.restart();
          }
        }
      ]
    });
 */
export function bindCLIShortcuts<Server extends ViteDevServer | PreviewServer>(
  server: Server,
  opts?: BindCLIShortcutsOptions<Server>
): void {
  // 没有 HTTP 服务器实例或者当前终端不是 TTY 设备，或者在 CI 环境中
  // 则不绑定快捷键，直接返回
  if (!server.httpServer || !process.stdin.isTTY || process.env.CI) {
    return;
  }

  // 判断当前服务器是否为开发服务器
  const isDev = isDevServer(server);

  if (isDev) {
    // 如果是开发服务器，则将选项存储在服务器实例中
    server._shortcutsOptions = opts as BindCLIShortcutsOptions<ViteDevServer>;
  }

  if (opts?.print) {
    // 如果 print 选项为 true，在终端打印快捷键帮助提示
    server.config.logger.info(
      colors.dim(colors.green("  ➜")) +
        colors.dim("  press ") +
        colors.bold("h + enter") +
        colors.dim(" to show help")
    );
  }

  // 合并自定义快捷键和基础快捷键
  const shortcuts = (opts?.customShortcuts ?? []).concat(
    (isDev
      ? BASE_DEV_SHORTCUTS
      : BASE_PREVIEW_SHORTCUTS) as CLIShortcut<Server>[]
  );

  let actionRunning = false;

  /**
   * 处理终端输入的函数
   * @param input
   * @returns
   */
  const onInput = async (input: string) => {
    if (actionRunning) return;

    if (input === "h") {
      // 每当用户输入并按下回车键时，检查输入是否为 h，如果是则打印所有快捷键的帮助信息
      const loggedKeys = new Set<string>();
      server.config.logger.info("\n  Shortcuts");

      for (const shortcut of shortcuts) {
        if (loggedKeys.has(shortcut.key)) continue;
        loggedKeys.add(shortcut.key);

        if (shortcut.action == null) continue;

        server.config.logger.info(
          colors.dim("  press ") +
            colors.bold(`${shortcut.key} + enter`) +
            colors.dim(` to ${shortcut.description}`)
        );
      }

      return;
    }

    // 找到对应的快捷命令
    const shortcut = shortcuts.find((shortcut) => shortcut.key === input);

    // 如果不存在或者没有对应的action 则直接返回
    if (!shortcut || shortcut.action == null) return;

    // 执行action
    actionRunning = true;
    await shortcut.action(server);
    actionRunning = false;
  };

  // 使用 readline 模块创建一个接口监听终端输入
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", onInput);
  // 在服务器关闭时，关闭 readline 接口
  server.httpServer.on("close", () => rl.close());
}

const BASE_DEV_SHORTCUTS: CLIShortcut<ViteDevServer>[] = [
  {
    key: "r",
    description: "restart the server",
    async action(server) {
      await restartServerWithUrls(server);
    },
  },
  {
    key: "u",
    description: "show server url",
    action(server) {
      server.config.logger.info("");
      server.printUrls();
    },
  },
  {
    key: "o",
    description: "open in browser",
    action(server) {
      server.openBrowser();
    },
  },
  {
    key: "c",
    description: "clear console",
    action(server) {
      server.config.logger.clearScreen("error");
    },
  },
  {
    key: "q",
    description: "quit",
    async action(server) {
      await server.close().finally(() => process.exit());
    },
  },
];

const BASE_PREVIEW_SHORTCUTS: CLIShortcut<PreviewServer>[] = [
  {
    key: "o",
    description: "open in browser",
    action(server) {
      const url =
        server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0];
      if (url) {
        openBrowser(url, true, server.config.logger);
      } else {
        server.config.logger.warn("No URL available to open in browser");
      }
    },
  },
  {
    key: "q",
    description: "quit",
    action(server) {
      try {
        server.httpServer.close();
      } finally {
        process.exit();
      }
    },
  },
];
