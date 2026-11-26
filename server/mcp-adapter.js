'use strict';
/**
 * mcp-adapter.js —— MCP stdio server（换行分隔 JSON-RPC）。行为与 v0.1 一致，逻辑已抽到 core.js。
 * 运行：node server/mcp-adapter.js（由 MCP Host 通过 stdio 拉起）
 * 冒烟：node test/client.js（Test-A，自带客户端）
 */
const readline = require('readline');
const { handleMessage } = require('./core');

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch (e) {
    return process.stderr.write('[relay-glue] parse error: ' + e.message + '\n');
  }
  handleMessage(msg, send).catch((e) => process.stderr.write('[relay-glue] handler error: ' + e.message + '\n'));
});
rl.on('close', () => process.exit(0));
