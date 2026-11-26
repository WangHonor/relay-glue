'use strict';
/**
 * test/cdp-proof.js —— 证明零依赖 CDP 引擎能驱动 Edge：
 *   起 headless Edge（独立临时 profile，不碰你真实资料）→ 连调试端口 → 导航到 data: 页 → 读回标题。
 *   不联网、不登录、不碰元宝。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { evaluateInNewPage } = require('../server/browser-cdp');

const EDGE = process.env.RELAY_EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;

if (!fs.existsSync(EDGE)) {
  console.error('⛔ 找不到 Edge：', EDGE);
  console.error('   设 RELAY_EDGE_BIN 环境变量指向 msedge.exe 再跑。');
  process.exit(1);
}

const profileDir = path.join(os.tmpdir(), 'relay-edge-profile');
fs.mkdirSync(profileDir, { recursive: true });

const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  'about:blank',
], { stdio: 'ignore', detached: false });

function kill() { try { if (edge.pid) process.kill(edge.pid); } catch (e) {} }
process.on('exit', kill);

(async () => {
  const page = 'data:text/html,<title>CDP-OK</title><h1 id="t">relay-cdp-engine-works</h1>';
  const expr = 'document.title + " / " + document.getElementById("t").textContent';
  console.log('\n== CDP 引擎自证（headless Edge，离线，不碰元宝）==\n');
  const val = await evaluateInNewPage(PORT, page, expr, { navTimeout: 15000, afterLoad: 400 });
  console.log('从被自动化的页面读回 →', JSON.stringify(val));
  if (val && val.includes('CDP-OK')) {
    console.log('\n✅ 引擎跑通：Node 原生 WebSocket 成功驱动 Edge 完成 导航 + DOM 取值。元宝腿有戏。');
  } else {
    console.log('\n⚠ 读回内容异常，检查 Edge 是否被安全策略拦。');
  }
  kill();
  process.exit(0);
})().catch((e) => {
  console.error('引擎自证失败:', e.message);
  kill();
  process.exit(1);
});

setTimeout(() => { console.error('\n⛔ 整体超时 40s'); process.exit(2); }, 40000);
