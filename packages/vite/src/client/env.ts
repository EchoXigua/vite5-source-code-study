//声名全局常量
declare const __MODE__: string;
//__DEFINES__ 是一个全局常量，通常由构建工具（如 Webpack 或 Rollup）在编译时注入。
declare const __DEFINES__: Record<string, any>;

/*
立即执行函数表达式（IIFE）
用于获取当前的全局上下文对象（即 globalThis、self、window 或全局对象本身），并将其赋值给 context 常量。
确保 context 常量在任何 JavaScript 运行环境中都指向全局对象，无论是在浏览器、Web Worker 还是 Node.js 中
*/
const context = (() => {
  if (typeof globalThis !== "undefined") {
    //globalThis 是一个标准的全局对象引用，在所有环境中都应存在
    return globalThis;
  } else if (typeof self !== "undefined") {
    //self 通常在 Web Worker 和浏览器环境中存在，指向全局作用域。
    return self;
  } else if (typeof window !== "undefined") {
    return window;
  } else {
    //如果以上三种全局对象都不存在，则使用一个函数构造器创建一个新函数，并立即执行以返回全局对象。
    return Function("return this")();
  }
})();

const defines = __DEFINES__;

/**
 * 将 __DEFINES__ 对象中的键值对设置到全局上下文对象 context 中
 * 这段代码很巧妙，通过解析键中的点分隔符，动态地创建或访问嵌套对象，并将值赋给最终的属性
 * 这种方法允许在构建时注入复杂的配置对象，而不需要在代码中显式地编写嵌套结构。
 */
Object.keys(defines).forEach((key) => {
  //对于每个键，使用 split('.') 方法将其拆分成一个数组 segments
  const segments = key.split(".");
  let target = context;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (i === segments.length - 1) {
      target[segment] = defines[key];
    } else {
      target = target[segment] || (target[segment] = {});
    }
  }
});
/**
 * 假设 __DEFINES__ 对象如下：
    const __DEFINES__ = {
    'config.api.url': 'https://api.example.com',
    'config.api.key': '12345',
    'config.version': '1.0.0',
    };
    运行上述代码后，context 对象将被更新为：
    {
    config: {
        api: {
            url: 'https://api.example.com',
                key: '12345'
            },
            version: '1.0.0'
        }
    }
 */
