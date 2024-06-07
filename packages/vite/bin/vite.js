#! /usr/bin/env node
//使用node 环境执行
console.log(123);
function start() {
  return import("../dist/node/cli.js");
}
start();
