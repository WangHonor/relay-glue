'use strict';
/**
 * yuanbao-reset.js —— 把已登录的元宝页导航到全新对话（重置“追问/澄清”子态），等待加载后再探输入框。
 * 仅操作你已授权的 Edge（CDP 9333）。
 */
const { waitReady, CDP } = require('./browser-cdp');
const PORT = parseInt(process.env.RELAY_CDP_PORT || '9333', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(()=>{
  const cls=e=>String(e.className||'').slice(0,90);
  const ce=[...document.querySelectorAll('[contenteditable]')].map(e=>({tag:e.tagName,cls:cls(e),isCE:!!e.isContentEditable}));
  const q=document.querySelector('.ql-editor');
  const box=document.querySelector('#searchbar-editor');
  const ifr=[...document.querySelectorAll('iframe')].map(f=>({src:(f.src||'').slice(0,80),cls:cls(f)}));
  return JSON.stringify({url:location.href,ql:!!q,qlCls:q?q.className:null,ceCount:ce.length,ce:ce.slice(0,6),hasSearchbar:!!box,iframes:ifr},null,1);
})()`;

(async () => {
  const info = await waitReady(PORT, 6000);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && /yuanbao\.tencent\.com/.test(t.url)) || list.find((t) => t.type === 'page');
  if (!target) { console.log('NO_PAGE'); setTimeout(() => process.exit(3), 100); return; }
  const cdp = new CDP(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    console.log('导航到全新对话 https://yuanbao.tencent.com/ ...');
    await cdp.send('Page.navigate', { url: 'https://yuanbao.tencent.com/' });
    await sleep(6000);
    const r = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    console.log(r.result.value);
  } finally {
    cdp.close();
    setTimeout(() => process.exit(0), 300);
  }
})().catch((e) => { console.error('reset 失败:', e.message); setTimeout(() => process.exit(1), 200); });
