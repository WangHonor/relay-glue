'use strict';
/**
 * test/full-flow-check.js —— 离线验证 #3：真实内容流四步（调研→大纲→成稿→排版），
 * 演示「人工确认」与「成本」真正串进链路（合成模式，不需元宝/VSCode 真环境）。
 * 阶段1：不预批 → 链应停在 调研 步 awaiting_confirmation（操作型腿需确认，闸门生效）。
 * 阶段2：批准所有 pending → 续跑 → done，每步上下文交接 ✅，成本累计。
 * 用法： RELAY_DRY_RUN=1 RELAY_DEMO_SYNTHETIC=1 node test/full-flow-check.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { BB } = require('../server/adapters');
const safety = require('../server/safety');
const cost = require('../server/cost');

const STATUS = path.join(BB, 'runs', 'chain-demo.status.json');
const clearStates = () => {
  const td = path.join(BB, 'tasks');
  if (!fs.existsSync(td)) return;
  for (const id of fs.readdirSync(td)) {
    for (const f of ['_state.json', 'confirm.json']) { try { fs.rmSync(path.join(td, id, f)); } catch (e) {} }
  }
};
const readStatus = () => JSON.parse(fs.readFileSync(STATUS, 'utf8'));
const runChain = (fresh) => {
  const args = [path.join(__dirname, '..', 'server', 'chain.js'), '--full'];
  if (fresh) args.push('--fresh');
  const r = spawnSync(process.execPath, args, { env: process.env, encoding: 'utf8' });
  return r.stdout + r.stderr;
};

(async () => {
  if (process.env.RELAY_DEMO_SYNTHETIC !== '1' || process.env.RELAY_DRY_RUN !== '1') {
    console.log('⚠ 需设 RELAY_DRY_RUN=1 RELAY_DEMO_SYNTHETIC=1（离线合成验证）');
  }
  clearStates();
  try { fs.rmSync(cost.FILE); } catch (e) {}

  console.log('\n===== 阶段1：不预批准 → 应停在“调研”待确认 =====');
  runChain(true);
  const s1 = readStatus();
  console.log('链状态 =', s1.result);
  console.log('停在步骤 =', (s1.steps.find((x) => x.held) || {}).id, '| pending =', safety.listPending().map((p) => p.task_id).join(','));
  const okPhase1 = s1.result === 'awaiting_confirmation' && s1.steps.some((x) => x.held);
  console.log('闸门卡住真实链？', okPhase1 ? '✅ 是' : '❌ 否');

  console.log('\n===== 阶段2：批准 pending → 续跑（循环直到 done，每个操作型腿都会卡一次）=====');
  let guard = 0;
  while (readStatus().result === 'awaiting_confirmation' && guard++ < 6) {
    const pend = safety.listPending();
    if (!pend.length) break;
    for (const p of pend) { safety.setConfirmation(p.task_id, 'approved'); console.log('  已批准', p.task_id, '(' + p.decision.reason + ')'); }
    runChain(false);
  }
  const s2 = readStatus();
  console.log('链状态 =', s2.result);
  console.log('步骤序列 =', s2.steps.map((x) => x.role + (x.held ? '⏳' : x.ok ? '✅' : '❌')).join(' → '));
  const handoffs = s2.steps.filter((x) => x.handed_off_from_upstream !== undefined);
  console.log('上下文交接 =', handoffs.every((x) => x.handed_off_from_upstream) ? '✅ 全部通过' : '❌ 有丢失', `(${handoffs.length} 处)`);
  const cj = cost.load();
  console.log('成本 =', '¥' + (cj.projects.demo ? cj.projects.demo.spent.toFixed(4) : '?'), '· 预算 ¥' + cj.limit, '· 步数 =', cj.projects.demo ? cj.projects.demo.steps.length : 0);
  const okPhase2 = s2.result === 'done' && s2.steps.every((x) => x.ok) && handoffs.every((x) => x.handed_off_from_upstream);
  console.log('四步全绿 + 交接齐全？', okPhase2 ? '✅ 是' : '❌ 否');
})().catch((e) => { console.error(e); process.exit(1); });
