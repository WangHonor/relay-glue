'use strict';
/**
 * browser-cdp.js —— 零依赖 CDP 客户端（只用 Node 原生 fetch + WebSocket）
 *   给"元宝 GUI 自动化"腿做引擎层。Edge/Chrome 用 --remote-debugging-port 暴露 CDP，
 *   这里连它，用 Target.createTarget + attachToTarget(flatten) 在新页面里导航 + 取值。
 *   不装 Playwright/Puppeteer，不联网。
 */
function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

async function waitReady(port, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(`${baseUrl(port)}/json/version`);
      if (r.ok) return await r.json();
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`CDP 端口 ${port} 未就绪（Edge 是否带 --remote-debugging-port 起了？）`);
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this._opened = false;
    this._id = 0;
    this._pending = new Map(); // id -> resolve
    this._events = []; // {method, sessionId, resolve}
    this._ready = new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('CDP WebSocket 10s 未连上（多半缺 --remote-allow-origins=*）')), 10000);
      this.ws.onopen = () => { this._opened = true; clearTimeout(to); res(); };
      this.ws.onerror = () => { clearTimeout(to); rej(new Error('CDP WebSocket 连接出错')); };
      this.ws.onclose = (e) => { if (!this._opened) { clearTimeout(to); rej(new Error('CDP WebSocket 被关闭 code=' + e.code)); } };
    });
    this.ws.onmessage = (ev) => {
      let raw;
      try {
        const d = ev.data;
        raw = typeof d === 'string' ? d : d instanceof ArrayBuffer ? Buffer.from(d).toString('utf8') : d && d.text ? String(d) : Buffer.from(d).toString('utf8');
      } catch (e) { return; }
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.id != null && this._pending.has(m.id)) {
        const { res } = this._pending.get(m.id);
        this._pending.delete(m.id);
        res(m);
      } else if (m.method) {
        for (const w of this._events) {
          if (w.method === m.method && (!w.sessionId || w.sessionId === m.sessionId)) {
            this._events = this._events.filter((x) => x !== w);
            w.resolve(m.params || {});
            break;
          }
        }
      }
    };
  }
  async send(method, params = {}, sessionId) {
    await this._ready;
    const id = ++this._id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const m = await new Promise((res, rej) => {
      this._pending.set(id, { res });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        this._pending.delete(id);
        rej(e);
      }
    });
    if (m.error) throw new Error(method + ': ' + m.error.message);
    return m.result;
  }
  waitForEvent(method, sessionId, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待事件超时: ' + method)), timeout);
      this._events.push({ method, sessionId, resolve: (p) => { clearTimeout(timer); resolve(p); } });
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

/** 在新页面里导航到 url，跑 expression（returnByValue），返回结果值 */
const DBG = process.env.RELAY_DEBUG ? (...a) => process.stderr.write('[cdp] ' + a.join(' ') + '\n') : () => {};

async function evaluateInNewPage(port, url, expression, opts = {}) {
  const info = await waitReady(port);
  DBG('ready:', info.Browser, '\n');
  const cdp = new CDP(info.webSocketDebuggerUrl);
  let targetId, sessionId;
  try {
    const t = await cdp.send('Target.createTarget', { url: 'about:blank' });
    targetId = t.targetId; DBG('target created\n');
    const a = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = a.sessionId; DBG('attached\n');
    await cdp.send('Page.enable', {}, sessionId);
    const loaded = cdp.waitForEvent('Page.loadEventFired', sessionId, opts.navTimeout || 12000).catch(() => {});
    if (url && url !== 'about:blank') await cdp.send('Page.navigate', { url }, sessionId);
    await loaded;
    await new Promise((r) => setTimeout(r, opts.afterLoad || 200));
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: !!opts.awaitPromise },
      sessionId
    );
    if (res.exceptionDetails) throw new Error('页面脚本异常: ' + (res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)));
    return res.result && res.result.value;
  } finally {
    try { if (targetId) await cdp.send('Target.closeTarget', { targetId }); } catch (e) {}
    cdp.close();
  }
}

module.exports = { waitReady, CDP, evaluateInNewPage, baseUrl };
