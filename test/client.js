'use strict';
/**
 * test/client.js —— 零依赖 MCP 客户端（Test-A：自带客户端 ↔ 自带 server，先证明总线通）
 *
 * 流程：initialize → notifications/initialized → tools/list → tools/call dispatch_task
 * 用法：
 *   RELAY_DRY_RUN=1 node test/client.js        # 先验总线（不需 CodeBuddy/WorkBuddy）
 *   node test/client.js                         # 验 worker 腿（需已安装 codebuddy CLI）
 */
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server', 'mcp-adapter.js');
const taskId = process.argv[2] || 'example-001';

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });

let nextId = 1;
const pending = new Map();

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}
function request(method, params) {
  const id = nextId++;
  const p = new Promise((res) => pending.set(id, res));
  send({ jsonrpc: '2.0', id, method, params });
  return p;
}

// 看门狗：25s 内没跑完就退出，避免任何环节挂死
const watchdog = setTimeout(() => {
  console.error('\n⛔ 超时：25s 未收到预期响应（检查 server 是否被正确拉起）。');
  child.kill();
  process.exit(2);
}, 25000);

let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id != null && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else {
      console.log('← 通知/其它:', line);
    }
  }
});

(async () => {
  console.log('\n== Test-A: 自带 MCP 客户端 ↔ 自带 server ==\n');

  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'relay-smoke-client', version: '0.1.0' },
  });
  console.log('initialize →', JSON.stringify(init.result && init.result.serverInfo));

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await request('tools/list', {});
  console.log('tools/list →', (list.result.tools || []).map((t) => t.name).join(', '));

  const call = await request('tools/call', {
    name: 'dispatch_task',
    arguments: { task_id: taskId },
  });
  console.log('\n== dispatch_task(' + taskId + ') 返回 ==\n');
  const c = (call.result && call.result.content) || [];
  c.forEach((seg) => console.log(seg.text || ''));

  if (call.result && call.result.isError) {
    console.log('\n⚠ 工具返回 isError=true —— 读上面 note 判断是 step 几的信号。');
  } else {
    console.log('\n✅ 总线跑通：契约读→路由→result.md→run-log 全链路 OK。');
  }

  clearTimeout(watchdog);
  child.stdin.end();
  child.kill();
  process.exit(0);
})().catch((e) => {
  clearTimeout(watchdog);
  console.error('Test-A 失败:', e);
  child.kill();
  process.exit(1);
});
