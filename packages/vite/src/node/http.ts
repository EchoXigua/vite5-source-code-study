import fsp from "node:fs/promises";
import path from "node:path";
import type { OutgoingHttpHeaders as HttpServerHeaders } from "node:http";
import type { ServerOptions as HttpsServerOptions } from "node:https";

//解析 HTTPS 配置的异步函数
export async function resolveHttpsConfig(
  https: HttpsServerOptions | undefined
): Promise<HttpsServerOptions | undefined> {
  if (!https) return undefined;

  //并行地读取 https 对象中的 ca、cert、key 和 pfx 四个属性的文件内容，并等待所有的 Promise 完成
  const [ca, cert, key, pfx] = await Promise.all([
    readFileIfExists(https.ca),
    readFileIfExists(https.cert),
    readFileIfExists(https.key),
    readFileIfExists(https.pfx),
  ]);

  //替换ca、cert、key 和 pfx
  return { ...https, ca, cert, key, pfx };
}

//用于读取文件内容
async function readFileIfExists(value?: string | Buffer | any[]) {
  if (typeof value === "string") {
    //尝试读取对应路径的文件内容，并在读取失败时返回原始的 value
    return fsp.readFile(path.resolve(value)).catch(() => value);
  }
  //如果 value 不是字符串，则直接返回 value
  return value;
}
