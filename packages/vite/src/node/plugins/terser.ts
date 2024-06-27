import type { Terser } from "dep-types/terser";

export interface TerserOptions extends Terser.MinifyOptions {
  /**
   * 用于指定在使用terser压缩文件时要生成的工作线程的最大数量。
   *
   * @default number of CPUs minus 1
   */
  maxWorkers?: number;
}
