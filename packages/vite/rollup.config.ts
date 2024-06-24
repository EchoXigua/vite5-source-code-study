import type { Plugin, RollupOptions } from "rollup";
import { defineConfig } from "rollup";
import path from "node:path";
import { fileURLToPath } from "node:url";
import typescript from "@rollup/plugin-typescript";
import { readFileSync } from "node:fs";
import MagicString from "magic-string";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";

//配置路径
import nodeResolve from "@rollup/plugin-node-resolve";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url)).toString()
);

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

const sharedNodeOptions = defineConfig({
  //优化打包过程中的tree shaking
  treeshake: {
    //表明只有在当前项目内部的模块中没有副作用。外部依赖可能会有副作用。
    /**
     * 类型： boolean| "no-external"| string[]| (id: string, external: boolean) => boolean
     */
    moduleSideEffects: "no-external",
    //假设对象属性读取没有副作用。这有助于进一步优化，删除未使用的代码。
    propertyReadSideEffects: false,
    //Rollup 默认情况下会停用 try 语句内的 tree-shaking。
    //设置为 false 这意味着即使代码包含 try-catch 语句，也会尝试进行优化。
    tryCatchDeoptimization: false,
  },
  output: {
    //指定输出目录为 ./dist。
    dir: "./dist",
    //定义入口文件的命名格式为 node/[name].js。
    entryFileNames: `node/[name].js`,
    //定义分块文件的命名格式为
    chunkFileNames: "node/chunks/dep-[hash].js",
    /**
     * 类型："auto" | "default"| "named"| "none"
     * 使用什么导出模式。默认为 auto，它根据 input 模块导出的内容猜测你的意图
     *
     * 详情：https://rollup.nodejs.cn/configuration-options/#outputexports
     */
    exports: "named",
    //输出格式为 ESM
    format: "esm",
    //关闭外部模块的实时绑定。这可以减少一些开销
    /**
     * 默认情况下，如果设置为 true，模块系统会在运行时确保外部模块的导出值是实时更新的。
     * 这意味着如果外部模块的导出值在运行时发生变化，导入这些值的模块会自动得到更新。
     * 性能影响
        开销：实时绑定会引入额外的开销，因为模块系统需要保持对外部模块的引用，并在每次访问时检查导出值是否已更改。
        优化：通过将 externalLiveBindings 设置为 false，你可以避免这些额外的开销，因为打包器不需要在运行时维护这些实时绑定。
        这可以简化生成的代码，并减少运行时的性能开销，从而提高性能。
     */
    externalLiveBindings: false,
    //禁用对导出对象的冻结（Object.freeze），以提高性能。
    /**
     * freeze 选项控制是否对模块的导出对象进行冻结（即使用 Object.freeze）
     * 性能影响
        冻结对象：冻结对象会阻止对对象的扩展和修改，这在某些情况下有助于捕获意外的错误。
        然而，冻结对象也会增加运行时的开销，因为需要调用 Object.freeze 并且每次访问对象时都需要遵循冻结规则。
        优化：通过将 freeze 设置为 false，你可以避免这些额外的开销，因为导出对象不会被冻结。
        这可以减少运行时检查的次数，并允许 JavaScript 引擎进行更多的优化，从而提高性能。
     */
    freeze: false,
  },
  onwarn(warning, warn) {
    if (warning.message.includes("Circular dependency")) {
      //目的是忽略循环依赖的警告，因为它们在某些情况下是无害的。
      return;
    }
    warn(warning);
  },
});

function createNodePlugins(
  isProduction: boolean,
  sourceMap: boolean,
  declarationDir: string | false
): (Plugin | false)[] {
  return [
    // 用于解析 Node.js 模块。preferBuiltins: true 选项告诉插件优先使用内置模块而不是尝试解析外部依赖。
    nodeResolve({ preferBuiltins: true }),
    typescript({
      tsconfig: path.resolve(__dirname, "src/node/tsconfig.json"),
      sourceMap,
      //是否生成声明文件以及声明文件输出目录。
      declaration: declarationDir !== false,
      declarationDir: declarationDir !== false ? declarationDir : undefined,
    }),

    // Some deps have try...catch require of optional deps, but rollup will
    // generate code that force require them upfront for side effects.
    // Shim them with eval() so rollup can skip these calls.
    /**
     * 一些依赖可能会在 try...catch 语句中动态地尝试引入一些可选的依赖项，但是 Rollup 会在打包时强制地提前引入这些依赖项以确保它们被正确执行。
     * 为了绕过这种情况，注释建议使用 eval() 来替换这些引入语句，以便 Rollup 在打包时可以跳过这些调用。
     *
     * 这种做法的原理是，将这些可能在 try...catch 语句中的动态引入改为使用 eval()，使得 Rollup 在静态分析代码时无法确定需要引入哪些依赖项，
     * 从而避免了强制提前引入这些依赖项的情况。
     * 但是需要注意的是，使用 eval() 会带来一些安全性和性能方面的风险，因为它会执行任意的 JavaScript 代码，
     * 可能会引入安全漏洞或者降低代码的性能。
     */
    isProduction &&
      shimDepsPlugin({
        // chokidar -> fsevents
        "fsevents-handler.js": {
          src: `require('fsevents')`,
          replacement: `__require('fsevents')`,
        },
        // postcss-import -> sugarss
        "process-content.js": {
          src: 'require("sugarss")',
          replacement: `__require('sugarss')`,
        },
        "lilconfig/dist/index.js": {
          pattern: /: require,/g,
          replacement: `: __require,`,
        },
        // postcss-load-config calls require after register ts-node
        "postcss-load-config/src/index.js": {
          pattern: /require(?=\((configFile|'ts-node')\))/g,
          replacement: `__require`,
        },
        // postcss-import uses the `resolve` dep if the `resolve` option is not passed.
        // However, we always pass the `resolve` option. Remove this import to avoid
        // bundling the `resolve` dep.
        "postcss-import/index.js": {
          src: 'const resolveId = require("./lib/resolve-id")',
          replacement: "const resolveId = (id) => id",
        },
        "postcss-import/lib/parse-styles.js": {
          src: 'const resolveId = require("./resolve-id")',
          replacement: "const resolveId = (id) => id",
        },
      }),

    commonjs({
      //指定了要处理的文件扩展名为 .js。这告诉 CommonJS 插件只处理 JavaScript 文件，而忽略其他类型的文件。
      extensions: [".js"],
      /**
       * 一些与 WebSocket 模块 ws 有关的可选的对等依赖项。它们是一些原生依赖项，主要用于提高性能。
       * 但是，由于对性能的要求并不那么严格，所以在这个情况下，可以选择忽略这些依赖项。
       *
       * 通常情况下，WebSocket 库 ws 依赖于一些原生模块，比如 bufferutil 和 utf-8-validate，用于提高数据处理性能和 WebSocket 连接的效率。
       * 然而，并不是所有的应用都对这些性能优化有着严格的要求，有时候可以牺牲一些性能以换取开发速度或者简化依赖管理。
       *
       * 在这段代码中，作者选择忽略这些可选的对等依赖项，即在使用 CommonJS 插件时通过 ignore 选项来排除 bufferutil 和 utf-8-validate，
       * 从而避免它们被打包进最终的输出中。这样做可以减小最终的输出文件的大小
       */
      ignore: ["bufferutil", "utf-8-validate"],
    }),
    json(),
    isProduction &&
      // licensePlugin(
      //   path.resolve(__dirname, "LICENSE.md"),
      //   "Vite core license",
      //   "Vite"
      // ),
      cjsPatchPlugin(),
  ];
}

function createNodeConfig(isProduction: boolean) {
  return defineConfig({
    ...sharedNodeOptions,
    input: {
      //主入口文件
      index: path.resolve(__dirname, "src/node/index.ts"),
      //CLI 入口文件
      cli: path.resolve(__dirname, "src/node/cli.ts"),
      //常量入口文件
      constants: path.resolve(__dirname, "src/node/constants.ts"),
    },
    output: {
      ...sharedNodeOptions.output,
      sourcemap: !isProduction,
    },
    //外部依赖,在打包时候排除依赖，减小代码体积
    external: [
      //排除所有以 vite/ 开头的依赖。
      /^vite\//,
      //排除fsevents、lightningcss、rollup/parseAst这些具体的依赖
      "fsevents",
      "lightningcss",
      "rollup/parseAst",
      //排除所有 package.json 中的 dependencies。
      ...Object.keys(pkg.dependencies),
      //如果是非生产环境，还排除所有 devDependencies。
      ...(isProduction ? [] : Object.keys(pkg.devDependencies)),
    ],
    plugins: createNodePlugins(
      isProduction,
      !isProduction,
      // 在生产环境中，我们使用rollup.dts.config.ts生成DTS
      // 在开发中，我们需要依赖rollup ts插件
      isProduction ? false : "./dist/node"
    ),
  });
}

function createRuntimeConfig(isProduction: boolean) {
  return defineConfig({
    ...sharedNodeOptions,
    input: {
      runtime: path.resolve(__dirname, "src/runtime/index.ts"),
    },
    output: {
      ...sharedNodeOptions.output,
      sourcemap: !isProduction,
    },
    external: [
      "fsevents",
      "lightningcss",
      "rollup/parseAst",
      ...Object.keys(pkg.dependencies),
    ],
    plugins: createNodePlugins(
      isProduction,
      !isProduction,
      // 在生产环境中，我们使用rollup.dts.config.ts生成DTS
      // 在开发中，我们需要依赖rollup ts插件
      isProduction ? false : "./dist/node"
    ),
  });
}

function createCjsConfig(isProduction: boolean) {
  return defineConfig({
    ...sharedNodeOptions,
    input: {
      publicUtils: path.resolve(__dirname, "src/node/publicUtils.ts"),
    },
    output: {
      dir: "./dist",
      entryFileNames: `node-cjs/[name].cjs`,
      chunkFileNames: "node-cjs/chunks/dep-[hash].js",
      exports: "named",
      format: "cjs",
      externalLiveBindings: false,
      freeze: false,
      sourcemap: false,
    },
    external: [
      "fsevents",
      ...Object.keys(pkg.dependencies),
      ...(isProduction ? [] : Object.keys(pkg.devDependencies)),
    ],
    plugins: [...createNodePlugins(false, false, false), bundleSizeLimit(175)],
  });
}

export default (commandLineArgs: any): RollupOptions[] => {
  console.log("命令行", commandLineArgs);
  const isDev = commandLineArgs.watch;
  const isProduction = !isDev;

  return defineConfig([
    envConfig,
    clientConfig,
    createNodeConfig(isProduction),
    // createRuntimeConfig(isProduction),
    // createCjsConfig(isProduction),
  ]);
};

// #region Plugins

interface ShimOptions {
  src?: string;
  replacement: string;
  pattern?: RegExp;
}

//自定义 Rollup 插件，用于在代码转换过程中替换特定模块的引入语句或者特定模式的内容
function shimDepsPlugin(deps: Record<string, ShimOptions>): Plugin {
  //定义了一个名为 transformed 的对象，用于跟踪哪些文件已经被转换
  const transformed: Record<string, boolean> = {};

  //返回一个包含 transform 和 buildEnd 方法的对象，这是 Rollup 插件必须提供的两个方法之一。
  return {
    name: "shim-deps",
    transform(code, id) {
      console.log("code", code);
      console.log("id", id);

      for (const file in deps) {
        //遍历传入的 deps 对象，该对象包含了需要进行转换的文件及其配置

        //对于每个文件，检查当前模块的文件路径是否匹配 deps 中的某个文件。
        if (id.replace(/\\/g, "/").endsWith(file)) {
          //根据配置中的 src 或 pattern 执行相应的转换操作
          const { src, replacement, pattern } = deps[file];

          const magicString = new MagicString(code);
          if (src) {
            const pos = code.indexOf(src);
            if (pos < 0) {
              this.error(
                `Could not find expected src "${src}" in file "${file}"`
              );
              console.log(123);

              transformed[file] = true;
              //用 MagicString 类的 overwrite 方法将其替换为指定的 replacement。
              magicString.overwrite(pos, pos + src.length, replacement);
              console.log(`shimmed: ${file}`);
            }
          }

          if (pattern) {
            let match;
            while ((match = pattern.exec(code))) {
              transformed[file] = true;
              const start = match.index;
              const end = start + match[0].length;
              magicString.overwrite(start, end, replacement);
            }
            if (!transformed[file]) {
              this.error(
                `Could not find expected pattern "${pattern}" in file "${file}"`
              );
            }
            console.log(`shimmed: ${file}`);
          }

          //返回一个对象，其中包含转换后的代码和生成的 source map。
          return {
            code: magicString.toString(),
            map: magicString.generateMap({ hires: "boundary" }),
          };
        }
      }
    },
    //检查是否有文件未被转换，如果有则抛出错误，提示这些文件未被正确地处理。
    buildEnd(err) {
      if (!err) {
        for (const file in deps) {
          if (!transformed[file]) {
            this.error(
              `Did not find "${file}" which is supposed to be shimmed, was the file renamed?`
            );
          }
        }
      }
    },
  };
}

/**
 * 这个插件的目的是为特定的代码块注入 CommonJS 环境变量和 require 函数，
 * 以便在 ESM 模块中使用 CommonJS 语法
 */
function cjsPatchPlugin(): Plugin {
  const cjsPatch = `
import { fileURLToPath as __cjs_fileURLToPath } from 'node:url';
import { dirname as __cjs_dirname } from 'node:path';
import { createRequire as __cjs_createRequire } from 'node:module';

const __filename = __cjs_fileURLToPath(import.meta.url);
const __dirname = __cjs_dirname(__filename);
const require = __cjs_createRequire(import.meta.url);
const __require = require;
`.trimStart();

  return {
    name: "cjs-chunk-patch",
    //renderChunk 方法在打包过程中被调用，
    renderChunk(code, chunk) {
      //检查当前代码块的文件名是否包含 chunks/dep-，如果不包含则直接返回，不进行修改。
      if (!chunk.fileName.includes("chunks/dep-")) return;
      //插件检查当前代码块是否是 utils，并且模块 ID 中是否包含 "/ssr/runtime/utils.ts"，如果是，则跳过这个代码块，因为它需要保持轻量级。
      if (
        chunk.name === "utils" &&
        chunk.moduleIds.some((id) => id.endsWith("/ssr/runtime/utils.ts"))
      )
        return;

      //匹配代码中的所有 import 语句，并确定插入位置。
      const match = code.match(/^(?:import[\s\S]*?;\s*)+/);
      const index = match ? match.index! + match[0].length : 0;
      const s = new MagicString(code);
      //在所有 import 语句之后插入 cjsPatch 内容。
      s.appendRight(index, cjsPatch);
      console.log("patched cjs context: " + chunk.fileName);

      return {
        code: s.toString(),
        map: s.generateMap({ hires: "boundary" }),
      };
    },
  };
}

/**
 * 用于在打包过程中限制生成的包的大小。如果生成的包超过指定的大小限制，该插件将抛出错误。
 */
function bundleSizeLimit(limit: number): Plugin {
  let size = 0;

  return {
    name: "bundle-limit",
    //在所有的代码块生成后调用
    generateBundle(_, bundle) {
      size = Buffer.byteLength(
        Object.values(bundle)
          .map((i) => ("code" in i ? i.code : ""))
          .join(""),
        "utf-8"
        //Buffer.byteLength(..., 'utf-8') 计算这个字符串的字节长度（以 UTF-8 编码）
      );
    },
    //在所有打包操作完成后调用
    closeBundle() {
      const kb = size / 1000;
      if (kb > limit) {
        this.error(
          `Bundle size exceeded ${limit} kB, current size is ${kb.toFixed(
            2
          )}kb.`
        );
      }
    },
  };
}

// #endregion
