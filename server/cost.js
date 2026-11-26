'use strict';
/**
 * cost.js —— 成本核算 + 预算闸门（零依赖）
 *   - estTokens：启发式估 token（中日韩每字≈1 token，其它每 4 字符≈1 token）
 *   - 每 worker 一条 ¥/1K token 价表（可用 RELAY_PRICE_JSON 覆盖）
 *   - 记账到 blackboard/runs/cost.json（按 project 累计 spent / 步骤明细 / 是否已降级）
 *   - over(project, 预估增量)：预算判断 → 超则 dispatch 改走“单 agent 回落”省协调开销
 *   预算：RELAY_COST_LIMIT（¥），缺省 5。演示时设很小即可触发降级。
 */
const fs = require('fs');
const path = require('path');
const { BB } = require('./adapters');

const FILE = path.join(BB, 'runs', 'cost.json');
const CUR = '¥';
const PRICES = JSON.parse(process.env.RELAY_PRICE_JSON || 'null') || {
  codebuddy: { in: 0.02, out: 0.06 },
  yuanbao: { in: 0.01, out: 0.03 },
  vscode: { in: 0.015, out: 0.05 },
  workbuddy: { in: 0.01, out: 0.04 },
  single: { in: 0.02, out: 0.06 },
};
const KEY = { code: 'codebuddy', research: 'yuanbao', editor: 'vscode', single: 'single' };

const DEFAULT_LIMIT = 5;
function fileLimit() { try { const o = JSON.parse(fs.readFileSync(FILE, 'utf8')); return o.limit; } catch (e) { return undefined; } }
const limit = () => parseFloat(process.env.RELAY_COST_LIMIT || fileLimit() || DEFAULT_LIMIT);
function workerKey(role) { return KEY[role] || 'codebuddy'; }

function estTokens(t) {
  t = String(t || '');
  let cjk = 0, other = 0;
  for (const c of t) { if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(c)) cjk++; else other++; }
  return Math.ceil(cjk + other / 4);
}
function costOf(role, tin, tout) {
  const p = PRICES[workerKey(role)] || PRICES.codebuddy;
  return +((tin / 1000) * p.in + (tout / 1000) * p.out).toFixed(6);
}

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return { currency: CUR, limit: limit(), projects: {} }; } }
function save(o) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); o.updated_at = new Date().toISOString(); fs.writeFileSync(FILE, JSON.stringify(o, null, 2), 'utf8'); }
function bucket(id) { const o = load(); o.projects[id] = o.projects[id] || { spent: 0, steps: [], degraded: false }; return { o, p: o.projects[id] }; }

function record(id, entry) {
  const { o, p } = bucket(id);
  p.spent = +(p.spent + entry.cost).toFixed(6);
  p.steps.push(entry);
  if (entry.degraded) p.degraded = true;
  o.limit = limit();
  save(o);
  return { spent: p.spent, limit: o.limit, degraded: p.degraded };
}
function spent(id) { return bucket(id).p.spent; }
function degraded(id) { return !!bucket(id).p.degraded; }
function over(id, projAdd) { const { o, p } = bucket(id); return (p.spent + (projAdd || 0)) > limit(); }

module.exports = { estTokens, costOf, record, spent, over, degraded, load, bucket, FILE, PRICES, workerKey, limit, CUR };
