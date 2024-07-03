import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { type DotenvPopulateInput, expand } from "dotenv-expand";

import { arraify, normalizePath, tryStatSync } from "./utils";
import type { UserConfig } from "./config";

export function getEnvFilesForMode(mode: string, envDir: string): string[] {
  return [
    /** default file */ `.env`,
    /** local file */ `.env.local`,
    /** mode file */ `.env.${mode}`,
    /** mode local file */ `.env.${mode}.local`,
  ].map((file) => normalizePath(path.join(envDir, file)));
}

/**
 * 用于加载指定模式下的环境变量文件，并将符合指定前缀的变量暴露给客户端
 *
 * @param mode 环境模式，如 development、production 等。
 * @param envDir 环境变量文件所在的目录
 * @param prefixes 变量前缀，默认是 'VITE_'。可以是单个前缀字符串或前缀数组
 * @returns
 */
export function loadEnv(
  mode: string,
  envDir: string,
  prefixes: string | string[] = "VITE_"
): Record<string, string> {
  //检查 mode 是否为 'local'，因为 'local' 模式与 .local 后缀冲突。
  if (mode === "local") {
    throw new Error(
      `"local" cannot be used as a mode name because it conflicts with ` +
        `the .local postfix for .env files.`
    );
  }

  //将前缀转换为数组，确保后续处理一致性
  prefixes = arraify(prefixes);
  //创建一个空的 env 对象，用于存储最终环境变量的键值对
  const env: Record<string, string> = {};

  //获取与当前模式匹配的所有环境变量文件路径
  const envFiles = getEnvFilesForMode(mode, envDir);

  //读取并解析这些文件，将结果合并成一个对象
  const parsed = Object.fromEntries(
    //flatMap 方法对数组中的每个文件路径进行操作，并将结果扁平化
    envFiles.flatMap((filePath) => {
      //tryStatSync(filePath) 尝试获取文件的状态，并检查改路径是否是一个文件
      //不是文件，返回一个空数组 代表这个路径无效
      if (!tryStatSync(filePath)?.isFile()) return [];

      /**
       * fs.readFileSync(filePath) 读取文件内容，返回一个包含文件内容的字符串
       * parse(...) 解析文件内容，将其转换为一个对象，键值对表示环境变量
       * Object.entries(...) 将解析后的对象转换为一个键值对数组
       *
       * 如果 parse 返回 { VITE_APP_NAME: 'MyApp' }，那么 Object.entries 会返回 [ ['VITE_APP_NAME', 'MyApp'] ]
       */
      return Object.entries(parse(fs.readFileSync(filePath)));
    })
  );

  /**
   * Object.fromEntries(...) 将键值对数组重新转换为对象
   * 扁平化后的所有键值对数组会被合并成一个对象 parsed
   * 例如 { VITE_APP_NAME: 'MyApp', VITE_API_URL: 'https://api.example.com' }
   *
   * 这样相同的key，也会被后面的覆盖掉
   */

  /**
   * entries：
   *   Object.entries({one:'a',two:'b',three:'c'})
   *  // [["one", "a"],["two", "b"],["three", "c"]]

   * 
   * fromEntries：
   *   Object.fromEntries([["one", "a"],["two", "b"],["three", "c"]]);  
      //{one: "a", two: "b", three: "c"}
   */

  //如果 parsed 中存在 NODE_ENV，并且 process.env.VITE_USER_NODE_ENV 未定义，则将其设置为 parsed.NODE_ENV。
  //类似地，处理 BROWSER 和 BROWSER_ARGS 变量

  // test NODE_ENV override before expand as otherwise process.env.NODE_ENV would override this
  if (parsed.NODE_ENV && process.env.VITE_USER_NODE_ENV === undefined) {
    process.env.VITE_USER_NODE_ENV = parsed.NODE_ENV;
  }
  // support BROWSER and BROWSER_ARGS env variables
  if (parsed.BROWSER && process.env.BROWSER === undefined) {
    process.env.BROWSER = parsed.BROWSER;
  }
  if (parsed.BROWSER_ARGS && process.env.BROWSER_ARGS === undefined) {
    process.env.BROWSER_ARGS = parsed.BROWSER_ARGS;
  }

  //环境变量扩展
  //创建 process.env 的副本，避免 dotenv-expand 修改全局 process.env
  const processEnv = { ...process.env } as DotenvPopulateInput;
  //使用 dotenv-expand 扩展 parsed 中的变量
  expand({ parsed, processEnv });

  //过滤并暴露前缀变量
  // 只有以prefix开头的键才会暴露给客户端
  for (const [key, value] of Object.entries(parsed)) {
    //遍历 parsed 中的所有变量，将以指定前缀开头的变量添加到 env 对象中
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }

  //检查是否有以VITE_*开头的实际环境变量，这些变量通常是内联提供的，应该优先考虑
  //遍历 process.env 中的所有变量，将以指定前缀开头的变量优先添加到 env 对象中
  for (const key in process.env) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = process.env[key] as string;
    }
  }

  //返回环境变量的结果
  return env;
}

//处理环境变量前缀，默认 VITE_ 开头
export function resolveEnvPrefix({
  envPrefix = "VITE_",
}: UserConfig): string[] {
  envPrefix = arraify(envPrefix);
  if (envPrefix.includes("")) {
    throw new Error(
      `envPrefix option contains value '', which could lead unexpected exposure of sensitive information.`
    );
  }
  return envPrefix;
}
