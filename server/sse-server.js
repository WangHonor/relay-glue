'use strict';
/**
 * sse-server.js —— 零依赖 MCP SSE 传输（给只认 sse/http 的 WorkBuddy 版本用的退路）
 *
 * 协议（MCP SSE transport，只用 Node 内置 http，无第三方依赖）：
 *   1) 客户端  GET  http://127.0.0.1:<port>/sse           → 建立 SSE 流，服务端先推一条
 *        event: endpoint
 *        data: /messages/?session_id=<uuid>
 *   2) 客户端随后把所有 JSON-RPC 请求 POST 到该 endpoint：
 *        POST http://127.0.0.1:<port>/messages/?session_id=<uuid>
 *      —— POST 仅返回 202 作确认，真正的 JSON-RPC 响应以
 *        event: message / data: <json> 的形式走回第 1 步建立的 SSE 流。
 *
 * 端口用 env RELAY_SSE_PORT（默认 18766）。先用
 *   Get-NetTCPConnection -LocalPort 18766 -State Listen
 * 确认空闲。运行：node server/sse-server.js
 */
const http = require('http');
const crypto = require('crypto');
const { handleMessage } = require('./core');

const PORT = parseInt(process.env.RELAY_SSE_PORT || '18766', 10);
const HOST = '127.0.0.1';
const BOOT_AT = new Date().toLocaleString('zh-CN', { hour12: false });
// 代码戳：server 目录里所有 .js 的最新修改时间（秒）。用于识别"端口上跑的是不是当前这份代码"
const BUILD_STAMP = (() => {
  try {
    const fs2 = require('fs');
    const path2 = require('path');
    let mx = 0;
    for (const f of fs2.readdirSync(__dirname)) if (/\.js$/i.test(f)) { const m = fs2.statSync(path2.join(__dirname, f)).mtimeMs; if (m > mx) mx = m; }
    return Math.floor(mx / 1000);
  } catch (e) { return 0; }
})();
const sessions = new Map(); // session_id -> SSE response stream

function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);

  // ⓪ 探针：告诉外部"这个端口跑的是哪份代码"（用于识别旧实例/错目录）
  if (req.method === 'GET' && u.pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ file: __filename, dir: __dirname, tools: require('./core').TOOLS.length, boot_at: BOOT_AT, port: PORT, stamp: BUILD_STAMP }));
  }

  // ① 建立 SSE 流
  if (req.method === 'GET' && u.pathname === '/sse') {
    const id = crypto.randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    sessions.set(id, res);
    sseEvent(res, 'endpoint', `/messages/?session_id=${id}`);
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ka);
      sessions.delete(id);
    });
    return;
  }

  // ② 接收 JSON-RPC 请求
  if (req.method === 'POST' && u.pathname === '/messages/') {
    const id = u.searchParams.get('session_id');
    const stream = sessions.get(id);
    if (!stream) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unknown session' }));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end('{}');
      }
      // POST 只作确认；真正响应走 SSE 流
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{}');
      await handleMessage(msg, (o) => sseEvent(stream, 'message', JSON.stringify(o)));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`[relay-glue-sse] listening http://${HOST}:${PORT}/sse\n`);
});

function bye() {
  try {
    server.close();
  } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
