import type * as PostCSS from "postcss";
import type { LightningCSSOptions } from "dep-types/lightningcss";

//用于配置 Vite 中与 CSS 相关的选项，涵盖了各种 CSS 处理方式，包括 CSS 模块、预处理器和源映射等。
export interface CSSOptions {
  /**
   * 使用 lightningcss 作为实验性选项来处理 CSS 模块、资源和导入。
   * 需要将其安装为一个对等依赖项(peer dependency)。这与使用预处理器不兼容。
   *
   * @default 'postcss'
   * @experimental
   */
  transformer?: "postcss" | "lightningcss";
  /**
   * https://github.com/css-modules/postcss-modules
   *
   * 用于配置 CSS 模块。可以是 false（禁用 CSS 模块）或 CSS 模块选项对象。
   */
  modules?: CSSModulesOptions | false;

  /**
   * 预处理器的选项。
   *
   * 除了每个处理器特定的选项外，Vite 还支持 `additionalData` 选项。
   * `additionalData` 选项可用于为每个样式内容注入额外的代码。
   *
   * vite 中使用：
   * css: {
   *      preprocessorOptions: {
            scss: {
                additionalData: `$injectedColor: orange;`
            }
        },
   * }
   */
  preprocessorOptions?: Record<string, any>;

  /**
   * 如果设置此选项，预处理器将在可能的情况下运行在 worker 中。
   * `true` 表示 CPU 数减 1。
   *
   * 这是一个实验性选项。
   * @default 0
   * @experimental
   */
  preprocessorMaxWorkers?: number | true;

  /**
   * 配置 PostCSS 选项。
   * 可以是一个字符串（指向配置文件的路径）或一个对象，包含 PostCSS 处理选项和插件数组。
   */
  postcss?:
    | string
    | (PostCSS.ProcessOptions & {
        plugins?: PostCSS.AcceptedPlugin[];
      });

  /**
   * 在开发时启用 CSS 源映射。
   * @default false
   * @experimental
   */
  devSourcemap?: boolean;

  /**
   * @experimental
   */
  lightningcss?: LightningCSSOptions;
}

/**
 *  demo

export default defineConfig({
  css: {
    transformer: 'postcss',
    modules: {
      scopeBehaviour: 'local',
      generateScopedName: '[name]__[local]___[hash:base64:5]'
    },
    preprocessorOptions: {
      scss: {
        additionalData: `$injectedColor: orange;`
      }
    },
    preprocessorMaxWorkers: true,
    postcss: {
      plugins: [
        require('autoprefixer')(),
        require('cssnano')()
      ]
    },
    devSourcemap: true,
    lightningcss: {
      // 配置 lightningcss 的选项
    }
  }
});
 */

export interface CSSModulesOptions {
  getJSON?: (
    cssFileName: string,
    json: Record<string, string>,
    outputFileName: string
  ) => void;
  scopeBehaviour?: "global" | "local";
  globalModulePaths?: RegExp[];
  exportGlobals?: boolean;
  generateScopedName?:
    | string
    | ((name: string, filename: string, css: string) => string);
  hashPrefix?: string;
  /**
   * default: undefined
   */
  localsConvention?:
    | "camelCase"
    | "camelCaseOnly"
    | "dashes"
    | "dashesOnly"
    | ((
        originalClassName: string,
        generatedClassName: string,
        inputFile: string
      ) => string);
}
