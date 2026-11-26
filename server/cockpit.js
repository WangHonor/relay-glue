'use strict';
/**
 * cockpit.js —— 本地指挥台快照：读 run-log + 链状态 + 任务产物，生成自包含 HTML（Brief 策略③「可观测」门面）
 *   零依赖、离线、纯本地。用法： node server/cockpit.js   → 生成 relay-glue/cockpit.html
 *   可传入自定义任务 goal：node server/cockpit.js "把这篇改成更口语的标题党"（顺带当一次干跑心跳）
 */
const fs = require('fs');
const path = require('path');
const { BB } = require('./adapters');
const { dispatch, TOOLS, SERVER_INFO, parseResultMd } = require('./core');
const safety = require('./safety');
const cost = require('./cost');
const roles = require('./roles');
const pipeline = require('./pipeline');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── 中文化映射（通用指标用中文；智能体一律按原始名称展示）──
const ROLE_ZH = { research: '元宝', code: 'CodeBuddy', editor: 'VSCode', single: '单Agent', workbuddy: 'WorkBuddy' };
function zhRole(r) { return ROLE_ZH[r] || r || '—'; }
function zhStep(id) { const s = String(id || ''); if (/research/i.test(s)) return '调研'; if (/outline/i.test(s)) return '大纲'; if (/draft/i.test(s)) return '成稿'; if (/layout/i.test(s)) return '排版'; return null; }
function zhStatus(s) { if (!s || s === '(无)') return '暂无'; const x = String(s); if (x === 'done') return '已完成'; if (x.indexOf('awaiting_confirmation') >= 0) return '待人工确认'; if (x.indexOf('blocked@safety') >= 0) return '安全拦截'; if (x.indexOf('halted@worker_fail') >= 0) return '已停止·执行失败'; if (x.indexOf('halted@context_loss') >= 0) return '上下文丢失'; return x; }
function zhLevel(l) { return l === 'block' ? '拦截' : l === 'confirm' ? '需确认' : l === 'auto' ? '自动放行' : (l || '—'); }
function fmtTime(iso) { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return String(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }

function readLines(f) {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; }
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function readResult(id) { try { return fs.readFileSync(path.join(BB, 'tasks', id, 'result.md'), 'utf8'); } catch (e) { return ''; } }

// ── 产物预览：轻量 Markdown 渲染（零依赖）+ 结构化卡片 ──
function mdInline(s) {
  return String(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
/** 极简 Markdown → HTML：标题/列表/表格/引用/代码块/分隔线/段落（够用即可，不追求完整规范） */
function mdRender(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false, codeBuf = [], listType = null;
  const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null; } };
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (inCode) { out.push('<pre class="mdcode">' + esc(codeBuf.join('\n')) + '</pre>'); codeBuf = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    if (!raw.trim()) { closeList(); continue; }
    const line = esc(raw);
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { closeList(); const lv = m[1].length; out.push('<h' + lv + '>' + mdInline(m[2]) + '</h' + lv + '>'); continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(raw)) { closeList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^&gt;\s?(.*)$/))) { closeList(); out.push('<blockquote>' + mdInline(m[1]) + '</blockquote>'); continue; }
    if ((m = line.match(/^\s*[-*+•]\s+(.*)$/))) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } out.push('<li>' + mdInline(m[1]) + '</li>'); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push('<li>' + mdInline(m[1]) + '</li>'); continue; }
    if ((m = line.match(/^\s*\|(.+)\|\s*$/))) {
      closeList();
      const cells = m[1].split('|').map((c) => c.trim());
      out.push('<table class="mdtab"><tr>' + cells.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr></table>');
      continue;
    }
    closeList();
    out.push('<p>' + mdInline(line) + '</p>');
  }
  if (inCode && codeBuf.length) out.push('<pre class="mdcode">' + esc(codeBuf.join('\n')) + '</pre>');
  closeList();
  return out.join('');
}
function fmtDur(ms) {
  ms = Number(ms || 0);
  if (!ms) return '—';
  if (ms < 1000) return ms + ' 毫秒';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' 秒';
  return Math.floor(ms / 60000) + ' 分 ' + Math.round((ms % 60000) / 1000) + ' 秒';
}
function taskIds() {
  const d = path.join(BB, 'tasks');
  try { return fs.readdirSync(d); } catch (e) { return []; }
}
function gather() {
  const status = readJson(path.join(BB, 'runs', 'chain-demo.status.json'));
  const log = readLines(path.join(BB, 'runs', 'run-log.jsonl'));
  const tasks = taskIds();
  const cl = cost.load();
  const pid = process.env.RELAY_PROJECT_ID || 'demo';
  const proj = (cl.projects && cl.projects[pid]) || { spent: 0, steps: [], degraded: false };
  return { status, log, tasks, pending: safety.listPending(), cost: { project: pid, spent: proj.spent, limit: cl.limit || cost.limit(), degraded: !!proj.degraded, steps: proj.steps }, counts: { tasks: tasks.length, runs: log.length, ok: log.filter((e) => e.ok).length } };
}

function render(g, opts = {}) {
  const { status, log, tasks, pending = [] } = g;
  const c = g.cost || { project: 'demo', spent: 0, limit: 0, degraded: false, steps: [] };
  const counts = { tasks: tasks.length, runs: log.length, ok: log.filter((e) => e.ok).length };
  const rate = counts.runs ? Math.round((counts.ok / counts.runs) * 100) : 0;

  const costColor = c.limit ? (c.spent > c.limit ? 'danger' : c.degraded ? 'warn' : 'ok') : 'muted';
  const chainColor = !status ? 'muted' : status.result === 'done' ? 'ok' : (/^(blocked|halted)/.test(String(status.result)) ? 'danger' : 'warn');

  const costRows = (c.steps || []).slice(-10).reverse().map((s) => `<tr class="${s.degraded ? 'warn' : ''}"><td>${esc(s.task_id)}</td><td>${esc(zhStep(s.task_id) || zhRole(s.role))}</td><td>${(s.tokens_in || 0) + (s.tokens_out || 0)}<span class="dim"> / ${s.tokens_source === 'real' ? '真实' : s.tokens_source === 'est' ? '估算' : '—'}</span></td><td>¥${(s.cost || 0).toFixed(4)}</td><td>${s.degraded ? '↩ 已降级' : '—'}</td></tr>`).join('') || '<tr><td colspan="5">暂无记录</td></tr>';

  const icon = (s) => s.held ? '⏳ 待确认' : s.blocked ? '⛔ 拦截' : s.ok ? '✅ 成功' : '❌ 失败';
  const rowcls = (s) => s.held ? 'warn' : !s.ok ? 'bad' : '';
  const tokSrc = (s) => s.tokens_source === 'real' ? '真实' : s.tokens_source === 'est' ? '估算' : s.tokens_source === 'prev' ? '上次' : '—';
  const chainRows = status
    ? status.steps.map((s) => `<tr class="${rowcls(s)}"><td><b>${esc(zhStep(s.id) || zhRole(s.role))}</b></td><td class="dim">${esc(s.id)}</td><td>${esc(zhRole(s.role))}</td><td>${icon(s)}</td><td>${s.attempts}</td><td>${s.skipped ? '♻️ 跳过' : '实跑'}</td><td>${s.handed_off_from_upstream === undefined ? '—' : (s.handed_off_from_upstream ? '✅ 完整' : '❌ 丢失')}${s.handoff ? `<div class="dim">指纹 ${esc(s.handoff.fingerprint)} · ${s.handoff.chars}/${s.handoff.upstream_total_chars} 字${s.handoff.truncated ? '（截断）' : ''}</div>` : ''}</td><td>${s.tokens_in || 0}<span class="dim"> / ${tokSrc(s)}</span></td><td>${s.step_cost != null ? '¥' + Number(s.step_cost).toFixed(4) : '—'}</td><td>${s.duration_ms} 毫秒</td></tr>`).join('')
    : '<tr><td colspan="10">尚无链记录（先跑一次 chain.js）</td></tr>';

  const pendingHtml = pending.length
    ? `<section class="card"><div class="sec-h">⏳ 待人工确认（安全闸门）</div><table><thead><tr><th>任务</th><th>级别</th><th>原因</th><th>命中词</th></tr></thead><tbody>${pending.map((p) => `<tr class="warn"><td>${esc(p.task_id)}</td><td>${esc(zhLevel(p.decision.level))}</td><td>${esc(p.decision.reason)}</td><td>${esc((p.decision.matched || []).join('、'))}</td></tr>`).join('')}</tbody></table></section>`
    : '';

  const logRows = log.slice(-12).reverse().map((e) => `<tr class="${e.ok ? '' : 'bad'}"><td class="dim">${fmtTime(e.ts)}</td><td>${esc(e.task_id)}</td><td>${esc(zhRole(e.role))}</td><td>${e.ok ? '✅ 成功' : '❌ 失败'}</td><td>${e.tokens || '—'}</td><td>${e.cost != null ? '¥' + Number(e.cost).toFixed(4) : '—'}</td><td>${e.duration_ms} 毫秒</td></tr>`).join('') || '<tr><td colspan="7">暂无记录</td></tr>';

  // ── 产物预览：结构化卡片（环节/智能体/状态/耗时/成本/摘要/正文·Markdown）──
  const latestByTask = {};
  (log || []).forEach((e) => { latestByTask[e.task_id] = e; }); // log 由旧到新，后写入的覆盖 → 取最新
  const previewItems = tasks
    .map((id) => ({ id, raw: readResult(id) }))
    .filter((x) => x.raw && x.raw.trim())
    .map((x) => ({ id: x.id, p: parseResultMd(x.raw), lg: latestByTask[x.id] || {}, ts: (latestByTask[x.id] || {}).ts || '' }))
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const okCount = previewItems.filter((it) => it.p.ok === 'true').length;
  const failCount = previewItems.filter((it) => it.p.ok === 'false').length;
  const cards = previewItems.map((it, idx) => {
    const p = it.p, lg = it.lg;
    const okFlag = p.ok === 'true' ? 'true' : p.ok === 'false' ? 'false' : 'none';
    const badge = okFlag === 'true' ? '<span class="pv-badge ok">成功</span>'
      : okFlag === 'false' ? '<span class="pv-badge bad">失败</span>' : '<span class="pv-badge none">未运行</span>';
    const agent = zhRole(p.role || lg.role);
    const meta = [];
    meta.push('智能体 <b>' + esc(agent) + '</b>');
    if (lg.duration_ms) meta.push('耗时 ' + esc(fmtDur(lg.duration_ms)));
    if (lg.cost != null) meta.push('成本 ¥' + Number(lg.cost).toFixed(4));
    if (lg.tokens) meta.push('Token ' + lg.tokens);
    if (lg.ts) meta.push(esc(fmtTime(lg.ts)));
    const body = p.output ? mdRender(p.output) : (p.summary ? '<p class="pv-plain">' + esc(p.summary) + '</p>' : '<div class="pv-empty">本次没有产出正文' + (p.note ? '，原因见下方备注' : '') + '</div>');
    const long = (p.output || '').length > 500 || (p.summary || '').length > 260;
    const noteHead = String(p.note || '').split('\n')[0].trim();
    const det = (p.note ? '<div class="pv-row"><span>完整备注</span><span>' + esc(p.note) + '</span></div>' : '')
      + '<div class="pv-row"><span>任务 ID</span><span>' + esc(it.id) + '</span></div>'
      + '<div class="pv-row"><span>产物文件</span><span>blackboard/tasks/' + esc(it.id) + '/result.md</span></div>';
    return '<div class="pcard' + (idx >= 6 ? ' more' : '') + '" data-ok="' + okFlag + '">'
      + '<div class="pcard-h"><b>' + esc(zhStep(it.id) || agent) + '</b>' + badge + '<span class="dim pv-id">' + esc(it.id) + '</span></div>'
      + '<div class="pv-meta">' + meta.join(' · ') + '</div>'
      + (okFlag === 'false' && noteHead ? '<div class="pv-note">失败原因：' + esc(noteHead) + '</div>' : '')
      + (p.summary ? '<div class="pv-sum"><b>摘要</b>' + esc(p.summary) + '</div>' : '')
      + '<div class="pv-out">' + body + '</div>'
      + (long ? '<button class="pv-more" onclick="var e=this.parentNode.querySelector(\'.pv-out\');e.classList.toggle(\'open\');this.textContent=e.classList.contains(\'open\')?\'收起\':\'展开全文\';">展开全文</button>' : '')
      + '<details class="pv-det"><summary>详情</summary>' + det + '</details>'
      + '</div>';
  }).join('');
  const pvTools = previewItems.length > 6 || failCount
    ? '<div class="pv-tools">'
      + (failCount ? '<button class="pv-btn" onclick="var g=document.getElementById(\'pv-grid\');g.classList.toggle(\'onlyfail\');this.classList.toggle(\'on\');">只看失败（' + failCount + '）</button>' : '')
      + (previewItems.length > 6 ? '<button class="pv-btn" onclick="var g=document.getElementById(\'pv-grid\');g.classList.toggle(\'compact\');this.classList.toggle(\'on\');">展开全部（' + previewItems.length + '）</button>' : '')
      + '</div>'
    : '';
  const rep = status && status.repair;
  const repairHtml = rep ? `<section class="card repair"><div class="sec-h">⚠️ 异常修复提示（贴回主控 WorkBuddy）</div>
    <div class="rmeta"><span class="tag">${esc(zhStep(rep.stepId) || rep.stepId)}</span> · 智能体 <b>${esc(rep.agent)}</b> · 根因 <b>${esc(rep.category)}</b>：${esc(rep.cause)}</div>
    <ol class="raction">${(rep.actions || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ol>
    <details open><summary>可复制的修复提示词</summary><pre class="rprompt">${esc(rep.prompt || '')}</pre></details></section>` : '';
  const updated = fmtTime(new Date().toISOString());

  // ── 侧栏视图内容：live 模式留占位符由控制台注入交互面板；静态快照给只读内容 ──
  const live = !!opts.live;
  const roleCards = roles.all();
  const staticRoles = `<section class="card"><div class="sec-h">🎭 角色 / 身份（共 ${roleCards.length} 张 · 静态快照只读）</div>
    <table><thead><tr><th>id</th><th>身份</th><th>总线角色</th><th>扮演应用</th><th>工作类型</th><th>职责</th></tr></thead><tbody>${roleCards.map((r) => `<tr><td class="dim">${esc(r.id)}</td><td><b>${esc(r['身份'] || '')}</b></td><td>${esc(r.role || '')}</td><td>${esc(r.agent || '')}</td><td>${esc(r['工作类型'] || '')}</td><td class="dim">${esc(String(r['职责'] || '').slice(0, 60))}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">暂无角色卡</td></tr>'}</tbody></table>
    <p class="dim">增删改角色请在实时控制台 http://127.0.0.1:8770 操作。</p></section>`;
  const pipeName = pipeline.currentName(); const pipeSteps = pipeline.get(pipeName); const pipeMeta = pipeline.meta(pipeName) || {};
  const staticPipeline = `<section class="card"><div class="sec-h">🔗 流水线编排（当前「${esc(pipeName)}」· 业务事项：${esc(pipeMeta.业务事项 || '—')} · 当前 v${esc(String(pipeMeta.当前版本 || 0))} 共 ${(pipeMeta.版本 || []).length} 版 · 静态快照只读）</div>
    <table><thead><tr><th>#</th><th>环节 / 身份</th><th>扮演应用</th><th>该步指令</th></tr></thead><tbody>${pipeSteps.map((s, i) => { const cc = roles.find(s.persona) || {}; return `<tr><td>${i + 1}</td><td><b>${esc(cc['身份'] || s.persona || '')}</b></td><td>${esc(cc.agent || '')}</td><td class="dim">${esc(String(s.goal || '').slice(0, 80))}</td></tr>`; }).join('') || '<tr><td colspan="4" class="dim">暂无步骤</td></tr>'}</tbody></table>
    <p class="dim">编辑流水线 / 版本回滚请在实时控制台操作。</p></section>`;
  const staticTakeover = `<section class="card"><div class="sec-h">🎛 一键接管</div><p class="dim">当前链状态：<b>${esc(status ? zhStatus(status.result) : '暂无')}</b>。断点续跑 / 全重跑 / 逐步重跑·忽略·批准·诊断 等交互操作请在实时控制台 http://127.0.0.1:8770 使用。</p></section>`;
  const rolesView = live ? '<!--VIEW_ROLES-->' : staticRoles;
  const pipelineView = live ? '<!--VIEW_PIPELINE-->' : staticPipeline;
  const takeoverView = live ? '<!--VIEW_TAKEOVER-->' : staticTakeover;
  const scriptSlot = live ? '<!--SCRIPT-->' : '';
  const pipeCurName = pipeline.currentName();
  const staticSystem = `<section class="card"><div class="sec-h">🖥 系统与连接</div>
    <div class="sysgrid">
      <div class="sysrow"><span>服务版本</span><b>${esc(SERVER_INFO.name)} v${esc(SERVER_INFO.version)}</b></div>
      <div class="sysrow"><span>当前流水线</span><b>${esc(pipeCurName)}</b>（${pipeline.get(pipeCurName).length} 步）</div>
      <div class="sysrow"><span>项目 / 账本</span><b>${esc(c.project)}</b></div>
      <div class="sysrow"><span>预算 / 已花费</span><b>¥${(c.limit || 0)} / ¥${(c.spent || 0).toFixed(3)}</b>${c.degraded ? ' · 已降级' : ''}</div>
      <div class="sysrow"><span>安全闸门</span><b>${safety.DISABLED() ? '已关闭' : '启用'}</b></div>
      <div class="sysrow"><span>MCP 工具</span><b>${TOOLS.length} 个</b>：${TOOLS.map((t) => esc(t.name)).join(' · ')}</div>
      <div class="sysrow"><span>运行时代码</span><b title="${esc(__filename)}">${esc(path.basename(__filename))} · ${esc(SERVER_INFO.name)} v${esc(SERVER_INFO.version)}</b><div class="dim">${esc(__dirname)}</div></div>
    </div>
    <p class="dim">连接健康（Edge / SSE / 指挥台端口）与预算 / 项目 / 安全开关配置，请在实时控制台 http://127.0.0.1:8770 查看与修改。</p></section>`;
  const systemView = live ? '<!--SYSTEMCARD-->' : staticSystem;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay 联合办公指挥台</title>
<style>
:root{--bg:#f0f2f5;--card:#fff;--text:#1f2329;--muted:#8a9099;--border:#eceef1;--line:#f2f3f5;--blue:#1677ff;--ok:#16a34a;--warn:#d9822b;--danger:#dc2626}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:-apple-system,'PingFang SC','Microsoft YaHei','Noto Sans SC',sans-serif;padding:0;margin:0;font-size:14px}
.wrap{max-width:1120px;margin:0 auto;padding:20px}
.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.top h1{font-size:20px;margin:0;font-weight:600}
.top h1 .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--ok);margin-right:8px;vertical-align:middle}
.top .sub{color:var(--muted);font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;position:relative;overflow:hidden}
.kpi::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--blue)}
.kpi.ok::before{background:var(--ok)}.kpi.warn::before{background:var(--warn)}.kpi.danger::before{background:var(--danger)}.kpi.muted::before{background:#c4c9d0}
.kpi .num{font-size:26px;font-weight:700;line-height:1.15}
.kpi .num.sm{font-size:18px}
.kpi .num .u{font-size:14px;font-weight:600;margin-left:2px}
.kpi .lab{color:var(--muted);font-size:12px;margin-top:5px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px}
.sec-h{font-size:15px;font-weight:600;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:500;background:#fafbfc}
tr:last-child td{border-bottom:none}
tr.bad td{color:var(--danger)}
tr.warn td{color:var(--warn)}
.dim{color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.pcard{background:#fafbfc;border:1px solid var(--border);border-radius:8px;padding:12px}
.pcard[data-ok="true"]{border-left:3px solid #b7eb8f}
.pcard[data-ok="false"]{border-left:3px solid #ffa39e;background:#fffafa}
.pcard[data-ok="none"]{border-left:3px solid var(--border)}
.pcard-h{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.pcard-h b{font-size:13px}
.pv-badge{font-size:11px;font-weight:600;padding:1px 8px;border-radius:20px;flex:none}
.pv-badge.ok{background:#eaf7ee;color:#237804;border:1px solid #b7eb8f}
.pv-badge.bad{background:#fff1f0;color:#a8071a;border:1px solid #ffa39e}
.pv-badge.none{background:#f2f3f5;color:#6b7280;border:1px solid var(--border)}
.pv-id{margin-left:auto;font-size:11px;font-family:'SFMono-Regular',Consolas,monospace;color:#6b7280;background:#f2f3f5;border:1px solid var(--border);border-radius:5px;padding:1px 7px}
.pv-meta{font-size:12px;color:#6b7280;margin-bottom:8px;display:flex;flex-wrap:wrap;gap:4px 10px}
.pv-meta b{color:#2b4a86;font-weight:600}
.pv-note{background:#fff1f0;border:1px solid #ffccc7;border-radius:6px;padding:5px 9px;font-size:12px;color:#a8071a;margin-bottom:8px;overflow-wrap:anywhere;line-height:1.6}
.pv-sum{background:#fafbfc;border-left:2px solid #dfe8ff;border-radius:0 6px 6px 0;padding:6px 10px;font-size:12.5px;color:#4b5563;margin-bottom:9px;line-height:1.65}
.pv-sum b{color:#2b4a86;font-weight:600;font-size:11px;margin-right:6px}
.pv-plain{font-size:13px;margin:0 0 8px;line-height:1.75}
.pv-empty{font-size:12.5px;color:#6b7280;background:#f2f3f5;border:1px dashed var(--border);border-radius:6px;padding:12px;text-align:center}
.pv-out{font-size:13px;line-height:1.8;color:#1f2329;max-height:200px;overflow:hidden;position:relative;overflow-wrap:anywhere}
.pv-out.open{max-height:none}
.pv-out:not(.open)::after{content:'';position:absolute;left:0;right:0;bottom:0;height:30px;background:linear-gradient(180deg,rgba(250,251,252,0),#fafbfc 85%);pointer-events:none}
.pv-out:not(.open) .mdcode{max-height:130px}
.pv-more{margin-top:10px;background:#fff;border:1px solid var(--border);border-radius:6px;padding:3px 12px;font-size:12px;color:var(--blue);cursor:pointer;display:inline-block}
.pv-more:hover{border-color:var(--blue);background:#f5f8ff}
.pv-det{margin-top:8px;font-size:12px;color:#6b7280}
.pv-det summary{cursor:pointer;color:#6b7280;font-size:12px}
.pv-row{display:flex;gap:8px;padding:3px 0;border-bottom:1px dashed var(--line)}
.pv-row span:first-child{color:#6b7280;flex:none;width:72px}
.pv-row span:last-child{word-break:break-all;color:#3a3f45}
.pv-tools{display:inline-flex;gap:6px;margin-left:auto}
.pv-btn{background:#fff;border:1px solid var(--border);border-radius:6px;padding:2px 10px;font-size:12px;color:#2b4a86;cursor:pointer}
.pv-btn.on{background:var(--blue);border-color:var(--blue);color:#fff}
.pv-grid .pcard.more{display:none}
.pv-grid.compact .pcard.more{display:block}
.pv-grid.onlyfail .pcard:not([data-ok="false"]){display:none}
.sec-sub{font-weight:400;margin-left:8px;color:#6b7280}
.pv-out h1,.pv-out h2,.pv-out h3,.pv-out h4{font-size:13.5px;margin:12px 0 6px;line-height:1.5}
.pv-out h1{font-size:15px}
.pv-out p{margin:0 0 9px}
.pv-out ul,.pv-out ol{margin:0 0 9px;padding-left:20px}
.pv-out li{margin:3px 0;line-height:1.75}
.pv-out code{background:#f2f3f5;border-radius:4px;padding:1px 5px;font-family:'SFMono-Regular',Consolas,monospace;font-size:12px}
.pv-out pre.mdcode{background:#1f2329;color:#e6e8eb;border-radius:6px;padding:10px;overflow:auto;font-size:12px;max-height:320px;line-height:1.6}
.pv-out blockquote{margin:0 0 9px;padding:6px 12px;border-left:3px solid #b7d7ff;background:#f5f8ff;color:#3a3f45;border-radius:0 6px 6px 0}
.pv-out hr{border:none;border-top:1px solid var(--line);margin:12px 0}
.pv-out table.mdtab{border-collapse:collapse;margin:0 0 9px}
.pv-out table.mdtab td{border:1px solid var(--line);padding:4px 8px;font-size:12px}
.pv-out a{color:var(--blue)}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.6;color:#3a3f45;max-height:200px;overflow:auto;font-family:'SFMono-Regular',Consolas,'Microsoft YaHei',monospace}
.card.repair{border-left:4px solid var(--danger);background:#fff7f7}
.rmeta{font-size:13px;margin-bottom:8px}
.tag{display:inline-block;padding:1px 8px;border-radius:6px;font-size:12px;background:#eef2ff;color:var(--blue);font-weight:600}
.raction{margin:0 0 10px;padding-left:20px;font-size:13px}
.raction li{margin:3px 0}
details summary{cursor:pointer;font-size:13px;color:var(--muted);margin-bottom:6px}
pre.rprompt{max-height:320px;background:#fafbfc;border:1px solid var(--border);border-radius:8px;padding:10px}
.app{display:flex;min-height:100vh;align-items:stretch}
.side{width:210px;flex:none;background:#eef1fb;border-right:1px solid var(--border);padding:16px 12px}
.brand{font-weight:700;font-size:14px;color:var(--text);padding:8px 12px 16px}
.navitem{display:block;padding:10px 14px;margin:4px 0;border-radius:8px;cursor:pointer;font-size:14px;color:#3a4358;user-select:none}
.navitem:hover{background:#e2e8f7}
.navitem.active{background:var(--blue);color:#fff;font-weight:600}
.main{flex:1;min-width:0;padding:20px 24px;overflow:auto}
.topbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.topbar h1{font-size:18px;margin:0;font-weight:600}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--ok);margin-right:8px;vertical-align:middle}
.topbar .sub{color:var(--muted);font-size:12px}
.view{display:none}
.view.active{display:block}
.sysgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px 24px;margin-bottom:8px}
.sysrow{display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--line)}
.sysrow span{color:var(--muted)}
.sysrow b{font-weight:600}
.dotstat{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.dotstat.on{background:var(--ok)}.dotstat.off{background:var(--danger)}
.ppreview{margin-top:12px;border:1px solid var(--border);border-radius:8px;padding:12px;background:#f7faff}
.ppreview-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:13px}
.ppreview-h button{padding:3px 10px;font-size:12px}
.cfgrow{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px;font-size:13px}
.cfgrow input{width:120px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;font:inherit;font-size:13px}
.cfgrow label{color:var(--muted)}
</style></head><body><div class="app">
<aside class="side"><div class="brand">Relay 指挥台</div><nav>
<div class="navitem active" data-view="overview">运行总览</div>
<div class="navitem" data-view="roles">身份角色管理</div>
<div class="navitem" data-view="pipeline">流水线编排</div>
<div class="navitem" data-view="takeover">一键接管</div>
</nav></aside>
<main class="main">
<div class="topbar"><h1><span class="dot"></span>Relay 联合办公指挥台</h1><div class="sub">本地 · 离线 · 更新于 ${esc(updated)}</div></div>
<div id="view-overview" class="view active">
<div class="kpis">
  <div class="kpi"><div class="num">${counts.tasks}</div><div class="lab">任务总数</div></div>
  <div class="kpi"><div class="num">${counts.runs}</div><div class="lab">调用次数</div></div>
  <div class="kpi ok"><div class="num">${counts.ok}</div><div class="lab">成功次数</div></div>
  <div class="kpi ${rate >= 90 ? 'ok' : rate >= 60 ? 'warn' : 'danger'}"><div class="num">${rate}<span class="u">%</span></div><div class="lab">成功率</div></div>
  <div class="kpi ${costColor}"><div class="num">¥${(c.spent || 0).toFixed(3)}</div><div class="lab">累计成本 · 预算 ¥${(c.limit || 0)}</div></div>
  <div class="kpi ${chainColor}"><div class="num sm">${esc(zhStatus(status && status.result))}</div><div class="lab">最近链状态${c.degraded ? ' · 已降级' : ''}</div></div>
</div>
${systemView}
${repairHtml}${pendingHtml}<section class="card"><div class="sec-h">接力链执行</div>
<table><thead><tr><th>环节</th><th>任务</th><th>智能体</th><th>结果</th><th>重试</th><th>模式</th><th>上下文交接</th><th>Token</th><th>本步成本</th><th>耗时</th></tr></thead>
<tbody>${chainRows}</tbody></table></section>
<section class="card"><div class="sec-h">💰 成本核算</div>
<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:14px">
<div class="kpi ${costColor}"><div class="num">¥${(c.spent || 0).toFixed(3)}</div><div class="lab">已花费</div></div>
<div class="kpi muted"><div class="num">¥${(c.limit || 0)}</div><div class="lab">预算上限</div></div>
<div class="kpi ${costColor}"><div class="num sm">${c.degraded ? '已触发降级' : (c.spent > c.limit ? '已超预算' : '正常')}</div><div class="lab">成本状态</div></div>
</div>
<table><thead><tr><th>任务</th><th>环节 / 智能体</th><th>Token（来源）</th><th>本步成本</th><th>降级</th></tr></thead><tbody>${costRows}</tbody></table></section>
<section class="card"><div class="sec-h">最近调用记录</div>
<table><thead><tr><th>时间</th><th>任务</th><th>智能体</th><th>结果</th><th>Token</th><th>成本</th><th>耗时</th></tr></thead>
<tbody>${logRows}</tbody></table></section>
<section class="card"><div class="sec-h">各环节产物<span class="dim sec-sub">共 ${previewItems.length} 个 · 成功 ${okCount} · 失败 ${failCount}</span>${pvTools}</div>
<div class="grid pv-grid" id="pv-grid">${cards || '<div class="dim">暂无产物（先跑一次链路）</div>'}</div></section>
</div>
<div id="view-roles" class="view">${rolesView}</div>
<div id="view-pipeline" class="view">${pipelineView}</div>
<div id="view-takeover" class="view">${takeoverView}</div>
</main>
</div>
<script>
document.querySelectorAll('.navitem').forEach(function(el){el.addEventListener('click',function(){document.querySelectorAll('.navitem').forEach(function(n){n.classList.remove('active');});el.classList.add('active');document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});var t=document.getElementById('view-'+el.getAttribute('data-view'));if(t)t.classList.add('active');});});
</script>
${scriptSlot}
</body></html>`;
}

async function main() {
  const goalArg = process.argv[2];
  let beat = '';
  if (goalArg) {
    const p = await dispatch({ task_id: 'example-001', role: 'code' });
    beat = '（心跳：example-001 干跑 ok=' + JSON.parse(p.content[0].text).ok + '）';
  }
  const g = gather();
  const out = path.join(__dirname, '..', 'cockpit.html');
  fs.writeFileSync(out, render(g), 'utf8');
  console.log('✅ 指挥台快照已生成：', out);
  console.log(`   任务 ${g.counts.tasks} · 调用记录 ${g.counts.runs} · 链状态 ${g.status ? g.status.result : '无'}`, beat);
}

module.exports = { render, gather, readLines, readJson, readResult, taskIds, esc, BB, zhRole, zhStep, zhStatus, zhLevel, fmtTime };

if (require.main === module) {
  main().catch((e) => { console.error('cockpit 失败:', e); process.exit(1); });
}
