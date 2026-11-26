'use strict';
/**
 * cockpit-server.js —— 本地指挥台控制台（零依赖）：实时状态 + 一键接管动作。
 *   监听 127.0.0.1:<port>（默认 8770）。动作只作用于本机 blackboard 目录，不联网。
 *   GET  /              → 带“接管”按钮的实时指挥台
 *   GET  /api/status    → 当前链状态 + run-log（JSON，供轮询）
 *   POST /api/run       → 断点续跑链（?fresh=1 全重跑）
 *   POST /api/retry     → 重跑某一步（删 _state 再 dispatch 一次）  body:{task}
 *   POST /api/ignore    → 人工忽略某步（写 _state.ok=true）→ 续跑时可跳过该步  body:{task}
 * 用法： node server/cockpit-server.js   然后浏览器打开 http://127.0.0.1:8770
 */
const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const cockpit = require('./cockpit');
const { BB } = cockpit;
const core = require('./core');
const { dispatch, readResultTool } = core;
const safety = require('./safety');
const roles = require('./roles');
const pipeline = require('./pipeline');
const cost = require('./cost');

// ── 可视化配置（预算/项目/安全开关）持久化到 blackboard/config.json，并即时写入 process.env 供子进程继承 ──
const CONFIG = path.join(BB, 'config.json');
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { return {}; } }
function applyConfig(c) {
  if (c && c.costLimit !== undefined && c.costLimit !== '') process.env.RELAY_COST_LIMIT = String(c.costLimit);
  if (c && c.project) process.env.RELAY_PROJECT_ID = String(c.project);
  if (c && c.safetyDisabled !== undefined) process.env.RELAY_SAFETY_DISABLED = c.safetyDisabled ? '1' : '';
}
function saveConfig(c) { try { fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2), 'utf8'); } catch (e) {} applyConfig(c); return { ok: true }; }
applyConfig(loadConfig());
function portOpen(p) { return new Promise((res) => { const s = net.connect(p, '127.0.0.1'); s.setTimeout(700); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); s.on('timeout', () => { s.destroy(); res(false); }); }); }

const PORT = parseInt(process.env.RELAY_COCKPIT_PORT || '8770', 10);
const HOST = '127.0.0.1';
const BOOT_AT = new Date().toLocaleString('zh-CN', { hour12: false });
// 代码戳：server 目录里所有 .js 的最新修改时间（秒）。用于识别"端口上跑的是不是当前这份代码"
const BUILD_STAMP = (() => {
  try {
    let mx = 0;
    for (const f of fs.readdirSync(__dirname)) if (/\.js$/i.test(f)) { const m = fs.statSync(path.join(__dirname, f)).mtimeMs; if (m > mx) mx = m; }
    return Math.floor(mx / 1000);
  } catch (e) { return 0; }
})();
const CHAIN = path.join(__dirname, 'chain.js');
const safe = (s) => String(s).replace(/[^a-zA-Z0-9_.-]/g, '_');

function page() {
  const g = cockpit.gather();
  const base = cockpit.render(g, { live: true });
  const st = g.status;
  const actions = st
    ? `<section class="card" id="takeover"><div class="sec-h">🎛 一键接管</div><div class="tbar">
        <button onclick="run(false)">▶ 断点续跑（跳过已成功）</button>
        <button onclick="run(true)">↺ 全重跑</button>
        <button class="go" onclick="driveChain()">🤖 主控驱动全链（自动批准待确认腿）</button>
        <span class="hint">点每步按钮可“重跑该步 / 人工忽略续跑”。当前状态：${cockpit.esc(cockpit.zhStatus(st.result))}</span>
       </div>
       <table><thead><tr><th>环节</th><th>任务</th><th>智能体</th><th>状态</th><th>接管动作</th></tr></thead><tbody>
       ${st.steps.map((s) => {
         const ic = s.held ? '⏳ 待确认' : s.blocked ? '⛔ 拦截' : s.ok ? '✅ 成功' : '❌ 失败';
         const cls = s.held ? 'warn' : !s.ok ? 'bad' : '';
         return `<tr class="${cls}"><td><b>${cockpit.esc(cockpit.zhStep(s.id) || cockpit.zhRole(s.role))}</b></td><td class="dim">${cockpit.esc(s.id)}</td><td>${cockpit.esc(cockpit.zhRole(s.role))}</td><td>${ic}</td><td>
          <button onclick="retryTask('${s.id}')">重跑该步</button>
          <button onclick="diagnose('${s.id}')">🔍 诊断</button>
          ${s.held ? `<button class="go" onclick="approve('${s.id}')">✔ 批准执行</button><button onclick="reject('${s.id}')">✖ 拒绝</button>` : ''}
          ${!s.ok ? `<button onclick="ignoreTask('${s.id}')">忽略并续跑</button>` : ''}
          <div class="diag" id="diag-${s.id}" style="display:none"></div>
         </td></tr>`;
       }).join('')}
       </tbody></table></section>`
         : '<section class="card"><div class="sec-h">🎛 一键接管</div><p class="dim">尚无链记录（先跑一次 chain.js --halt-demo 制造停点）。</p></section>';
  const rolesList = roles.all();
  const roleRow = (r) => `<tr><td class="dim">${cockpit.esc(r.id)}</td><td><b>${cockpit.esc(r['身份'] || '')}</b></td><td>${cockpit.esc(r.role || '')}</td><td>${cockpit.esc(r.agent || '')}</td><td>${cockpit.esc(r['工作类型'] || '')}</td><td class="dim">${cockpit.esc(String(r['职责'] || '').slice(0, 40))}</td><td><button onclick="editRole('${cockpit.esc(r.id)}')">编辑</button> <button onclick="delRole('${cockpit.esc(r.id)}')">删除</button></td></tr>`;
  const rolesSection = `<section class="card" id="roles"><div class="sec-h">🎭 角色 / 身份管理（按工作类型自定义，保存后即时生效）</div>
    <div class="tbar"><button class="go" onclick="newRole()">＋ 新建角色</button><span class="hint">共 ${rolesList.length} 张 · 写入 blackboard/roles.json（自动备份，无需重启）</span></div>
    <p class="dim" style="margin:6px 0 10px">⚠️ <b>总线角色决定这一步调度到谁</b>：research→元宝 · code→CodeBuddy · editor→VSCode · <b>workbuddy→主控自己执行</b>（不调外部程序，产物由主控提交）。「扮演应用」只是标签，不参与调度。</p>
    <table><thead><tr><th>id</th><th>身份</th><th>总线角色</th><th>扮演应用</th><th>工作类型</th><th>职责</th><th>操作</th></tr></thead><tbody>${rolesList.map(roleRow).join('') || '<tr><td colspan="7" class="dim">暂无角色卡，点“新建角色”。</td></tr>'}</tbody></table>
    <div id="roleform" class="rform" style="display:none">
      <div class="rgrid">
        <label>id<input id="r_id" placeholder="英文/数字，如 zhuangao"></label>
        <label>身份名称<input id="r_name" placeholder="如：撰稿作者"></label>
        <label>总线角色<select id="r_role"><option value="research">research（调研 → 元宝）</option><option value="code">code（编码/写作 → CodeBuddy）</option><option value="editor">editor（排版/审阅 → VSCode）</option><option value="workbuddy">workbuddy（主控自己执行 → WorkBuddy）</option><option value="single">single（单Agent）</option></select></label>
        <label>扮演应用<select id="r_agent" onchange="if(this.value==='WorkBuddy')document.getElementById('r_role').value='workbuddy'"><option>元宝</option><option>CodeBuddy</option><option>VSCode</option><option>WorkBuddy</option></select></label>
        <label>工作类型<input id="r_wt" placeholder="如：内容生产 / 办公周报 / 代码"></label>
      </div>
      <label>职责<textarea id="r_duty" rows="2" placeholder="这个身份负责做什么"></textarea></label>
      <label>交付格式<textarea id="r_deliver" rows="2" placeholder="必须按什么格式产出"></textarea></label>
      <label>协作关系<textarea id="r_collab" rows="2" placeholder="上游给什么 / 下游交给谁"></textarea></label>
      <label>硬性约束<textarea id="r_constrain" rows="2" placeholder="绝不能做 / 必须遵守"></textarea></label>
      <div class="tbar"><button class="go" onclick="saveRole()">保存角色</button><button onclick="document.getElementById('roleform').style.display='none'">取消</button></div>
    </div></section>`;
  const pipeNames = pipeline.names(); const pipeCur = pipeline.currentName(); const pipeSteps = pipeline.get(pipeCur); const roleOpts = roles.all();
  const pipeMeta = pipeline.meta(pipeCur) || { 业务事项: '', 当前版本: 0, 版本: [] };
  const pipelineSection = `<section class="card" id="pipeline"><div class="sec-h">🔗 流水线编排（按业务事项归类 · 每次保存生成新版本，可回滚/查看）</div>
    <div class="tbar">
      <select id="p_sel" onchange="viewPipeline(this.value)">${pipeNames.map((n) => `<option value="${cockpit.esc(n)}"${n === pipeCur ? ' selected' : ''}>${cockpit.esc(n)}</option>`).join('')}</select>
      <button onclick="switchPipeline()">设为当前执行</button>
      <button onclick="delPipeline()">删除此条</button>
      <input id="p_newname" placeholder="新业务流水线名" style="max-width:180px">
      <button onclick="newPipeline()">新建</button>
      <button class="go" onclick="runPipeline(false)">▶ 续跑</button>
      <button class="go" onclick="runPipeline(true)">↺ 全重跑</button>
    </div>
    <div class="cfgrow"><label>业务事项</label><input id="p_biz" value="${cockpit.esc(pipeMeta.业务事项 || '')}" placeholder="这条流水线处理什么业务，如：长文/公众号、周报、竞品调研" style="flex:1;min-width:260px"></div>
    <div id="p_steps" class="psteps"></div>
    <div class="tbar"><button onclick="addStep()">＋ 加一步</button><button class="go" onclick="savePipeline()">保存为新版本</button><span class="hint">保存会追加一个版本（填变更说明）；chain.js 与主控 run_chain 按“当前流水线 · 当前版本”执行。</span></div>
    <div class="sec-h" style="margin-top:14px">🗂 版本历史（当前 v${pipeMeta.当前版本 || 0}）</div>
    <div id="p_versions"></div>
    <div id="p_preview" class="ppreview" style="display:none"></div>
    <div class="hint" id="p_runout" style="margin-top:8px"></div></section>`;
  const esc = cockpit.esc;
  const cl = cost.load(); const proj = process.env.RELAY_PROJECT_ID || 'demo';
  const cp = (cl.projects && cl.projects[proj]) || { spent: 0, degraded: false };
  const sysCfg = loadConfig();
  const systemCard = `<section class="card"><div class="sec-h">🖥 系统与连接</div>
    <div class="sysgrid">
      <div class="sysrow"><span>服务版本</span><b>${esc(core.SERVER_INFO.name)} v${esc(core.SERVER_INFO.version)}</b></div>
      <div class="sysrow"><span>当前流水线</span><b>${esc(pipeline.currentName())}</b>（${pipeline.get(pipeline.currentName()).length} 步）</div>
      <div class="sysrow"><span>项目 / 账本</span><b>${esc(proj)}</b></div>
      <div class="sysrow"><span>预算 / 已花费</span><b>¥${cost.limit()} / ¥${(cp.spent || 0).toFixed(3)}</b>${cp.degraded ? ' · 已降级' : ''}</div>
      <div class="sysrow"><span>安全闸门</span><b>${safety.DISABLED() ? '已关闭' : '启用'}</b></div>
      <div class="sysrow"><span>MCP 工具</span><b>${core.TOOLS.length} 个</b>：${core.TOOLS.map((t) => esc(t.name)).join(' · ')}</div>
      <div class="sysrow"><span>运行时代码</span><b title="${esc(__filename)}">${esc(path.basename(__filename))} · 端口 ${PORT} · 启动 ${esc(BOOT_AT)}</b><div class="dim">${esc(__dirname)} · 代码戳 ${BUILD_STAMP}</div></div>
      <div class="sysrow"><span>连接健康</span><b id="sysports">检测中…</b></div>
    </div>
    <div class="cfgrow">
      <label>预算 ¥<input id="cfg_limit" value="${esc(String(sysCfg.costLimit !== undefined ? sysCfg.costLimit : cost.limit()))}"></label>
      <label>项目/账本<input id="cfg_project" value="${esc(proj)}"></label>
      <label>安全闸门<select id="cfg_safety"><option value="0"${safety.DISABLED() ? '' : ' selected'}>启用</option><option value="1"${safety.DISABLED() ? ' selected' : ''}>关闭</option></select></label>
      <button class="go" onclick="saveConfig()">保存配置</button>
      <span class="hint">写入 blackboard/config.json，指挥台与子进程即时生效。</span>
    </div></section>`;
  const script = `<style>.tbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}button{font:inherit;font-size:13px;padding:7px 14px;border:1px solid var(--border);background:#fff;border-radius:8px;cursor:pointer;color:var(--text)}button.go{background:var(--ok);color:#fff;border-color:var(--ok)}button:hover{border-color:var(--blue);color:var(--blue)}button.go:hover{color:#fff}.hint{color:var(--muted);font-size:12px;margin-left:8px}#toast{position:fixed;right:16px;bottom:16px;background:#1f2329;color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;display:none}.diag{margin-top:8px;padding:10px 12px;background:#fafbfc;border:1px solid var(--border);border-radius:8px;font-size:12px;line-height:1.6;max-width:640px}.diag .dh{font-weight:600;margin-bottom:4px}.diag .dn{color:var(--danger);white-space:pre-wrap;word-break:break-word}.diag .dsec{margin-top:6px}.diag .dlabel{color:var(--muted)}.diag pre{max-height:160px;overflow:auto;background:#fff;border:1px solid var(--border);border-radius:6px;padding:8px;margin:4px 0 0;white-space:pre-wrap;word-break:break-word}.diag .rp{margin-top:8px;padding:8px;background:#fff7f7;border:1px solid #f0c4c4;border-radius:6px;white-space:pre-wrap;word-break:break-word;color:#7a1f1f}.rform{margin-top:14px;padding:14px;background:#fafbfc;border:1px solid var(--border);border-radius:8px}.rform label{display:block;font-size:12px;color:var(--muted);margin:8px 0 2px}.rform input,.rform select,.rform textarea{width:100%;font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:#fff;color:var(--text);box-sizing:border-box}.rform textarea{resize:vertical}.rgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.psteps{margin:10px 0}.pstep{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:8px;background:#fafbfc;margin-bottom:6px}.pstep .pidx{width:22px;height:22px;flex:none;border-radius:50%;background:var(--blue);color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center}.pstep select{font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:#fff}.pstep .pgoal{flex:1;font-size:12px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:#fff;color:var(--text)}.pstep button{padding:3px 8px;font-size:12px}button[disabled]{opacity:.45;cursor:not-allowed}button[disabled]:hover{border-color:var(--border);color:var(--text)}</style>
  <div id="toast"></div><script>
  const j=(m)=>m.text().then(t=>{try{return JSON.parse(t)}catch(e){return{raw:t}}});
  const toast=(m)=>{const t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',3000)};
  async function run(fresh){toast('续跑中…');const r=await j(await fetch('/api/run'+(fresh?'?fresh=1':''),{method:'POST'}));toast('链结果：'+(r.result||JSON.stringify(r)));setTimeout(()=>location.reload(),500)}
  async function retryTask(t){toast('重跑 '+t);const r=await j(await fetch('/api/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task:t})}));toast(t+' → ok='+(r.ok!==undefined?r.ok:'?'));setTimeout(()=>location.reload(),500)}
  async function ignoreTask(t){toast('忽略 '+t);await fetch('/api/ignore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task:t})});toast('已忽略，自动续跑');setTimeout(()=>location.reload(),300)}
  async function post(t,verb){toast(verb+' '+t);await fetch('/api/'+verb,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task:t})});toast(verb+'完成，续跑');setTimeout(()=>location.reload(),300)}
  async function approve(t){post(t,'approve')}
  async function reject(t){post(t,'reject')}
  const htmlescape=(s)=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  async function diagnose(t){const box=document.getElementById('diag-'+t);if(!box)return;if(box.style.display==='block'){box.style.display='none';return;}box.style.display='block';box.innerHTML='<div class="dh">诊断中…</div>';try{const r=await j(await fetch('/api/result?task='+encodeURIComponent(t)));const st=r.exists?('<div class="dh">'+htmlescape(r.worker||r.role||'')+' · '+(r.ok==='true'||r.ok===true?'✅ 成功':'❌ 失败')+'</div>'):('<div class="dh">无 result.md（该步未跑过）</div>');let html=st;if(r.note)html+='<div class="dsec"><span class="dlabel">note：</span><div class="dn">'+htmlescape(r.note)+'</div></div>';if(r.summary)html+='<div class="dsec"><span class="dlabel">摘要：</span>'+htmlescape(r.summary)+'</div>';if(r.output_preview)html+='<div class="dsec"><span class="dlabel">产物预览：</span><pre>'+htmlescape(r.output_preview)+'</pre></div>';if(r.repairPrompt)html+='<div class="rp"><b>🛠 修复提示词（贴回主控）</b>\\n'+htmlescape(r.repairPrompt)+'</div>';box.innerHTML=html;}catch(e){box.innerHTML='<div class="dh">诊断失败：'+htmlescape(e.message)+'</div>';}}
  const ROLES=${JSON.stringify(rolesList)};
  const setVal=(id,v)=>{const e=document.getElementById(id);if(e)e.value=v||'';};
  function newRole(){['r_id','r_name','r_wt','r_duty','r_deliver','r_collab','r_constrain'].forEach(i=>setVal(i,''));setVal('r_role','code');setVal('r_agent','CodeBuddy');document.getElementById('r_id').disabled=false;document.getElementById('roleform').style.display='block';}
  function editRole(id){const c=ROLES.find(r=>r.id===id);if(!c)return;setVal('r_id',c.id);setVal('r_name',c['身份']);setVal('r_role',c.role);setVal('r_agent',c.agent);setVal('r_wt',c['工作类型']);setVal('r_duty',c['职责']);setVal('r_deliver',c['交付']);setVal('r_collab',c['协作']);setVal('r_constrain',c['约束']);document.getElementById('r_id').disabled=true;document.getElementById('roleform').style.display='block';}
  async function saveRole(){const card={id:document.getElementById('r_id').value.trim(),'身份':document.getElementById('r_name').value.trim(),role:document.getElementById('r_role').value,agent:document.getElementById('r_agent').value,'工作类型':document.getElementById('r_wt').value.trim(),'职责':document.getElementById('r_duty').value.trim(),'交付':document.getElementById('r_deliver').value.trim(),'协作':document.getElementById('r_collab').value.trim(),'约束':document.getElementById('r_constrain').value.trim()};if(!card.id){toast('id 不能为空');return;}const r=await j(await fetch('/api/roles/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(card)}));if(r.ok){toast('已保存角色 '+card.id);setTimeout(()=>location.reload(),400);}else toast('保存失败：'+(r.error||JSON.stringify(r)));}
  async function delRole(id){if(!confirm('删除角色 '+id+'？此操作会写回 roles.json（有自动备份）。'))return;const r=await j(await fetch('/api/roles/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})}));if(r.ok){toast('已删除 '+id);setTimeout(()=>location.reload(),400);}else toast('删除失败');}
  const PIPE={current:${JSON.stringify(pipeCur)}, name:${JSON.stringify(pipeCur)}, steps:${JSON.stringify(pipeSteps)}, biz:${JSON.stringify(pipeMeta.业务事项 || '')}, curVer:${pipeMeta.当前版本 || 0}, versions:${JSON.stringify(pipeline.versionsOf(pipeCur))}};
  const ROLECARDS=${JSON.stringify(roleOpts)};
  var curSteps=PIPE.steps.map(function(s){return Object.assign({},s);});
  var curBiz=PIPE.biz, curVer=PIPE.curVer, curVersions=PIPE.versions, curName=PIPE.name;
  function escA(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}
  function popt(sel){return ROLECARDS.map(function(c){return '<option value="'+escA(c.id)+'"'+(c.id===sel?' selected':'')+'>'+escA(c['身份']||c.id)+'（'+escA(c.agent||c.role)+'）</option>';}).join('');}
  function renderSteps(){var el=document.getElementById('p_steps');if(!el)return;el.innerHTML=curSteps.map(function(s,i){return '<div class="pstep"><span class="pidx">'+(i+1)+'</span><select onchange="setPersona('+i+',this.value)">'+popt(s.persona)+'</select><input class="pgoal" value="'+escA(s.goal)+'" onchange="setGoal('+i+',this.value)" placeholder="这一步的指令/目标"><button onclick="moveStep('+i+',-1)">↑</button><button onclick="moveStep('+i+',1)">↓</button><button onclick="delStep('+i+')">✕</button></div>';}).join('')||'<div class="dim">暂无步骤，点“加一步”。</div>';renderVersions();}
  function renderVersions(){var el=document.getElementById('p_versions');if(!el)return;var one=curVersions.length<=1;el.innerHTML='<div class="hint" style="margin-bottom:6px">回滚 = 把该历史版本设为“当前执行版本”（chain.js / 主控 run_chain 会用它）。当前版本行回滚置灰属正常。</div><table><thead><tr><th>版本</th><th>时间</th><th>变更说明</th><th>步数</th><th>操作</th></tr></thead><tbody>'+curVersions.map(function(x){var cur=x.v===curVer;var rb=cur?'<button disabled title="已是当前版本">回滚到此版本</button>':'<button class="go" onclick="saveVersion('+x.v+')">回滚到此版本</button>';var db=one?'<button disabled title="至少保留一个版本">删除</button>':'<button onclick="delVersion('+x.v+')">删除</button>';return '<tr'+(cur?' style="background:#eef4ff"':'')+'><td><b>v'+x.v+'</b>'+(cur?' <span class="tag">当前</span>':'')+'</td><td class="dim">'+escA(x.at?String(x.at).replace('T',' ').slice(0,19):'—')+'</td><td>'+escA(x.note||'')+'</td><td>'+x.steps+'</td><td><button onclick="viewVersion('+x.v+')">查看</button> '+rb+' '+db+'</td></tr>';}).join('')+'</tbody></table>';}
  function setPersona(i,v){curSteps[i].persona=v;renderSteps();}
  function setGoal(i,v){curSteps[i].goal=v;}
  function addStep(){curSteps.push({id:'p-'+Date.now().toString(36),persona:(ROLECARDS[0]||{}).id||'',goal:''});renderSteps();}
  function delStep(i){curSteps.splice(i,1);renderSteps();}
  function moveStep(i,d){var j=i+d;if(j<0||j>=curSteps.length)return;var t=curSteps[i];curSteps[i]=curSteps[j];curSteps[j]=t;renderSteps();}
  async function viewPipeline(name){var d=await j(await fetch('/api/pipeline?name='+encodeURIComponent(name)));curName=d.name;curSteps=(d.steps||[]).map(function(s){return Object.assign({},s);});curBiz=d.业务事项||'';curVer=d.当前版本||0;curVersions=d.versions||[];var b=document.getElementById('p_biz');if(b)b.value=curBiz;renderSteps();}
  async function viewVersion(v){var d=await j(await fetch('/api/pipeline/version?name='+encodeURIComponent(curName)+'&v='+v));var el=document.getElementById('p_preview');if(!el)return;var rows=(d.steps||[]).map(function(s,i){var c=ROLECARDS.find(function(r){return r.id===s.persona;})||{};return '<tr><td>'+(i+1)+'</td><td><b>'+escA(c['身份']||s.persona||'')+'</b></td><td>'+escA(c.agent||'')+'</td><td class="dim">'+escA(s.goal||'')+'</td></tr>';}).join('');el.innerHTML='<div class="ppreview-h"><b>👁 v'+v+' 预览（只读，未改动编辑区）</b><button onclick="closePreview()">关闭</button></div><table><thead><tr><th>#</th><th>身份</th><th>应用</th><th>该步指令</th></tr></thead><tbody>'+(rows||'<tr><td colspan="4" class="dim">该版本无步骤</td></tr>')+'</tbody></table>';el.style.display='block';el.scrollIntoView({behavior:'smooth',block:'nearest'});}
  function closePreview(){var el=document.getElementById('p_preview');if(el){el.style.display='none';el.innerHTML='';}}
  async function saveVersion(v){if(!confirm('把「'+curName+'」的当前执行版本回滚到 v'+v+'？'))return;var r=await j(await fetch('/api/pipeline/version',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:curName,v:v})}));if(r.ok){toast('已回滚到 v'+v);setTimeout(function(){location.reload();},400);}else toast('失败：'+(r.error||''));}
  async function delVersion(v){if(!confirm('删除 v'+v+'？'))return;var r=await j(await fetch('/api/pipeline/version/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:curName,v:v})}));if(r.ok){toast('已删除 v'+v);setTimeout(function(){location.reload();},400);}else toast('失败：'+(r.error||''));}
  async function savePipeline(){var name=document.getElementById('p_sel').value||document.getElementById('p_newname').value.trim();if(!name){toast('请选/填流水线名');return;}var biz=document.getElementById('p_biz').value.trim();var note=window.prompt('本次变更说明（作为新版本记录）：','');if(note===null)return;var r=await j(await fetch('/api/pipeline/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,steps:curSteps,note:note,业务事项:biz})}));if(r.ok){toast(r.unchanged?('无变化，未生成新版本'):('已保存 v'+r.version+'（'+r.count+' 步）'));setTimeout(function(){location.reload();},500);}else toast('保存失败：'+(r.error||''));}
  async function switchPipeline(){var name=document.getElementById('p_sel').value;var r=await j(await fetch('/api/pipeline/use',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})}));if(r.ok){toast('当前执行流水线：'+name);setTimeout(function(){location.reload();},400);}else toast('切换失败');}
  async function newPipeline(){var name=document.getElementById('p_newname').value.trim();if(!name){toast('填新流水线名');return;}var r=await j(await fetch('/api/pipeline/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,steps:[],note:'新建',业务事项:document.getElementById('p_biz').value.trim()})}));if(r.ok){await fetch('/api/pipeline/use',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})});toast('已新建「'+name+'」');setTimeout(function(){location.reload();},400);}else toast('失败');}
  async function delPipeline(){var name=document.getElementById('p_sel').value;if(!confirm('删除流水线「'+name+'」及其全部版本？'))return;var r=await j(await fetch('/api/pipeline/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})}));if(r.ok){toast('已删除');setTimeout(function(){location.reload();},400);}else toast('失败');}
  async function runPipeline(fresh){toast('跑流水线中…（操作型腿会卡待确认）');var r=await j(await fetch('/api/pipeline/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fresh:fresh})}));var out=document.getElementById('p_runout');if(out)out.textContent='运行结果：'+(r.result||JSON.stringify(r));toast('链结果：'+(r.result||''));setTimeout(function(){location.reload();},600);}
  function dot(on){return '<span class="dotstat '+(on?'on':'off')+'"></span>';}
  async function loadSystem(){try{var s=await j(await fetch('/api/system'));var el=document.getElementById('sysports');if(el)el.innerHTML=dot(s.ports.cockpit)+'指挥台　'+dot(s.ports.sse)+'SSE　'+dot(s.ports.edge)+'Edge(CDP)';}catch(e){var el2=document.getElementById('sysports');if(el2)el2.textContent='检测失败';}}
  async function saveConfig(){var c={costLimit:document.getElementById('cfg_limit').value.trim(),project:document.getElementById('cfg_project').value.trim(),safetyDisabled:document.getElementById('cfg_safety').value==='1'};var r=await j(await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)}));if(r.ok){toast('配置已保存');setTimeout(function(){location.reload();},500);}else toast('保存失败：'+(r.error||''));}
  async function driveChain(){toast('主控驱动全链中…（自动批准待确认腿）');var r=await j(await fetch('/api/drive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fresh:true})}));toast('驱动结果：'+(r.result||JSON.stringify(r)));setTimeout(function(){location.reload();},700);}
  document.addEventListener('DOMContentLoaded',function(){renderSteps();loadSystem();});
  </script>`;
  return base
    .replace('<!--VIEW_TAKEOVER-->', actions)
    .replace('<!--VIEW_ROLES-->', rolesSection)
    .replace('<!--VIEW_PIPELINE-->', pipelineSection)
    .replace('<!--SYSTEMCARD-->', systemCard)
    .replace('<!--SCRIPT-->', script);
}

function body(req) {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { res({}); } });
  });
}

async function runChain(fresh) {
  const args = [CHAIN];
  if (fresh) args.push('--fresh');
  if (process.env.RELAY_CHAIN_HAD_DEMO === '1') args.push('--halt-demo');
  const r = spawnSync(process.execPath, args, { env: process.env, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/链停在：(\S+)|✅ 接力链完成/);
  return { result: m ? (m[1] || 'done') : 'done', tail: out.split('\n').slice(-3).join(' | '), code: r.status };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const send = (code, obj, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };

  if (req.method === 'GET' && u.pathname === '/') return send(200, page(), 'text/html');
  if (req.method === 'GET' && u.pathname === '/api/status') return send(200, cockpit.gather());

  if (req.method === 'GET' && u.pathname === '/api/result') {
    const t = u.searchParams.get('task') || '';
    const p = JSON.parse(readResultTool({ task_id: t }).content[0].text);
    // 若该步正是停链失败步，附带修复提示词
    try { const st = JSON.parse(fs.readFileSync(path.join(BB, 'runs', 'chain-demo.status.json'), 'utf8')); if (st.repair && st.repair.stepId === t) p.repairPrompt = st.repair.prompt; } catch (e) {}
    return send(200, p);
  }

  if (req.method === 'POST' && u.pathname === '/api/run') return send(200, await runChain(u.searchParams.get('fresh') === '1'));

  if (req.method === 'POST' && u.pathname === '/api/retry') {
    const { task } = await body(req);
    if (!task) return send(400, { error: 'task 必填' });
    const state = path.join(BB, 'tasks', safe(task), '_state.json');
    try { fs.rmSync(state); } catch (e) {}
    const p = await dispatch({ task_id: task });
    return send(200, JSON.parse(p.content[0].text));
  }

  if (req.method === 'POST' && u.pathname === '/api/ignore') {
    const { task } = await body(req);
    if (!task) return send(400, { error: 'task 必填' });
    const dir = path.join(BB, 'tasks', safe(task));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '_state.json'), JSON.stringify({ ok: true, manual: 'ignored-by-human', at: new Date().toISOString() }), 'utf8');
    return send(200, { ok: true, ignored: task, note: '下一步“断点续跑”将跳过该步' });
  }

  if (req.method === 'POST' && u.pathname === '/api/approve') {
    const { task } = await body(req);
    if (!task) return send(400, { error: 'task 必填' });
    return send(200, safety.setConfirmation(task, 'approved'));
  }
  if (req.method === 'POST' && u.pathname === '/api/reject') {
    const { task } = await body(req);
    if (!task) return send(400, { error: 'task 必填' });
    return send(200, safety.setConfirmation(task, 'rejected'));
  }

  // ── 角色/身份管理入口 ──
  if (req.method === 'GET' && u.pathname === '/api/roles') return send(200, { roles: roles.all() });
  if (req.method === 'POST' && u.pathname === '/api/roles/save') {
    const card = await body(req);
    return send(200, roles.upsert(card));
  }
  if (req.method === 'POST' && u.pathname === '/api/roles/delete') {
    const { id } = await body(req);
    if (!id) return send(400, { error: 'id 必填' });
    return send(200, roles.remove(id));
  }

  // ── 流水线编排入口（业务事项 + 版本管理）──
  if (req.method === 'GET' && u.pathname === '/api/pipeline') {
    const name = u.searchParams.get('name') || pipeline.currentName();
    const m = pipeline.meta(name);
    return send(200, { current: pipeline.currentName(), names: pipeline.names(), name, 业务事项: (m && m.业务事项) || '', 当前版本: (m && m.当前版本) || 0, versions: pipeline.versionsOf(name), steps: pipeline.get(name) });
  }
  if (req.method === 'GET' && u.pathname === '/api/pipeline/version') {
    const name = u.searchParams.get('name') || pipeline.currentName(); const v = u.searchParams.get('v');
    return send(200, { name, v: Number(v), steps: pipeline.getStepsAt(name, v) });
  }
  if (req.method === 'POST' && u.pathname === '/api/pipeline/save') {
    const { name, steps, note, 业务事项 } = await body(req);
    return send(200, pipeline.savePipeline(name, steps, { note, 业务事项 }));
  }
  if (req.method === 'POST' && u.pathname === '/api/pipeline/version') {
    const { name, v } = await body(req);
    return send(200, pipeline.setVersion(name, v));
  }
  if (req.method === 'POST' && u.pathname === '/api/pipeline/version/delete') {
    const { name, v } = await body(req);
    return send(200, pipeline.removeVersion(name, v));
  }
  if (req.method === 'POST' && u.pathname === '/api/pipeline/use') {
    const { name } = await body(req);
    return send(200, pipeline.use(name));
  }
  if (req.method === 'POST' && u.pathname === '/api/pipeline/delete') {
    const { name } = await body(req);
    return send(200, pipeline.removePipeline(name));
  }
  if (req.method === 'POST' && u.pathname === '/api/pipeline/run') {
    const b = await body(req);
    return send(200, await runChain(!!b.fresh));
  }

  // ── 系统与连接 / 配置 / 主控驱动 ──
  if (req.method === 'GET' && u.pathname === '/api/system') {
    const ports = { cockpit: await portOpen(PORT), sse: await portOpen(18766), edge: await portOpen(9333) };
    return send(200, { ports, pipeline: pipeline.currentName(), project: process.env.RELAY_PROJECT_ID || 'demo', version: core.SERVER_INFO.version, build: { file: __filename, dir: __dirname, tools: core.TOOLS.length, boot_at: BOOT_AT, port: PORT, stamp: BUILD_STAMP } });
  }
  if (req.method === 'GET' && u.pathname === '/api/config') {
    return send(200, Object.assign({ effective: { costLimit: cost.limit(), project: process.env.RELAY_PROJECT_ID || 'demo', safetyDisabled: safety.DISABLED() } }, loadConfig()));
  }
  if (req.method === 'POST' && u.pathname === '/api/config') {
    const c = await body(req);
    return send(200, saveConfig(c));
  }
  if (req.method === 'POST' && u.pathname === '/api/drive') {
    const b = await body(req);
    let fresh = b.fresh !== false; let result = ''; const trace = [];
    for (let i = 0; i < 8; i++) {
      const r = await runChain(fresh); fresh = false; result = r.result; trace.push({ round: i + 1, result });
      if (result === 'done') break;
      if (result === 'awaiting_confirmation') { safety.listPending().forEach((p) => safety.setConfirmation(p.task_id, 'approved')); continue; }
      break; // halted/blocked：不盲目重试，交给人工（可用 🔍诊断）
    }
    return send(200, { result, trace });
  }

  send(404, { error: 'not found' });
});

server.listen(PORT, HOST, () => console.log(`指挥台控制台： http://${HOST}:${PORT}  （动作仅作用于本机 blackboard）\n  运行代码：${__filename}\n  版本：${core.SERVER_INFO.name} v${core.SERVER_INFO.version} · MCP 工具 ${core.TOOLS.length} 个 · 启动于 ${BOOT_AT}`));
