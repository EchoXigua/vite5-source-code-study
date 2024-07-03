/**
 * The following is modified based on source found in
 * https://github.com/facebook/create-react-app
 *
 * MIT Licensed
 * Copyright (c) 2015-present, Facebook, Inc.
 * https://github.com/facebook/create-react-app/blob/master/LICENSE
 *
 */

import { join } from "node:path";
import { exec } from "node:child_process";
import type { ExecOptions } from "node:child_process";
import open from "open";
import spawn from "cross-spawn";
import colors from "picocolors";
import type { Logger } from "../logger";
import { VITE_PACKAGE_DIR } from "../constants";

/**
 * 根据环境变量和传入的参数来决定如何打开浏览器
 * @param url 要打开的 URL 地址
 * @param opt 可以是一个字符串，表示要使用的特定浏览器；也可以是 true，表示使用默认浏览器。
 * @param logger
 */
export function openBrowser(
  url: string,
  opt: string | true,
  logger: Logger
): void {
  // The browser executable to open.
  // See https://github.com/sindresorhus/open#app for documentation.
  // 如果 opt 是字符串，则直接使用该字符串作为浏览器的可执行文件路径，不是的话取环境变量BROWSER
  const browser = typeof opt === "string" ? opt : process.env.BROWSER || "";
  // 转小写，且以.js 结尾，说明要执行一个 Node.js 脚本
  if (browser.toLowerCase().endsWith(".js")) {
    executeNodeScript(browser, url, logger);
  } else if (browser.toLowerCase() !== "none") {
    // 如果 BROWSER 的值为 "none"（忽略大小写），则不打开任何浏览器，
    // 不为none，从环境变量 BROWSER_ARGS 中获取浏览器启动参数，
    //并调用 startBrowserProcess 函数启动指定的浏览器进程。
    const browserArgs = process.env.BROWSER_ARGS
      ? process.env.BROWSER_ARGS.split(" ")
      : [];
    startBrowserProcess(browser, browserArgs, url);
  }
}

/**
 * 一个用于执行 Node.js 脚本的函数
 * @param scriptPath
 * @param url
 * @param logger
 */
function executeNodeScript(scriptPath: string, url: string, logger: Logger) {
  /**
   * process.argv[0] 表示 Node.js 可执行文件的路径
   * process.argv[1] 表示正在执行的 JavaScript 文件的路径
   * 从 process.argv[2] 开始，是传递给脚本的命令行参数
   */
  const extraArgs = process.argv.slice(2);
  /**
   * process.execPath 表示当前 Node.js 可执行文件的路径
   * [scriptPath, ...extraArgs, url] 是传递给子进程的命令行参数
   *    scriptPath 是要执行的脚本路径
   *    ...extraArgs 是通过命令行传递给脚本的额外参数
   *    url 是作为脚本的参数传递的 URL。
   * { stdio: "inherit" }： 设置子进程的标准输入、输出和错误与父进程一致，即与当前终端共享输入输出。
   */
  const child = spawn(process.execPath, [scriptPath, ...extraArgs, url], {
    stdio: "inherit",
  });

  child.on("close", (code) => {
    if (code !== 0) {
      // 如果子进程的退出码 code 不为 0，表示脚本执行失败
      logger.error(
        colors.red(
          `\nThe script specified as BROWSER environment variable failed.\n\n${colors.cyan(
            scriptPath
          )} exited with code ${code}.`
        ),
        { error: null }
      );
    }
  });
}

const supportedChromiumBrowsers = [
  "Google Chrome Canary",
  "Google Chrome Dev",
  "Google Chrome Beta",
  "Google Chrome",
  "Microsoft Edge",
  "Brave Browser",
  "Vivaldi",
  "Chromium",
];

/**
 * 用于启动浏览器进程，并尝试使用不同的策略来打开指定的 URL
 * 根据不同的操作系统和用户设置，以尽可能合适的方式打开浏览器并加载指定的 URL
 * @param browser
 * @param browserArgs
 * @param url
 * @returns
 */
async function startBrowserProcess(
  browser: string | undefined,
  browserArgs: string[],
  url: string
) {
  // 检查是否在 macOS 上，并且浏览器是 Chrome 或者支持的 Chromium 浏览器。
  // 如果是这种情况，它会尝试使用 AppleScript 来打开 Chrome，
  // 并尝试重用已经存在的标签页，而不是创建一个新的标签页。
  const preferredOSXBrowser =
    browser === "google chrome" ? "Google Chrome" : browser;
  const shouldTryOpenChromeWithAppleScript =
    process.platform === "darwin" &&
    (!preferredOSXBrowser ||
      supportedChromiumBrowsers.includes(preferredOSXBrowser));

  // 检查是否可以使用 AppleScript 打开 Chrome：
  if (shouldTryOpenChromeWithAppleScript) {
    try {
      // 获取当前正在运行的进程列表,这个命令返回的是一个字符串，包含了当前运行的进程信息。
      const ps = await execAsync("ps cax");

      // 确定是否已经打开了指定的浏览器:
      const openedBrowser =
        // 检查列表中是否包含用户优选的浏览器 preferredOSXBrowser
        preferredOSXBrowser && ps.includes(preferredOSXBrowser)
          ? preferredOSXBrowser
          : // 支持的 Chromium 浏览器
            supportedChromiumBrowsers.find((b) => ps.includes(b));
      if (openedBrowser) {
        // 尽量在AppleScript中重用现有的选项卡
        await execAsync(
          // encodeURI(url) 用于将 URL 编码，确保在 AppleScript 中能正确处理特殊字符
          `osascript openChrome.applescript "${encodeURI(
            url
          )}" "${openedBrowser}"`,
          {
            // 设置了命令执行的工作目录，这里使用了 VITE_PACKAGE_DIR 变量指定的路径下的 bin 目录
            cwd: join(VITE_PACKAGE_DIR, "bin"),
          }
        );
        // 成功打开浏览器并重用了已有的标签页
        return true;
      }
    } catch (err) {
      // Ignore errors
    }
  }

  // Another special case: on OS X, check if BROWSER has been set to "open".
  // In this case, instead of passing the string `open` to `open` function (which won't work),
  // just ignore it (thus ensuring the intended behavior, i.e. opening the system browser):
  // https://github.com/facebook/create-react-app/pull/1690#issuecomment-283518768
  if (process.platform === "darwin" && browser === "open") {
    // 特殊情况处理，因为在这种情况下，传递字符串 "open" 给 open 函数是不起作用的，
    // 它不会打开系统默认的浏览器，而是导致不确定的行为
    browser = undefined;
  }

  // Fallback to open
  // (It will always open new tab)
  // 一般情况处理， browser 不为 "open" 或者不在 macOS 系统上，尝试使用 open 包来打开浏览器
  try {
    const options: open.Options = browser
      ? { app: { name: browser, arguments: browserArgs } }
      : {};
    open(url, options).catch(() => {}); // Prevent `unhandledRejection` error.
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 可以通过异步的方式执行系统命令，并根据执行结果进行相应的处理
 * @param command
 * @param options
 * @returns
 */
function execAsync(command: string, options?: ExecOptions): Promise<string> {
  // exec 用于执行命令行命令。它是 child_process 模块中的一个函数，用于在子进程中执行系统命令。
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.toString());
      }
    });
  });
}
