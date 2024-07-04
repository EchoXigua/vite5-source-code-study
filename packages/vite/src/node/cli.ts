import path from "node:path";
import fs from "node:fs";
import { cac } from "cac";
import colors from "picocolors";
import { VERSION } from "./constants";
// import type { ServerOptions } from "./server";
import type { LogLevel } from "./logger";
import { createLogger } from "./logger";
// import type { CLIShortcut } from "./shortcuts";

const cli = cac("vite");

//全局配置
interface GlobalCLIOptions {
  "--"?: string[];
  c?: boolean | string;
  config?: string;
  base?: string;
  l?: LogLevel;
  logLevel?: LogLevel;
  clearScreen?: boolean;
  d?: boolean | string;
  debug?: boolean | string;
  f?: string;
  filter?: string;
  m?: string;
  mode?: string;
  force?: boolean;
}

let profileSession = global.__vite_profile_session;
let profileCount = 0;

export const stopProfiler = (
  log: (message: string) => void
): void | Promise<void> => {
  if (!profileSession) return;
  return new Promise((res, rej) => {
    profileSession!.post("Profiler.stop", (err: any, { profile }: any) => {
      // Write profile to disk, upload, etc.
      if (!err) {
        const outPath = path.resolve(
          `./vite-profile-${profileCount++}.cpuprofile`
        );
        fs.writeFileSync(outPath, JSON.stringify(profile));
        log(
          colors.yellow(
            `CPU profile written to ${colors.white(colors.dim(outPath))}`
          )
        );
        profileSession = undefined;
        res();
      } else {
        rej(err);
      }
    });
  });
};

/**
 * 用于过滤重复的选项，确保传入的选项对象 options 是唯一的。
 * @param options
 */
const filterDuplicateOptions = <T extends object>(options: T) => {
  for (const [key, value] of Object.entries(options)) {
    if (Array.isArray(value)) {
      options[key as keyof T] = value[value.length - 1];
    }
  }
};

const convertHost = (v: any) => {
  console.log("convertHost", v);

  if (typeof v === "number") {
    return String(v);
  }
  return v;
};

const convertBase = (v: any) => {
  console.log("convertBase", v);

  if (v === 0) {
    return "";
  }
  return v;
};

/**
 * removing global flags before passing as command specific sub-configs
 */
function cleanOptions<Options extends GlobalCLIOptions>(
  options: Options
): Omit<Options, keyof GlobalCLIOptions> {
  const ret = { ...options };
  delete ret["--"];
  delete ret.c;
  delete ret.config;
  delete ret.base;
  delete ret.l;
  delete ret.logLevel;
  delete ret.clearScreen;
  delete ret.d;
  delete ret.debug;
  delete ret.f;
  delete ret.filter;
  delete ret.m;
  delete ret.mode;

  // convert the sourcemap option to a boolean if necessary
  if ("sourcemap" in ret) {
    const sourcemap = ret.sourcemap as `${boolean}` | "inline" | "hidden";
    ret.sourcemap =
      sourcemap === "true"
        ? true
        : sourcemap === "false"
        ? false
        : ret.sourcemap;
  }

  return ret;
}

/**
 * option(name, description, config?)
 *  name：选项的名称。
    description：选项的描述信息。
    config：可选，选项的配置选项。

    []:通常用来表示参数是可选的。例如，[root] 表示 [root] 是一个可选参数，它可以被省略或者提供具体的值。
    <>:表示参数是必选的，用户在执行命令时必须提供该参数的值。
 */
cli
  .option("-c, --config <file>", `[string] 指定要使用的配置文件`)
  .option(
    "--base <path>",
    `[string] 公共基础路径，通常用于指定静态资源的根路径,默认值/ (default: /)`,
    {
      type: [convertBase],
    }
  )
  .option("-l, --logLevel <level>", `[string] info | warn | error | silent`)
  .option("--clearScreen", `[boolean] 允许或禁止在日志输出时清除屏幕`)
  .option("-d, --debug [feat]", `[string | boolean] 显示调试日志`)
  .option("-f, --filter [filter]", `[string] 过滤调试日志`)
  .option("-m, --mode <mode>", `[string] 设置环境模式`);

//dev
cli
  .command("[root]", "启动开发服务器")
  //使用了 .alias() 方法定义了两个别名 serve 和 dev，使得命令可以通过这些别名调用。
  .alias("serve")
  .alias("dev")
  .option("--host [host]", `[string] 指定主机名`, { type: [convertHost] })
  .option("--port <port>", `[number] 指定端口`)
  .option("--open [path]", `[boolean | string] 在启动完成后打开浏览器`)
  .option("--cors", `[boolean] 启用 cors`)
  .option("--strictPort", `[boolean] 如果指定的端口已被使用，则退出`)
  .option("--force", `[boolean] 强制优化器忽略缓存并重新绑定`)
  .action(async (root: string, options: GlobalCLIOptions) => {
    filterDuplicateOptions(options);
    const { createServer } = await import("./server");
    console.log("dir:", process.cwd());

    try {
      //创建一个 Vite 服务器实例
      const server = await createServer({
        root, //根目录
        base: options.base, //基础路径
        mode: options.mode, //模式
        configFile: options.config, //配置文件
        logLevel: options.logLevel, //日志级别
        clearScreen: options.clearScreen, //清屏选项
        optimizeDeps: { force: options.force }, //依赖优化选项
        server: cleanOptions(options),
      });

      if (!server.httpServer) {
        //确保 server.httpServer 存在，如果不存在则抛出错误
        throw new Error("HTTP server not available");
      }

      console.log("server", server);

      //启动服务器
      await server.listen();

      const info = server.config.logger.info;
      //记录并输出服务器启动时间
      const viteStartTime = global.__vite_start_time ?? false;
      const startupDurationString = viteStartTime
        ? colors.dim(
            `ready in ${colors.reset(
              colors.bold(Math.ceil(performance.now() - viteStartTime))
            )} ms`
          )
        : "";

      //检查标准输出和错误输出中是否有已存在的日志，并根据情况清除屏幕
      const hasExistingLogs =
        process.stdout.bytesWritten > 0 || process.stderr.bytesWritten > 0;

      info(
        `\n  ${colors.green(
          `${colors.bold("VITE")} v${VERSION}`
        )}  ${startupDurationString}\n`,
        {
          clear: !hasExistingLogs,
        }
      );

      //打印服务器的 URL
      server.printUrls();

      // 定义自定义快捷键
      const customShortcuts: CLIShortcut<typeof server>[] = [];
      if (profileSession) {
        // 定义一个快捷键 'p' 用于启动/停止性能分析
        customShortcuts.push({
          key: "p",
          description: "start/stop the profiler",
          async action(server) {
            if (profileSession) {
              // 停止性能分析
              await stopProfiler(server.config.logger.info);
            } else {
              // 启动性能分析
              const inspector = await import("node:inspector").then(
                (r) => r.default
              );
              await new Promise<void>((res) => {
                profileSession = new inspector.Session();
                profileSession.connect();
                profileSession.post("Profiler.enable", () => {
                  profileSession!.post("Profiler.start", () => {
                    server.config.logger.info("Profiler started");
                    res();
                  });
                });
              });
            }
          },
        });
      }

      //绑定cli 快捷命令
      server.bindCLIShortcuts({ print: true, customShortcuts });
    } catch (e) {
      //错误处理
      const logger = createLogger(options.logLevel);
      logger.error(colors.red(`error when starting dev server:\n${e.stack}`), {
        error: e,
      });
      // 停止性能分析
      stopProfiler(logger.info);
      // 终止进程，返回错误代码 1
      process.exit(1);
    }

    console.log("root", root);
    console.log("options", options);
  });

cli.help();
cli.version(VERSION);

cli.parse();
