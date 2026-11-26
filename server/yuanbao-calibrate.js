'use strict';
/**
 * yuanbao-calibrate.js —— 在“你已登录的元宝页”里打印候选选择器，供固化到 RELAY_YB_* 环境变量。
 * 前置：先 node server/yuanbao-launch.js 登录，保持 Edge 在跑（调试端口 9333）。
 * 用法： node server/yuanbao-calibrate.js
 */
const { waitReady, CDP } = require('./browser-cdp');

const PORT = parseInt(process.env.RELAY_CDP_PORT || '9333', 10);

const EXPR = `(()=>{
  const q=s=>document.querySelectorAll(s).length;
  const txt=(s)=>Array.from(document.querySelectorAll(s)).map(e=>(e.innerText||e.textContent||'').trim().slice(0,10));
  const input=[...document.querySelectorAll('textarea,[contenteditable="true"]')].map(e=>e.tagName+':'+(e.className||''));
  const btns=[...document.querySelectorAll('button,[role="button"]')].map(e=>e.getAttribute('aria-label')||e.title||(e.innerText||'').trim().slice(0,8)).filter(Boolean);
  const sendCand=btns.filter(t=>/发送|send|提交/i.test(t));
  return JSON.stringify({title:document.title,url:location.href,inputCount:q('textarea,[contenteditable="true"]'),inputs:input.slice(0,5),sendCand,buttons:btns.slice(0,20)});
})()`;

(async () => {
  const info = await waitReady(PORT, 8000);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && /yuanbao\.tencent\.com/.test(t.url)) || list.find((t) => t.type === 'page');
  if (!target) { console.error('没找到元宝页面。先跑 yuanbao-launch.js 并登录。'); process.exit(1); }
  const cdp = new CDP(target.webSocketDebuggerUrl);
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
    const v = JSON.parse(r.result.value);
    console.log('页面：', v.url);
    console.log('输入候选：', v.inputs);
    console.log('发送候选：', v.sendCand);
    console.log('全部按钮：', v.buttons);
    console.log('\n→ 用上面的线索设置环境变量后重跑 chain：\n   $env:RELAY_YB_INPUT_SEL="textarea"\n   $env:RELAY_YB_SEND_SEL="<你确认的发送键选择器>"\n   $env:RELAY_YB_ANSWER_SEL="<回答节点选择器>"\n   $env:RELAY_YUANBAO_ENABLED="1"\n   node server/chain.js --halt-demo');
  } catch (e) {
    console.error('校准失败：', e.message);
  } finally {
    cdp.close();
    process.exit(0);
  }
})();
