import { cac } from "cac";
import { VERSION } from "./constants";

// import type { ServerOptions } from "./server";
import type { LogLevel } from "./logger";

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
    } catch (e) {}
    console.log("root", root);
    console.log("options", options);
  });

cli.help();
cli.version(VERSION);

cli.parse();
