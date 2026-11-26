'use strict';
/**
 * chain.js —— 接力编排器（主控雏形·健壮版）
 *   1) 按序跑多步，把上游 result.md 注入下游目标 —— 演示 Brief 命门「交接不丢上下文」
 *   2) 失败重试（--max-retry，默认 1 次重试 = 最多 2 试）
 *   3) 断点续跑：每步成功写 _state.json；再跑时跳过已 ok 步（--fresh 强制重跑）
 *   4) 可观测 / 可回放：每轮写 runs/<chain>.status.json（谁、几次、耗时、成功、产物路径）
 *   5) 失败注入：--halt-demo 追加一个 research(元宝) 步，占位返回 false → 演示 重试→停链→上报
 *
 * 不依赖框架、不依赖 WorkBuddy：用与 server 同一份 core.dispatch 走总线。
 * 用法：
 *   node server/chain.js                 # 两步接力（outline→draft）
 *   node server/chain.js                 # 再跑一次 → 跳过已 ok 步（断点续跑）
 *   node server/chain.js --fresh         # 忽略 state，全部重跑
 *   node server/chain.js --halt-demo     # 追加元宝步，演示 重试→停链
 */
const fs = require('fs');
const path = require('path');
const { dispatch } = require('./core');
const { BB } = require('./adapters');
const repair = require('./repair');
const pipeline = require('./pipeline');
const handoff = require('./handoff');

const argv = process.argv.slice(2);
// 演示降级开关：blackboard/DRY_RUN.flag 存在时，code/single 腿走合成输出（无需 CLI 登录态）。
// 删除该 flag 即恢复真实 CodeBuddy CLI 调用。
try { if (fs.existsSync(path.join(BB, 'DRY_RUN.flag'))) process.env.RELAY_DRY_RUN = '1'; } catch (e) {}
const FRESH = argv.includes('--fresh');
const HALT_DEMO = argv.includes('--halt-demo');
const MAX_RETRY = (() => {
  const m = argv.find((a) => a.startsWith('--max-retry='));
  return m ? parseInt(m.split('=')[1], 10) : 1;
})();
const CHAIN_NAME = 'chain-demo';

const BASE_STEPS = [
  { id: 'chain-01-outline', role: 'code', persona: 'dagang', goal: '读取 blackboard/tasks/example-001/input.md，产出初稿大纲（小标题 + 每节要点）。' },
  { id: 'chain-02-draft', role: 'code', persona: 'zhuangao', goal: '基于上一步大纲，扩写成 300 字成稿。大纲见：' },
];
// 真实内容流五步：调研→大纲→成稿→审稿→排版（操作型腿 research/editor 默认需人工确认）
const FULL_STEPS = [
  { id: 'chain-00-research', role: 'research', persona: 'yanjiu', goal: '调研主题「多 agent 内容接力」，输出要点 + 每条结论的引用来源。' },
  { id: 'chain-01-outline', role: 'code', persona: 'dagang', goal: '基于调研要点产出初稿大纲（小标题 + 每节要点）。见：' },
  { id: 'chain-02-draft', role: 'code', persona: 'zhuangao', goal: '基于大纲扩写成 300 字成稿。大纲见：' },
  { id: 'chain-02b-review', role: 'code', persona: 'shengao', goal: '对照调研要点与大纲审校成稿，列出问题点+定位+建议，疑似编造引用标红退回。成稿见：' },
  { id: 'chain-03-layout', role: 'editor', persona: 'paiban', goal: '对成稿做排版（标题层级/列表/加粗），保持语气术语一致。成稿见：' },
];
const FULL = argv.includes('--full');
const HALT_DEMO2 = false;
const BASE0 = FULL ? FULL_STEPS : BASE_STEPS;
// 流水线优先：存在 pipeline.json 且非空 → 按编排执行（persona 决定身份卡与 role）；否则回退内置步骤。
const PIPE = pipeline.currentSteps();
const PIPE_MODE = PIPE.length > 0;
const STEPS = PIPE_MODE ? PIPE : (HALT_DEMO ? [...BASE0, { id: 'chain-99-halt', role: 'research', goal: '失败注入演示步。见：' }] : BASE0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function taskDir(id) {
  return path.join(BB, 'tasks', String(id).replace(/[^a-zA-Z0-9_.-]/g, '_'));
}
function writeTask(id, role, goal, inputs, persona) {
  const dir = taskDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ task_id: id, role, persona: persona || null, goal, inputs, expected_output: 'md', constraints: '只读本任务目录；数据不出本机' }, null, 2), 'utf8');
}
function readResult(id) {
  const f = path.join(taskDir(id), 'result.md');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
function readState(id) {
  try { return JSON.parse(fs.readFileSync(path.join(taskDir(id), '_state.json'), 'utf8')); } catch (e) { return null; }
}
/** 断点续跑跳过的步：从 run-log 回填上次的真实耗时/成本/ token，避免链表显示 0 */
function lastLogged(id) {
  try {
    const lines = fs.readFileSync(path.join(BB, 'runs', 'run-log.jsonl'), 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const e = JSON.parse(lines[i]); if (e.task_id === id) return e; } catch (e) {}
    }
  } catch (e) {}
  return null;
}
function writeState(id, s) {
  fs.mkdirSync(taskDir(id), { recursive: true });
  fs.writeFileSync(path.join(taskDir(id), '_state.json'), JSON.stringify(s), 'utf8');
}
function parseToolText(payload) {
  try { return JSON.parse(payload.content[0].text); } catch (e) { return { ok: false, note: 'unparseable' }; }
}
// 交接完整性校验：下游 task.json 必须真含上游交接指纹，否则判“传话游戏断点”
function containsUpstream(stepId, up) {
  if (!up || !up.fingerprint) return true;
  const dj = fs.readFileSync(path.join(taskDir(stepId), 'task.json'), 'utf8');
  return dj.includes(up.fingerprint);
}

async function runStep(step, prevHandoff, idx) {
  const inputs = idx === 0 ? ['blackboard/tasks/example-001/input.md'] : [`blackboard/tasks/${STEPS[idx - 1].id}/result.md`];
  const upFp = prevHandoff ? prevHandoff.fingerprint : null;
  const state = readState(step.id);
  if (!FRESH && state && state.ok) {
    // 依赖失效判定：上游交接指纹与本步当初继承的不一致 → 上游产物已变，本步必须重跑
    const stale = idx > 0 && state.up_fingerprint !== upFp;
    if (!stale) {
      console.log(`步骤 ${idx + 1} [${step.role}] ${step.id} → ♻️ 已 ok，跳过（断点续跑）`);
      const prev = lastLogged(step.id) || {};
      return { ok: true, skipped: true, worker: step.role, duration_ms: prev.duration_ms || 0, prev_cost: prev.cost != null ? prev.cost : null, prev_tokens: prev.tokens || 0 };
    }
    console.log(`步骤 ${idx + 1} [${step.role}] ${step.id} → ♻️ 上游已变化（指纹不符），本步需重跑`);
  }
  // 上游交接：压缩成结构化交接块（摘要 + 内容上限 + 指纹），避免整段原文膨胀 prompt
  const goal = idx === 0 ? step.goal : `${step.goal}\n\n---\n${prevHandoff.block}`;
  writeTask(step.id, step.role, goal, inputs, step.persona);
  let attempt = 0, r;
  do {
    attempt++;
    r = parseToolText(await dispatch({ task_id: step.id, role: step.role }));
    if (r.ok || r.held || r.blocked) break;
    if (attempt <= MAX_RETRY) console.log(`   ↻ 第 ${attempt} 次失败，重试（剩 ${MAX_RETRY - attempt + 1}）…`);
  } while (attempt <= MAX_RETRY);
  writeState(step.id, { ok: r.ok, attempts: attempt, at: new Date().toISOString(), up_fingerprint: upFp });
  const tag = r.blocked ? '⛔已拦截' : r.held ? '⏳待确认' : r.ok ? 'ok=true' : 'ok=false';
  console.log(`步骤 ${idx + 1} [${step.role}] ${step.id} → ${tag} worker=${r.worker} 试=${attempt} 耗时=${r.duration_ms || 0}ms`);
  return { ...r, attempts: attempt };
}

async function main() {
  const modeLabel = PIPE_MODE ? `流水线「${pipeline.currentName()}」${STEPS.length} 步` : (HALT_DEMO ? '含失败注入' : '内置接力');
  console.log(`\n== 接力编排（主控雏形）| ${modeLabel} | 重试上限=${MAX_RETRY} | ${FRESH ? '--fresh 全重跑' : '断点续跑'} ==\n`);
  const status = { chain: CHAIN_NAME, started_at: new Date().toISOString(), mode: { fresh: FRESH, halt_demo: HALT_DEMO, max_retry: MAX_RETRY }, pipeline: { mode: PIPE_MODE ? 'pipeline' : 'builtin', name: PIPE_MODE ? pipeline.currentName() : '(内置默认链)', version: PIPE_MODE ? (pipeline.meta(pipeline.currentName()) || {}).当前版本 : null, steps: STEPS.length }, steps: [], result: 'running' };
  let prevHandoff = null;
  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    const r = await runStep(step, prevHandoff, i);
    status.steps.push({ id: step.id, role: step.role, ok: r.ok, held: !!r.held, blocked: !!r.blocked, safety: r.safety || null, attempts: r.attempts || 1, skipped: !!r.skipped, duration_ms: r.duration_ms || 0, tokens_source: (r.cost && r.cost.tokens_source) || (r.skipped ? 'prev' : null), tokens_in: (r.cost && r.cost.tokens_in) || (r.skipped ? r.prev_tokens || 0 : 0), step_cost: (r.cost && r.cost.cost) != null ? r.cost.cost : (r.skipped ? r.prev_cost : null), result_file: r.result_file || path.join(taskDir(step.id), 'result.md') });
    if (r.blocked) { status.result = 'blocked@safety'; break; }
    if (r.awaiting_main) {
      // 这一步由主控（WorkBuddy）亲自执行：链停下，把指令交给主控，等它 submit_main_result 后再续跑
      status.result = 'awaiting_main_agent';
      status.main_tasks = (status.main_tasks || []).concat([{ id: step.id, task_id: step.id, role: step.role, persona: step.persona || '', instruction: r.instruction || '', note: r.note || '' }]);
      console.log(`   ⏳ 待主控执行：${step.id}（${step.role}）—— ${String(r.instruction || '').slice(0, 60)}`);
      break;
    }
    if (r.held) { status.result = 'awaiting_confirmation'; break; }
    if (!r.ok) { status.result = 'halted@worker_fail'; break; }
    if (i > 0) {
      // 校验用的必须是「注入本步的那份上游交接」prevHandoff（不是本步自己的产物）
      const up = prevHandoff;
      const okHand = containsUpstream(step.id, up);
      status.steps[i].handed_off_from_upstream = okHand;
      status.steps[i].handoff = { fingerprint: up.fingerprint, chars: up.chars, truncated: up.truncated, upstream_total_chars: up.total_chars };
      console.log(`   ↪ 交接检查：${okHand ? '✅ 上游已带入本步' : '❌ 上下文丢失'}（指纹=${up.fingerprint} 交接 ${up.chars}/${up.total_chars} 字${up.truncated ? '，已截断' : ''}）`);
      if (!okHand) { status.result = 'halted@context_loss'; break; }
    }
    // 本步产物 → 压成交接块，供下一步注入
    prevHandoff = handoff.build(step.id, readResult(step.id), { sourcePath: path.join(taskDir(step.id), 'result.md') });
  }
  if (status.result === 'running') status.result = 'done';
  status.finished_at = new Date().toISOString();
  // ── 异常修复提示：非 done 时生成“贴回主控”的修复提示词 ──
  if (status.result !== 'done') {
    try { status.repair = repair.forStatus(status) || null; } catch (e) { status.repair = null; }
  } else {
    status.repair = null;
  }
  fs.mkdirSync(path.join(BB, 'runs'), { recursive: true });
  const statusFile = path.join(BB, 'runs', CHAIN_NAME + '.status.json');
  fs.writeFileSync(statusFile, JSON.stringify(status, null, 2), 'utf8');
  if (status.repair && status.repair.prompt) {
    fs.writeFileSync(path.join(BB, 'runs', CHAIN_NAME + '.repair.md'), status.repair.prompt, 'utf8');
  }

  const done = status.result === 'done';
  console.log(`\n${done ? '✅ 接力链完成（可观测/可回放）' : '⚠️ 链停在：' + status.result}`);
  console.log(`   状态文件：${statusFile}`);
  if (status.repair && status.repair.prompt) {
    console.log(`   修复提示词：${path.join(BB, 'runs', CHAIN_NAME + '.repair.md')}`);
    console.log('\n──────── 异常修复提示（贴回主控 WorkBuddy）────────\n' + status.repair.prompt + '\n────────────────────────────────────────');
  }
  console.log(`   重跑：删各步 _state.json 或加 --fresh 即从头真跑`);
}

main().catch((e) => { console.error('chain 失败:', e); process.exit(1); });
