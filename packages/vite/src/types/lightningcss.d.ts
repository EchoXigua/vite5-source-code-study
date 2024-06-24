import type {
  CSSModulesConfig,
  Drafts,
  NonStandard,
  PseudoClasses,
  Targets,
} from "lightningcss";

export type LightningCSSOptions = {
  /**
   * 指定需要支持的浏览器目标。
   * 可以根据项目需求配置浏览器的版本范围，以确保生成的 CSS 兼容指定的浏览器。
   */
  targets?: Targets;

  /**
   * 指定要包含的文件或文件夹。可以是文件的数量或路径的正则表达式。
   */
  include?: number;

  /**
   * 指定要排除的文件或文件夹。与 include 类似，用于过滤不需要处理的文件。
   */
  exclude?: number;

  /**
   * 控制是否启用草案阶段的 CSS 特性。
   * 这些特性可能在未来的 CSS 规范中被采纳，但目前还处于实验阶段。
   */
  drafts?: Drafts;

  /**
   * 控制是否支持非标准的 CSS 特性。
   * 这些特性不是正式的 CSS 规范的一部分，但可能在一些浏览器中被实现。
   */
  nonStandard?: NonStandard;

  /**
   * 指定哪些伪类需要处理或支持。可以控制对特定伪类选择器的处理行为。
   */
  pseudoClasses?: PseudoClasses;

  /**
   * 列出未使用的 CSS 符号，如类名或动画名。可以用来优化生成的 CSS 文件，移除未使用的符号。
   */
  unusedSymbols?: string[];

  /**
   * 配置 CSS 模块的行为。可以包含作用域名称生成规则、导入路径等配置。
   */
  cssModules?: CSSModulesConfig;
};

/**
 * demo
 export default defineConfig({
  css: {
    transformer: 'lightningcss',
    lightningcss: {
      targets: {
        chrome: '90',
        firefox: '88'
      },
      include: 100,
      exclude: 10,
      drafts: {
        nesting: true,
        customMedia: true
      },
      nonStandard: {
        colorAdjust: true
      },
      pseudoClasses: {
        hover: true,
        focus: true
      },
      unusedSymbols: ['unused-class', 'unused-animation'],
      cssModules: {
        scopeBehaviour: 'local',
        generateScopedName: '[name]__[local]___[hash:base64:5]'
      }
    }
  }
});
 */
