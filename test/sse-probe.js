'use strict';
/**
 * test/sse-probe.js —— 自带 SSE 客户端，验证 sse-server 走的是合规 MCP SSE transport
 * （等价于 WorkBuddy 用 type:sse 连上时的真实握手 + 工具发现 + 调用）。
 * 用法：node test/sse-probe.js     （需 RELAY_DRY_RUN=1 时不牵扯 CodeBuddy）
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.RELAY_SSE_PORT || '18766', 10);
const HOST = '127.0.0.1';

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'sse-server.js')], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: process.env,
});
child.stderr.on('data', (d) => String(d).includes('listening') && connect());

const pending = new Map();
let endpoint = '';
let buf = '';
let connected = false;

function parseFrames() {
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    let ev = 'message';
    let data = '';
    frame
      .split('\n')
      .filter((l) => l.startsWith('event:') || l.startsWith('data:'))
      .forEach((l) => {
        if (l.startsWith('event:')) ev = l.slice(6).trim();
        else if (l.startsWith('data:')) data += l.slice(5).trim();
      });
    if (ev === 'endpoint') {
      endpoint = data;
      console.log('GET /sse 握手 → endpoint =', endpoint);
    } else if (ev === 'message') {
      try {
        const m = JSON.parse(data);
        if (m.id != null && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      } catch (e) {}
    }
  }
}

function connect() {
  if (connected) return;
  connected = true;
  http
    .get({ host: HOST, port: PORT, path: '/sse' }, (r) => {
      r.setEncoding('utf8');
      r.on('data', (c) => {
        buf += c;
        parseFrames();
      });
    })
    .on('error', () => setTimeout(connect, 400));
}

function post(obj) {
  return new Promise((res, rej) => {
    pending.set(obj.id, res);
    const data = JSON.stringify(obj);
    const req = http.request(
      { host: HOST, port: PORT, path: endpoint, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (r) => r.resume()
    );
    req.on('error', rej);
    req.write(data);
    req.end();
  });
}

let nextId = 1;
const rpc = (method, params) => post({ jsonrpc: '2.0', id: nextId++, method, params });

function waitEndpoint() {
  return new Promise((res) => {
    const t = setInterval(() => {
      if (endpoint) {
        clearInterval(t);
        res();
      }
    }, 80);
    setTimeout(() => {
      clearInterval(t);
      res();
    }, 15000);
  });
}

(async () => {
  console.log('\n== SSE 退路自检：等价 WorkBuddy 用 type:sse 连接 ==\n');
  await waitEndpoint();
  if (!endpoint) {
    console.error('⛔ 没拿到 endpoint，SSE 服务未就绪');
    child.kill();
    process.exit(1);
  }
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sse-probe', version: '0.1.0' } });
  console.log('initialize →', JSON.stringify(init.result && init.result.serverInfo));
  const list = await rpc('tools/list', {});
  console.log('tools/list →', (list.result.tools || []).map((t) => t.name).join(', '));
  const call = await rpc('tools/call', { name: 'dispatch_task', arguments: { task_id: 'example-001' } });
  console.log('\n== dispatch_task(example-001) 经 SSE 返回 ==\n');
  ((call.result && call.result.content) || []).forEach((s) => console.log(s.text || ''));
  console.log('\n✅ SSE 退路跑通：WorkBuddy 若 stdio 挂不上，改 type:sse 即用');
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('SSE 自检失败:', e);
  child.kill();
  process.exit(1);
});

setTimeout(() => {
  console.error('\n⛔ 整体超时（25s）：检查端口是否被占用');
  child.kill();
  process.exit(2);
}, 25000);
