'use strict';
/**
 * yuanbao-input-probe.js —— 连已登录元宝页（CDP 9333），精确枚举可编辑输入元素 + AI 答案正文节点。
 * 只读 DOM，不发送。用于校准 RELAY_YB_INPUT_SEL / RELAY_YB_ANSWER_SEL。
 */
const { waitReady, CDP } = require('./browser-cdp');
const PORT = parseInt(process.env.RELAY_CDP_PORT || '9333', 10);

const EXPR = `(()=>{
  const cls=e=>String(e.className||'').slice(0,90);
  const ce=[...document.querySelectorAll('[contenteditable]')].map(e=>({tag:e.tagName,cls:cls(e),ceAttr:e.getAttribute('contenteditable'),isCE:!!e.isContentEditable,role:e.getAttribute('role'),vis:e.offsetParent!==null}));
  const ta=[...document.querySelectorAll('textarea')].map(e=>({cls:cls(e),ph:(e.placeholder||'').slice(0,30),vis:e.offsetParent!==null}));
  const box=document.querySelector('.agent-chat__input-box');
  const boxInfo=box?{tag:box.tagName,ce:!!box.isContentEditable,childCE:[...box.querySelectorAll('[contenteditable]')].map(c=>({tag:c.tagName,cls:cls(c)})),html:box.outerHTML.slice(0,400)}:null;
  // AI 答案：找最后一个非空 .agent-chat__bubble--ai 内的正文容器
  const ai=[...document.querySelectorAll('.agent-chat__bubble--ai')];
  const lastAi=ai[ai.length-1]||null;
  const answerInfo=lastAi?{aiCount:ai.length,inner:[...lastAi.querySelectorAll('div,p')].map(d=>({cls:cls(d),len:(d.innerText||'').trim().length})).filter(o=>o.len>10).slice(0,5)}:null;
  return JSON.stringify({url:location.href,contenteditable:ce,textareas:ta,inputBox:boxInfo,answer:answerInfo},null,1);
})()`;

(async () => {
  const info = await waitReady(PORT, 6000);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && /yuanbao\.tencent\.com/.test(t.url)) || list.find((t) => t.type === 'page');
  if (!target) { console.log('NO_YUANBAO_PAGE'); setTimeout(() => process.exit(3), 100); return; }
  const cdp = new CDP(target.webSocketDebuggerUrl);
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
    console.log(r.result.value);
  } finally {
    cdp.close();
    setTimeout(() => process.exit(0), 300);
  }
})().catch((e) => { console.error('probe 失败:', e.message); setTimeout(() => process.exit(1), 200); });
