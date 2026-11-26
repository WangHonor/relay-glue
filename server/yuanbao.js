'use strict';
/**
 * yuanbao.js —— 元宝腿（A 档全自动）：用 browser-cdp 驱动"你已登录的 Edge 里的元宝网页"
 *
 * 诚实边界：
 *   - 元宝要扫码登录，自动化不碰你账号密码，只做"在你登录后的网页里 打字/发送/读回答"。
 *   - 元宝的输入框/发送键/回答节点 DOM 会随版本变，选择器【必须】对着你登录后的真实页面校准
 *     （见 launch() 里给的校准步骤），所以默认 RELAY_YUANBAO_ENABLED≠1 时保持占位、失败安全。
 *   - 只做只读式网页问答，绝不点任何不可逆按钮；回答仍需你人工复核（防幻觉）。
 *
 * 可用环境变量覆盖选择器：RELAY_YB_INPUT_SEL / RELAY_YB_SEND_SEL / RELAY_YB_ANSWER_SEL
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { waitReady, CDP } = require('./browser-cdp');

const YUANBAO_URL = 'https://yuanbao.tencent.com/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qs = (sel) => String(sel || '').replace(/'/g, "\\'");

function edgeBin() {
  return process.env.RELAY_EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
}

/** 起一个“专用 profile”的普通 Edge（带调试端口 + 打开元宝），你在里面扫码登录一次即可复用 */
function launch(port = 9333) {
  const profile = path.join(process.env.APPDATA || os.homedir(), 'relay-edge-profile');
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(
    edgeBin(),
    [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', YUANBAO_URL],
    { stdio: 'ignore', detached: true }
  );
  try { child.unref(); } catch (e) {}
  return { pid: child.pid, profile, note: '在弹出的 Edge 里登录元宝；登录态存于该 profile，下次复用免登。' };
}

async function findPageTarget(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.find((t) => t.type === 'page' && /yuanbao\.tencent\.com/.test(t.url)) || list.find((t) => t.type === 'page');
}

function setInputExpr(text) {
  const sel = qs(process.env.RELAY_YB_INPUT_SEL || '.ql-editor');
  return `(()=>{const el=document.querySelector('${sel}')||document.querySelector('[contenteditable="true"]');
  if(!el)return JSON.stringify({ok:false,reason:'no-input'});el.focus();
  if(el.isContentEditable){document.execCommand('insertText',false,${JSON.stringify(text)});}
  else{const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));}
  return JSON.stringify({ok:true});})()`;
}

function sendExpr() {
  const sel = qs(process.env.RELAY_YB_SEND_SEL || '');
  return `(()=>{const btn='${sel}'?document.querySelector('${sel}'):null;
  if(btn){btn.click();return JSON.stringify({ok:true,via:'button'});}
  const el=document.activeElement;const base={bubbles:true,cancelable:true,key:'Enter',code:'Enter',keyCode:13,which:13};
  ['keydown','keypress','keyup'].forEach(t=>el.dispatchEvent(new KeyboardEvent(t,base)));return JSON.stringify({ok:true,via:'enter'});})()`;
}

function answerExpr() {
  const sel = qs(process.env.RELAY_YB_ANSWER_SEL || '.agent-chat__bubble--ai .agent-chat__bubble__content');
  return `(()=>{const ns=document.querySelectorAll('${sel}');if(!ns.length)return '';const el=ns[ns.length-1];return (el.innerText||el.textContent||'').trim();})()`;
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面脚本异常: ' + (r.exceptionDetails.text || ''));
  return r.result && r.result.value;
}

/** 探当前页是否有主输入框（contenteditable 或配置的 RELAY_YB_INPUT_SEL） */
async function hasInput(cdp) {
  const sel = qs(process.env.RELAY_YB_INPUT_SEL || '.ql-editor');
  const expr = `(()=>JSON.stringify(!!(document.querySelector('${sel}')||document.querySelector('[contenteditable="true"]'))))()`;
  try { return JSON.parse(await ev(cdp, expr)) === true; } catch (e) { return false; }
}

/** 确保处在“可输入”主聊天态：探不到输入框（如卡在“追问/澄清”子态）就导航到全新对话重置再等 */
async function ensureInput(cdp) {
  if (await hasInput(cdp)) return true;
  try { await cdp.send('Page.navigate', { url: YUANBAO_URL }); } catch (e) {}
  for (let i = 0; i < 12; i++) { await sleep(1000); if (await hasInput(cdp)) return true; }
  return await hasInput(cdp);
}

/** 在已登录的元宝页里：填入问题→发送→轮询到答案稳定→回传文本 */
async function askQuestion(port, text, opts = {}) {
  const info = await waitReady(port, opts.readyTimeout || 8000);
  const target = await findPageTarget(port);
  if (!target) throw new Error('没找到元宝页面（Edge 里是否已打开并登录 yuanbao.tencent.com？）');
  const cdp = new CDP(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable').catch(() => {});
    await cdp.send('Runtime.enable');
    await ensureInput(cdp); // 若卡在“追问/澄清”等子态，自动重置到全新对话再输入
    const before = await ev(cdp, answerExpr());
    const setRes = JSON.parse(await ev(cdp, setInputExpr(text)));
    if (!setRes.ok) return { ok: false, reason: '输入框选择器需校准（RELAY_YB_INPUT_SEL）' };
    await ev(cdp, sendExpr());
    const deadline = Date.now() + (opts.wait || 60000);
    let last = '', stableMs = 0;
    while (Date.now() < deadline) {
      await sleep(2000);
      const cur = await ev(cdp, answerExpr());
      if (cur && cur !== before && cur === last) stableMs += 2000; else { stableMs = 0; last = cur; }
      if (last && stableMs >= 6000) break;
    }
    if (!last || last === before) return { ok: false, reason: '没读到新答案（发送键/答案节点选择器需校准：RELAY_YB_SEND_SEL / RELAY_YB_ANSWER_SEL）' };
    return { ok: true, answer: last };
  } finally {
    cdp.close();
  }
}

module.exports = { launch, askQuestion, YUANBAO_URL };
