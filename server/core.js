'use strict';
/**
 * core.js —— 与传输无关的 MCP 逻辑（stdio 与 SSE 共用一份，避免重复实现漂移）
 *   - TOOLS / SERVER_INFO：工具定义
 *   - dispatch(args)：读契约 → 按 role 调 adapter → 写 result.md + run-log → 返回工具结果
 *   - handleMessage(msg, send)：处理 JSON-RPC 方法，用 send(obj) 把响应交回具体传输层
 */
const { readTask, writeResult, appendLog, ADAPTERS, BB } = require('./adapters');
const safety = require('./safety');
const cost = require('./cost');
const roles = require('./roles');
const pipeline = require('./pipeline');
const path = require('path');
const fs = require('fs');

function readInputTexts(inputs) {
  if (!Array.isArray(inputs)) return '';
  let acc = '';
  for (const rel of inputs) {
    try { acc += fs.readFileSync(path.join(costBB, '..', String(rel).replace(/^blackboard[/\\]/, '')), 'utf8'); } catch (e) { acc += String(rel); }
    if (acc.length > 20000) break;
  }
  return acc;
}
const costBB = require('./adapters').BB;

function finishLog(taskId, role, r, resultFile) {
  appendLog({ ts: r.finished_at || new Date().toISOString(), task_id: taskId, role, worker: r.worker, ok: r.ok, duration_ms: r.duration_ms || 0, result_file: resultFile, safety: r.safety && r.safety.level, cost: r.cost && r.cost.cost, tokens: r.cost && (r.cost.tokens_in + r.cost.tokens_out), spent: r.cost && r.cost.spent, degraded: !!r.degraded });
}

const SERVER_INFO = { name: 'relay-dispatch-glue', version: '0.3.0' };
let PROTOCOL = '2024-11-05';

const TOOLS = [
  {
    name: 'dispatch_task',
    description:
      '主控把一个 task_id 派给对应 role 的 worker（code/editor/research）：读黑板任务契约、调用本机应用、把产物写回 result.md 并更新 run-log，返回结构化结果供主控决定下一步。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '黑板里的任务目录名，例如 example-001' },
        role: {
          type: 'string',
          enum: ['code', 'editor', 'research'],
          description: '角色；缺省时用 task.json 里的 role',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'run_chain',
    description:
      '主控一次调用跑完整条内容接力链（调研→大纲→成稿→排版）。遇操作型腿需确认会停下并返回 pending 列表；对 pending 调 approve_task 后再 run_chain 续跑，直到 result=done。',
    inputSchema: { type: 'object', properties: { fresh: { type: 'boolean', description: 'true=全重跑，缺省=断点续跑' } } },
  },
  {
    name: 'approve_task',
    description: '人工批准某个待确认任务（安全闸门），批准后该操作型腿在下次 run_chain/dispatch 时真正执行。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'list_pending',
    description: '列出当前所有“待人工确认”的任务（安全闸门 hold 住的）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_repair_prompt',
    description: '当链路停在异常（worker失败/安全拦截/上下文丢失）时，返回一段可直接贴给人工的中文【异常修复提示词】：哪一步、哪个智能体、根因、建议动作、修好后如何续跑。done 时返回空。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_result',
    description: '只读：取某个任务的 result.md 结构化内容（role/worker/ok/finished_at/note/summary/output 预览）。让主控纯靠工具诊断失败，不必读文件。',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: '任务目录名，例如 chain-01-outline' } }, required: ['task_id'] },
  },
  {
    name: 'read_runlog',
    description: '只读：取最近 N 条 run-log 调用记录（每条含 task_id/role/worker/ok/耗时/成本），最新在前。用于主控纯工具排查“谁在跑、成功没、烧了多少”。',
    inputSchema: { type: 'object', properties: { n: { type: 'number', description: '取最近几条，默认 10，上限 200' } } },
  },
  {
    name: 'list_pipelines',
    description: '只读：列出所有流水线（业务事项）、当前流水线及其版本历史（版本号/时间/变更说明/步数），供主控决定改哪条链、回到哪一版。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '缺省=当前流水线' } } },
  },
  {
    name: 'save_pipeline',
    description:
      '主控动态编排：保存某条流水线的新版本（每次保存追加一个版本，历史可回滚）。steps 数组每项 = {id?, persona(角色卡id), goal(该步指令)}。可同时 业务事项= 业务归类、use=true 设为当前执行链。改完再调 run_chain 即按新链执行。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '流水线名（业务事项键），例如 内容生产' },
        steps: {
          type: 'array',
          description: '步骤序列，每项 {id?, persona, goal}',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              persona: { type: 'string', description: '角色卡 id，例如 yanjiu/dagang/zhuangao/shengao/paiban' },
              goal: { type: 'string', description: '该步交给智能体的指令' },
            },
            required: ['goal'],
          },
        },
        note: { type: 'string', description: '变更说明（写入版本历史）' },
        业务事项: { type: 'string', description: '业务归类描述，如 长文/公众号内容生产' },
        use: { type: 'boolean', description: '是否同时设为当前执行链（默认 true）' },
      },
      required: ['name', 'steps'],
    },
  },
  {
    name: 'set_pipeline_version',
    description: '主控动态编排：把某条流水线的当前版本切到指定历史版本（回滚）。回滚后再 run_chain 即按该版本执行。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '缺省=当前流水线' },
        v: { type: 'number', description: '目标版本号' },
      },
      required: ['v'],
    },
  },
  {
    name: 'use_pipeline',
    description: '主控动态编排：把某条流水线设为「当前执行链」（切换业务事项），随后 run_chain 即按它执行。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '流水线名（业务事项键）' } }, required: ['name'] },
  },
  {
    name: 'submit_main_result',
    description:
      '主控（WorkBuddy）亲自执行某一步后，把产物提交回黑板。run_chain 返回 awaiting_main_agent 时，用它提交 main_tasks 里那一 task_id 的产物，然后再次 run_chain 续跑。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '待提交的任务 id（来自 run_chain 的 main_tasks）' },
        content: { type: 'string', description: '本步的实际产物（可含 Markdown）' },
        summary: { type: 'string', description: '一句话摘要（可选）' },
      },
      required: ['task_id', 'content'],
    },
  },
];

function toolText(obj, isError) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError: !!isError };
}

async function dispatch(args) {
  const started = Date.now();
  const taskId = String(args.task_id || '').trim();
  if (!taskId) return toolText({ error: 'task_id 必填' }, true);

  const task = readTask(taskId);
  const role = args.role || task.role || 'code';
  const adapter = ADAPTERS[role];
  if (!adapter) return toolText({ error: `未知角色: ${role}`, roles: Object.keys(ADAPTERS) }, true);

  // ── 安全闸门：命中高危/敏感 或 操作型腿 → 先拦截/待确认，不调用 worker ──
  // 只判“任务指令”本身（剥离 chain 注入的上游引用上下文，避免被引用内容误触发）
  const instruction = String(task.goal || '').split('\n\n---\n')[0];
  if (!safety.DISABLED()) {
    const decision = safety.decide({ role, goal: instruction, inputs: task.inputs });
    if (decision.level === 'block') {
      const r = { ok: false, blocked: true, status: 'blocked', role, worker: 'safety-gate', safety: decision, summary: '已拦截：不可逆/高危操作', note: '命中: ' + decision.matched.join(','), finished_at: new Date().toISOString(), task_id: taskId };
      const resultFile = writeResult(taskId, r); finishLog(taskId, role, { ...r, duration_ms: 0 }, resultFile);
      process.stderr.write(`[relay-glue] BLOCK task=${taskId} role=${role} matched=${decision.matched}\n`);
      return toolText({ ...r, result_file: resultFile, duration_ms: 0 }, true);
    }
    if (decision.level === 'confirm') {
      const conf = safety.readConfirmation(taskId);
      if (!(conf && conf.status === 'approved')) {
        if (!conf) safety.requestConfirmation(taskId, decision);
        const rejected = conf && conf.status === 'rejected';
        const r = { ok: false, held: !rejected, rejected, status: rejected ? 'rejected' : 'awaiting_confirmation', role, worker: 'safety-gate', safety: decision, summary: rejected ? '人工拒绝执行' : '待人工确认', note: decision.reason, finished_at: new Date().toISOString(), task_id: taskId };
        const resultFile = writeResult(taskId, r); finishLog(taskId, role, { ...r, duration_ms: 0 }, resultFile);
        process.stderr.write(`[relay-glue] ${rejected ? 'REJECT' : 'HOLD'} task=${taskId} role=${role}\n`);
        return toolText({ ...r, result_file: resultFile, duration_ms: 0 }, rejected);
      }
      // approved → 放行到 worker
      process.stderr.write(`[relay-glue] APPROVED→run task=${taskId} role=${role}\n`);
    }
  }

  // ── 成本闸门：本 project 已超预算 → 不再多 agent，改走单 agent 回落 ──
  const project = process.env.RELAY_PROJECT_ID || 'demo';
  let useSingle = false;
  if (role !== 'single' && cost.over(project)) { useSingle = true; }

  let effectiveRole = useSingle ? 'single' : role;
  let r;
  if (useSingle) {
    process.stderr.write(`[relay-glue] DEGRADE task=${taskId} role=${role}→single（超预算回落单 agent）\n`);
  } else {
    process.stderr.write(`[relay-glue] dispatch task=${taskId} role=${role}\n`);
  }
  // ── 身份/角色注入：按 task.persona(卡片id) 或 role 取身份卡，注入 worker 提示词前缀 ──
  const personaText = roles.prefix(task.persona || role);
  if (personaText) process.stderr.write(`[relay-glue] PERSONA task=${taskId} role=${role} card=${(roles.find(task.persona || role) || {}).id} (${personaText.length}字)\n`);
  try {
    const fn = ADAPTERS[effectiveRole];
    r = await fn({ ...task, task_id: taskId, role: effectiveRole, personaText });
  } catch (e) {
    r = { ok: false, role: effectiveRole, worker: effectiveRole, summary: 'adapter 异常', note: String(e) };
  }
  r.finished_at = new Date().toISOString();
  r.task_id = taskId;
  if (useSingle) { r.degraded = true; r.note = (r.note || '') + '；超预算→已降级单 agent'; }
  const duration_ms = Date.now() - started;

  // ── 记账：优先用 worker 回传的真实 usage（CodeBuddy CLI 的 result 事件），无则退回字符估算 ──
  const real = r.usage && (r.usage.input_tokens != null || r.usage.output_tokens != null) ? r.usage : null;
  const tokensIn = real ? Number(real.input_tokens || 0) : cost.estTokens((task.goal || '') + readInputTexts(task.inputs));
  const tokensOut = real ? Number(real.output_tokens || 0) : cost.estTokens((r.resultText || r.summary || ''));
  const tokensSource = real ? 'real' : 'est';
  const stepCost = cost.costOf(effectiveRole, tokensIn, tokensOut);
  const rec = cost.record(project, { task_id: taskId, role: effectiveRole, degraded: !!r.degraded, tokens_in: tokensIn, tokens_out: tokensOut, tokens_source: tokensSource, cost: stepCost, at: new Date().toISOString() });
  r.cost = { project, tokens_in: tokensIn, tokens_out: tokensOut, tokens_source: tokensSource, cost: stepCost, spent: rec.spent, limit: rec.limit, degraded: !!r.degraded };
  if (real) r.usage = { ...real, tokens_source: 'real' };

  const resultFile = writeResult(taskId, r);
  finishLog(taskId, effectiveRole, { ...r, duration_ms }, resultFile);

  return toolText({ ...r, result_file: resultFile, duration_ms }, !r.ok);
}

// ── 编排类 MCP 工具：让主控（WorkBuddy）一条链调到底 ──
function runChainTool(args) {
  const { spawnSync } = require('child_process');
  const a = [path.join(__dirname, 'chain.js'), '--full'];
  if (args && args.fresh) a.push('--fresh');
  // cwd 固定为项目根：链的子进程（CodeBuddy CLI 等）不随调用方的工作目录漂移
  spawnSync(process.execPath, a, { env: process.env, encoding: 'utf8', cwd: path.join(__dirname, '..') });
  let st = null;
  try { st = JSON.parse(fs.readFileSync(path.join(BB, 'runs', 'chain-demo.status.json'), 'utf8')); } catch (e) {}
  const pending = safety.listPending().map((p) => ({ task_id: p.task_id, reason: p.decision && p.decision.reason }));
  const steps = st ? st.steps.map((s) => ({ id: s.id, role: s.role, ok: s.ok, held: !!s.held, skipped: !!s.skipped })) : [];
  const repair = st && st.repair ? st.repair : null;
  const pipe = st && st.pipeline ? st.pipeline : null;
  const mainTasks = (st && st.main_tasks) || [];
  let hint;
  if (st && st.result === 'awaiting_confirmation') hint = '有操作型腿待确认：对 pending 里的每个 task_id 调 approve_task，然后再次 run_chain 续跑。';
  else if (st && st.result === 'awaiting_main_agent') hint = '有步骤要由你（主控）亲自执行：按 main_tasks 里的指令完成后，调 submit_main_result{task_id, content} 提交产物，再调 run_chain 续跑。';
  else if (st && st.result === 'done') hint = '全链完成。';
  else if (repair) hint = '某条腿异常，已生成修复提示词——请把 repairPrompt 原样展示给人工，按其建议修复后再 run_chain 续跑。**禁止自行改跑其它流水线或内置默认四步**（那是用户看不到的偏差）。';
  else hint = '';
  return toolText({ result: st ? st.result : 'no-status', pipeline: pipe, steps, pending, main_tasks: mainTasks, hint, repairPrompt: repair ? repair.prompt : '', repair: repair ? { stepId: repair.stepId, agent: repair.agent, category: repair.category, cause: repair.cause, actions: repair.actions } : null });
}
function repairTool() {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(path.join(BB, 'runs', 'chain-demo.status.json'), 'utf8')); } catch (e) {}
  if (!st) return toolText({ ok: false, note: '尚无链状态（先 run_chain）' });
  if (st.result === 'done') return toolText({ ok: true, result: 'done', repairPrompt: '', note: '链路正常完成，无需修复。' });
  let rep = st.repair;
  if (!rep) { try { rep = require('./repair').forStatus(st); } catch (e) { rep = null; } }
  return toolText({ ok: true, result: st.result, repairPrompt: rep ? rep.prompt : '', repair: rep || null });
}
function parseResultMd(md) {
  const out = {};
  const headEnd = md.indexOf('## Summary');
  const head = headEnd >= 0 ? md.slice(0, headEnd) : md;
  const grab = (k) => { const m = head.match(new RegExp('^-\\s+' + k + ':\\s*(.*)$', 'm')); return m ? m[1].trim() : ''; };
  out.role = grab('role'); out.worker = grab('worker'); out.ok = grab('ok'); out.finished_at = grab('finished_at');
  const nm = head.match(/^-\s+note:\s*([\s\S]*)$/m); out.note = nm ? nm[1].trim() : '';
  const sm = md.split('## Summary')[1] || ''; out.summary = (sm.split('## Output')[0] || '').trim();
  out.output = (md.split('## Output')[1] || '').trim();
  return out;
}
function readResultTool(args) {
  const t = String((args && args.task_id) || '').trim();
  if (!t) return toolText({ error: 'task_id 必填' }, true);
  const dir = path.join(BB, 'tasks', t.replace(/[^a-zA-Z0-9_.-]/g, '_'));
  let md = ''; try { md = fs.readFileSync(path.join(dir, 'result.md'), 'utf8'); } catch (e) {}
  if (!md) return toolText({ task_id: t, exists: false, note: '无 result.md（该任务未跑过或 task_id 不对）' });
  const p = parseResultMd(md);
  return toolText({ task_id: t, exists: true, role: p.role, worker: p.worker, ok: p.ok, finished_at: p.finished_at, note: p.note, summary: p.summary, output_preview: p.output.slice(0, 800) });
}
function readRunlogTool(args) {
  const n = Math.max(1, Math.min(200, parseInt((args && args.n) || 10, 10)));
  let lines = []; try { lines = fs.readFileSync(path.join(BB, 'runs', 'run-log.jsonl'), 'utf8').split('\n').filter(Boolean); } catch (e) {}
  const entries = lines.slice(-n).reverse().map((l) => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
  return toolText({ total: lines.length, returned: entries.length, entries });
}
function approveTool(args) {
  const t = String((args && args.task_id) || '').trim();
  if (!t) return toolText({ error: 'task_id 必填' }, true);
  safety.setConfirmation(t, 'approved');
  return toolText({ ok: true, approved: t, note: '下次 run_chain/dispatch 该腿将真正执行' });
}
function pendingTool() {
  return toolText({ pending: safety.listPending().map((p) => ({ task_id: p.task_id, reason: p.decision && p.decision.reason })) });
}

// ── 动态编排类工具：让主控（harness）能查链 / 改链 / 回滚链 ──
function listPipelinesTool(args) {
  const want = String((args && args.name) || '').trim();
  const cur = pipeline.currentName();
  const p = pipeline.load();
  const items = [];
  Object.keys(p.pipelines || {}).forEach((n) => {
    const m = pipeline.meta(n) || {};
    items.push({
      name: n,
      业务事项: m.业务事项 || '',
      当前版本: m.当前版本,
      版本: pipeline.versionsOf(n),
      steps: (m.版本.find((x) => x.v === m.当前版本) || { steps: [] }).steps,
    });
  });
  const sel = want || cur;
  const selItem = items.find((x) => x.name === sel) || null;
  return toolText({
    current: cur,
    selected: sel,
    pipelines: items,
    current_steps: pipeline.currentSteps().map((s) => ({ id: s.id, persona: s.persona, role: s.role, goal: s.goal })),
    selected_meta: selItem ? { 业务事项: selItem.业务事项, 当前版本: selItem.当前版本 } : null,
    note: '改链：save_pipeline；回滚：set_pipeline_version；改完 run_chain 即按新链执行。',
  });
}
function savePipelineTool(args) {
  const name = String((args && args.name) || '').trim();
  const steps = args && args.steps;
  if (!name) return toolText({ ok: false, error: 'name 必填（流水线名）' }, true);
  if (!Array.isArray(steps) || !steps.length) return toolText({ ok: false, error: 'steps 需为非空数组，每项 {persona, goal}' }, true);
  const norm = steps.map((s, i) => ({
    id: String((s && s.id) || ('p-' + i)),
    persona: String((s && s.persona) || ''),
    goal: String((s && s.goal) || ''),
  }));
  const bad = norm.find((s) => !s.goal);
  if (bad) return toolText({ ok: false, error: '每一步都必须有 goal（交给智能体的指令）' }, true);
  const opts = {};
  if (args.note) opts.note = String(args.note);
  if (args['业务事项']) opts['业务事项'] = String(args['业务事项']);
  const r = pipeline.savePipeline(name, norm, opts);
  if (!r.ok) return toolText(r, true);
  if (args.use !== false) pipeline.use(name);
  process.stderr.write(`[relay-glue] PIPELINE save name=${name} v=${r.version} steps=${r.count} current=${pipeline.currentName()}\n`);
  return toolText({
    ok: true, name, version: r.version, count: r.count, unchanged: !!r.unchanged,
    current: pipeline.currentName(),
    steps: pipeline.currentSteps().map((s) => ({ id: s.id, persona: s.persona, role: s.role, goal: s.goal })),
    hint: '已保存为新版本。现在调 run_chain 即按此链执行；若要退回上一版，用 set_pipeline_version。',
  });
}
function setPipelineVersionTool(args) {
  const name = String((args && args.name) || '').trim();
  const v = Number(args && args.v);
  if (!Number.isFinite(v)) return toolText({ ok: false, error: 'v 必填（版本号）' }, true);
  const r = pipeline.setVersion(name || pipeline.currentName(), v);
  if (!r.ok) return toolText(r, true);
  process.stderr.write(`[relay-glue] PIPELINE rollback name=${r.name} → v${r.当前版本}\n`);
  return toolText({
    ok: true, name: r.name, 当前版本: r.当前版本,
    steps: pipeline.currentSteps().map((s) => ({ id: s.id, persona: s.persona, role: s.role, goal: s.goal })),
    hint: '已回滚到该版本；run_chain 将按它执行。',
  });
}
function usePipelineTool(args) {
  const name = String((args && args.name) || '').trim();
  if (!name) return toolText({ ok: false, error: 'name 必填（流水线名）' }, true);
  const r = pipeline.use(name);
  if (!r.ok) return toolText(r, true);
  process.stderr.write(`[relay-glue] PIPELINE use → ${name}\n`);
  return toolText({
    ok: true, current: pipeline.currentName(),
    steps: pipeline.currentSteps().map((s) => ({ id: s.id, persona: s.persona, role: s.role, goal: s.goal })),
    hint: '已设为当前执行链；run_chain 即按它执行。',
  });
}
/** 主控亲自执行某一步 → 把产物写回黑板（供 awaiting_main_agent 的步提交） */
function submitMainResultTool(args) {
  const taskId = String((args && args.task_id) || '').trim();
  const content = String((args && args.content) || '');
  if (!taskId) return toolText({ ok: false, error: 'task_id 必填' }, true);
  if (!content.trim()) return toolText({ ok: false, error: 'content 必填（本步产物）' }, true);
  const r = {
    ok: true, role: 'workbuddy', worker: 'workbuddy',
    summary: String((args && args.summary) || '').trim() || '主控（WorkBuddy）执行完成',
    resultText: content,
    finished_at: new Date().toISOString(),
    task_id: taskId,
  };
  const resultFile = writeResult(taskId, r);
  finishLog(taskId, 'workbuddy', { ...r, duration_ms: 0 }, resultFile);
  process.stderr.write(`[relay-glue] MAIN submit task=${taskId} (${content.length} 字)\n`);
  return toolText({ ok: true, task_id: taskId, result_file: resultFile, summary: r.summary, hint: '已提交。现在调 run_chain 续跑（会跳过本步、继续下一步）。' });
}

/** 传输层只需提供 send(obj) 把一条 JSON-RPC 消息发回客户端 */
async function handleMessage(msg, send) {
  const { id, method, params } = msg;
  const result = (payload) => send({ jsonrpc: '2.0', id, result: payload });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    PROTOCOL = (params && params.protocolVersion) || PROTOCOL;
    return result({
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: '把任务写进黑板 tasks/<id>/task.json，再调用 dispatch_task。',
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return result({});
  if (method === 'tools/list') return result({ tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === 'dispatch_task') return result(await dispatch(args));
    if (name === 'run_chain') return result(runChainTool(args));
    if (name === 'approve_task') return result(approveTool(args));
    if (name === 'list_pending') return result(pendingTool());
    if (name === 'get_repair_prompt') return result(repairTool());
    if (name === 'read_result') return result(readResultTool(args));
    if (name === 'read_runlog') return result(readRunlogTool(args));
    if (name === 'list_pipelines') return result(listPipelinesTool(args));
    if (name === 'save_pipeline') return result(savePipelineTool(args));
    if (name === 'set_pipeline_version') return result(setPipelineVersionTool(args));
    if (name === 'use_pipeline') return result(usePipelineTool(args));
    if (name === 'submit_main_result') return result(submitMainResultTool(args));
    return result(toolText({ error: 'unknown tool ' + name }, true));
  }
  if (id !== undefined) return fail(-32601, 'method not found: ' + method);
}

module.exports = { TOOLS, SERVER_INFO, handleMessage, dispatch, toolText, readResultTool, readRunlogTool, parseResultMd };
