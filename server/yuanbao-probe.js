'use strict';
/**
 * yuanbao-probe.js —— 连你已登录的元宝页（CDP 端口 9333），dump 答案/消息容器候选选择器。
 * 只读 DOM，不发送任何内容。优雅退出规避 libuv 断言。
 */
const { waitReady, CDP } = require('./browser-cdp');
const PORT = parseInt(process.env.RELAY_CDP_PORT || '9333', 10);

const EXPR = `(()=>{
  const txt=e=>(e.innerText||e.textContent||'').trim();
  const cands=['[class*="message"]','[class*="answer"]','[class*="chat"]','[class*="markdown"]','[class*="bubble"]','[class*="response"]','[class*="content"]','[class*="prose"]'];
  const found={};
  cands.forEach(s=>{const ns=document.querySelectorAll(s);if(ns.length){found[s]={count:ns.length,last:Array.from(ns).slice(-2).map(e=>({cls:String(e.className).slice(0,60),tag:e.tagName,len:txt(e).length,head:txt(e).slice(0,24)}))};}});
  const inp=document.querySelector('.ql-editor');
  const long=[...document.querySelectorAll('div,p,pre')].map(e=>({cls:String(e.className).slice(0,50),len:txt(e).length,head:txt(e).slice(0,30)})).filter(o=>o.len>40).slice(-6);
  return JSON.stringify({url:location.href, hasInput:!!inp, inputCls:inp?inp.className:null, found, longBlocks:long},null,1);
})()`;

(async () => {
  const info = await waitReady(PORT, 6000);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && /yuanbao\.tencent\.com/.test(t.url)) || list.find((t) => t.type === 'page');
  if (!target) { console.log('NO_YUANBAO_PAGE（Edge 里是否还开着元宝？）'); setTimeout(() => process.exit(3), 100); return; }
  const cdp = new CDP(target.webSocketDebuggerUrl);
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
    console.log(r.result.value);
  } finally {
    cdp.close();
    setTimeout(() => process.exit(0), 300);
  }
})().catch((e) => { console.error('probe 失败:', e.message); setTimeout(() => process.exit(1), 200); });
