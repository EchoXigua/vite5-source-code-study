import type { Plugin, RollupOptions } from "rollup";
import { defineConfig } from "rollup";
import path from "node:path";
import { fileURLToPath } from "node:url";
import typescript from "@rollup/plugin-typescript";
//配置路径
import nodeResolve from "@rollup/plugin-node-resolve";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const envConfig = defineConfig({
  input: path.resolve(__dirname, "src/client/env.ts"),
  plugins: [
    typescript({
      tsconfig: path.resolve(__dirname, "src/client/tsconfig.json"),
    }),
  ],
  output: {
    //指定了输出文件的路径和名称
    file: path.resolve(__dirname, "dist/client", "env.mjs"),
    // 启用 source map
    sourcemap: true,
    //用于转换 source map 中的路径。
    //这里使用 path.basename(relativeSourcePath) 将相对路径转换为文件名
    sourcemapPathTransform(relativeSourcePath) {
      return path.basename(relativeSourcePath);
    },
    //用于指定哪些文件不应包含在 source map 中。这里返回 true，表示所有文件都应被忽略。
    sourcemapIgnoreList() {
      return true;
    },
  },
});

const clientConfig = defineConfig({
  input: path.resolve(__dirname, "src/client/client.ts"),
  /**
   * external: 用于指定哪些模块应被视为外部依赖，从而在打包时不将它们包括在生成的 bundle 中。
   * 相反，这些外部依赖将被保留为 require 或 import 语句。
   * 作用：减小打包体积、避免重复打包、提高构建速度、模块分离
   *
   */
  external: ["./env", "@vite/env"],
  plugins: [
    typescript({
      tsconfig: path.resolve(__dirname, "src/client/tsconfig.json"),
    }),
  ],
  output: {
    file: path.resolve(__dirname, "dist/client", "client.mjs"),
    sourcemap: true,
    sourcemapPathTransform(relativeSourcePath) {
      return path.basename(relativeSourcePath);
    },
    sourcemapIgnoreList() {
      return true;
    },
  },
});

export default (commandLineArgs: any): RollupOptions[] => {
  console.log("命令行", commandLineArgs);

  return defineConfig([envConfig, clientConfig]);
};
