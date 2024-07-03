/* eslint no-console: 0 */

import readline from "node:readline";
import colors from "picocolors";
import type { RollupError } from "rollup";
import type { ResolvedServerUrls } from "./server";
import { splitRE } from "./utils";

export type LogType = "error" | "warn" | "info";
export type LogLevel = LogType | "silent";
export interface Logger {
  info(msg: string, options?: LogOptions): void;
  warn(msg: string, options?: LogOptions): void;
  warnOnce(msg: string, options?: LogOptions): void;
  error(msg: string, options?: LogErrorOptions): void;
  clearScreen(type: LogType): void;
  hasErrorLogged(error: Error | RollupError): boolean;
  hasWarned: boolean;
}

export interface LogOptions {
  clear?: boolean;
  timestamp?: boolean;
}

export interface LogErrorOptions extends LogOptions {
  error?: Error | RollupError | null;
}

export const LogLevels: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
};

let lastType: LogType | undefined;
let lastMsg: string | undefined;
let sameCount = 0;

function clearScreen() {
  const repeatCount = process.stdout.rows - 2;
  const blank = repeatCount > 0 ? "\n".repeat(repeatCount) : "";
  console.log(blank);

  // 用于从可读流（如 process.stdin）中读取数据，通常用于实现命令行界面（CLI）中的用户输入处理。
  // 它提供了一种接口，使得开发者可以方便地读取和处理来自终端的输入数据。
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
}

export interface LoggerOptions {
  prefix?: string;
  allowClearScreen?: boolean;
  customLogger?: Logger;
}

// Only initialize the timeFormatter when the timestamp option is used, and
// reuse it across all loggers
let timeFormatter: Intl.DateTimeFormat;
function getTimeFormatter() {
  timeFormatter ??= new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  return timeFormatter;
}

const MAX_LOG_CHAR = 5000;

export function createLogger(
  level: LogLevel = "info",
  options: LoggerOptions = {}
): Logger {
  if (options.customLogger) {
    return options.customLogger;
  }

  const loggedErrors = new WeakSet<Error | RollupError>();
  const { prefix = "[vite]", allowClearScreen = true } = options;
  const thresh = LogLevels[level];
  const canClearScreen =
    allowClearScreen && process.stdout.isTTY && !process.env.CI;
  const clear = canClearScreen ? clearScreen : () => {};

  function preventOverflow(msg: string) {
    if (msg.length > MAX_LOG_CHAR) {
      const shorten = msg.slice(0, MAX_LOG_CHAR);
      const lines = msg.slice(MAX_LOG_CHAR).match(splitRE)?.length || 0;

      return `${shorten}\n... and ${lines} lines more`;
    }
    return msg;
  }

  function format(
    type: LogType,
    rawMsg: string,
    options: LogErrorOptions = {}
  ) {
    const msg = preventOverflow(rawMsg);
    if (options.timestamp) {
      const tag =
        type === "info"
          ? colors.cyan(colors.bold(prefix))
          : type === "warn"
          ? colors.yellow(colors.bold(prefix))
          : colors.red(colors.bold(prefix));
      return `${colors.dim(
        getTimeFormatter().format(new Date())
      )} ${tag} ${msg}`;
    } else {
      return msg;
    }
  }

  function output(type: LogType, msg: string, options: LogErrorOptions = {}) {
    if (thresh >= LogLevels[type]) {
      const method = type === "info" ? "log" : type;

      if (options.error) {
        loggedErrors.add(options.error);
      }
      if (canClearScreen) {
        if (type === lastType && msg === lastMsg) {
          sameCount++;
          clear();
          console[method](
            format(type, msg, options),
            colors.yellow(`(x${sameCount + 1})`)
          );
        } else {
          sameCount = 0;
          lastMsg = msg;
          lastType = type;
          if (options.clear) {
            clear();
          }
          console[method](format(type, msg, options));
        }
      } else {
        console[method](format(type, msg, options));
      }
    }
  }

  const warnedMessages = new Set<string>();

  const logger: Logger = {
    hasWarned: false,
    info(msg, opts) {
      output("info", msg, opts);
    },
    warn(msg, opts) {
      logger.hasWarned = true;
      output("warn", msg, opts);
    },
    warnOnce(msg, opts) {
      if (warnedMessages.has(msg)) return;
      logger.hasWarned = true;
      output("warn", msg, opts);
      warnedMessages.add(msg);
    },
    error(msg, opts) {
      logger.hasWarned = true;
      output("error", msg, opts);
    },
    clearScreen(type) {
      if (thresh >= LogLevels[type]) {
        clear();
      }
    },
    hasErrorLogged(error) {
      return loggedErrors.has(error);
    },
  };

  return logger;
}

export function printServerUrls(
  urls: ResolvedServerUrls,
  optionsHost: string | boolean | undefined,
  info: Logger["info"]
): void {
  const colorUrl = (url: string) =>
    colors.cyan(url.replace(/:(\d+)\//, (_, port) => `:${colors.bold(port)}/`));
  for (const url of urls.local) {
    info(`  ${colors.green("➜")}  ${colors.bold("Local")}:   ${colorUrl(url)}`);
  }
  for (const url of urls.network) {
    info(`  ${colors.green("➜")}  ${colors.bold("Network")}: ${colorUrl(url)}`);
  }
  if (urls.network.length === 0 && optionsHost === undefined) {
    info(
      colors.dim(`  ${colors.green("➜")}  ${colors.bold("Network")}: use `) +
        colors.bold("--host") +
        colors.dim(" to expose")
    );
  }
}
