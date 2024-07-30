import colors from "picocolors";
import type { RollupError } from "rollup";
import type { Connect } from "dep-types/connect";
import strip from "strip-ansi";
import type { ErrorPayload } from "types/hmrPayload";
import { pad } from "../../utils";
import type { ViteDevServer } from "../..";

/**
 * 这个函数用于处理错误对象，并返回一个特定格式的错误信息
 * @param err
 * @returns
 */
export function prepareError(err: Error | RollupError): ErrorPayload["err"] {
  // 只复制我们需要的信息，避免序列化不必要的属性，
  // 因为某些错误可能会附加完整的对象（例如 PostCSS 错误）

  /**
   * strip-ansi 是一个用于去除字符串中 ANSI 转义码的第三方依赖
   * 虽然这些转义码对于命令行显示很有用，
   * 但在处理日志、错误信息或其他文本数据时，可能需要去除这些转义码以获得干净的纯文本
   * @example
   * const coloredText = '\u001b[31mThis is red text\u001b[39m';
   * const cleanText = strip(coloredText);
   * // 输出: "This is red text"
   */
  return {
    message: strip(err.message),
    stack: strip(cleanStack(err.stack || "")),
    id: (err as RollupError).id,
    frame: strip((err as RollupError).frame || ""),
    plugin: (err as RollupError).plugin,
    pluginCode: (err as RollupError).pluginCode?.toString(),
    loc: (err as RollupError).loc,
  };
}

export function buildErrorMessage(
  err: RollupError,
  args: string[] = [],
  includeStack = true
): string {
  if (err.plugin) args.push(`  Plugin: ${colors.magenta(err.plugin)}`);
  const loc = err.loc ? `:${err.loc.line}:${err.loc.column}` : "";
  if (err.id) args.push(`  File: ${colors.cyan(err.id)}${loc}`);
  if (err.frame) args.push(colors.yellow(pad(err.frame)));
  if (includeStack && err.stack) args.push(pad(cleanStack(err.stack)));
  return args.join("\n");
}

/**
 * 函数的目的是从堆栈跟踪信息中提取出与调用栈相关的行，从而去除其他不相关的内容
 * 这对于调试和日志记录非常有用，可以简化并聚焦于实际的调用栈信息
 */
function cleanStack(stack: string) {
  return (
    stack
      .split(/\n/g)
      // 过滤出包含调用栈信息的行（匹配以可选的空白字符开头并紧跟着 "at" 的行，这些行通常表示调用栈的条目）
      .filter((l) => /^\s*at/.test(l))
      .join("\n")
  );
}

export function logError(server: ViteDevServer, err: RollupError): void {
  const msg = buildErrorMessage(err, [
    colors.red(`Internal server error: ${err.message}`),
  ]);

  server.config.logger.error(msg, {
    clear: true,
    timestamp: true,
    error: err,
  });

  server.hot.send({
    type: "error",
    err: prepareError(err),
  });
}

export function errorMiddleware(
  server: ViteDevServer,
  allowNext = false
): Connect.ErrorHandleFunction {
  // note the 4 args must be kept for connect to treat this as error middleware
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteErrorMiddleware(err: RollupError, _req, res, next) {
    logError(server, err);

    if (allowNext) {
      next();
    } else {
      res.statusCode = 500;
      // 这里是出现错误后，给页面展示错误覆盖层
      res.end(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <title>Error</title>
            <script type="module">
              import { ErrorOverlay } from '/@vite/client'
              document.body.appendChild(new ErrorOverlay(${JSON.stringify(
                prepareError(err)
              ).replace(/</g, "\\u003c")}))
            </script>
          </head>
          <body>
          </body>
        </html>
      `);
    }
  };
}
