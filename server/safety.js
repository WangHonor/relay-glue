'use strict';
/**
 * safety.js —— 操作型腿的安全闸门：敏感词 / 不可逆操作 识别 + 人工确认
 *   level:
 *     block   → 命中不可逆/高危词（群发/删除全部/转账/发布…）→ 直接拦截，永不执行
 *     confirm → 命中敏感词，或 role 属操作型腿(research/editor GUI) → 置“待确认”，不执行，等人工批准
 *     auto    → 其余（如 code 腿的良性任务）→ 放行
 *   确认记录写在黑板：blackboard/tasks/<id>/confirm.json（status: pending|approved|rejected）
 *   开关：RELAY_SAFETY_DISABLED=1 关闭；RELAY_SENSITIVE_EXTRA / RELAY_IRREVERSIBLE_EXTRA 追加词（逗号分隔）
 */
const fs = require('fs');
const path = require('path');
const { BB } = require('./adapters');

const IRREVERSIBLE = ['群发', '发布', '上线', '删除全部', '全部删除', '清空', '转账', '付款', '支付', '汇款', 'rm -rf', 'drop table', 'delete all', 'mass send', 'publish'];
const SENSITIVE = ['删除', '修改密码', '授权', '发送', '提交', '对外', '客户', '合同', '报价', '隐私', '机密', '个人数据', '付款码', 'send to'];

function extra(envKey, base) {
  const v = process.env[envKey];
  return v ? base.concat(v.split(',').map((s) => s.trim()).filter(Boolean)) : base;
}

function classify({ goal = '', inputs = [] }) {
  const hay = (goal + ' ' + inputs.join(' ')).toLowerCase();
  const irr = extra('RELAY_IRREVERSIBLE_EXTRA', IRREVERSIBLE).filter((k) => hay.includes(k.toLowerCase()));
  if (irr.length) return { level: 'block', matched: irr, reason: '命中不可逆/高危操作' };
  const sens = extra('RELAY_SENSITIVE_EXTRA', SENSITIVE).filter((k) => hay.includes(k.toLowerCase()));
  if (sens.length) return { level: 'confirm', matched: sens, reason: '命中敏感词' };
  return { level: 'auto', matched: [], reason: '' };
}

/** 决策：role 为操作型腿且无更高危 → 至少 confirm */
function decide({ role, goal, inputs }) {
  const c = classify({ goal, inputs });
  if (c.level !== 'auto') return c;
  if (role === 'research' || role === 'editor') return { level: 'confirm', matched: [], reason: '操作型腿（GUI 自动化）默认需人工确认' };
  return c;
}

function confirmFile(taskId) {
  return path.join(BB, 'tasks', String(taskId).replace(/[^a-zA-Z0-9_.-]/g, '_'), 'confirm.json');
}
function readConfirmation(taskId) {
  try { return JSON.parse(fs.readFileSync(confirmFile(taskId), 'utf8')); } catch (e) { return null; }
}
function requestConfirmation(taskId, decision) {
  const f = confirmFile(taskId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ status: 'pending', decision, created_at: new Date().toISOString() }, null, 2), 'utf8');
  return true;
}
function setConfirmation(taskId, status, by = 'human') {
  const f = confirmFile(taskId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const prev = (() => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } })();
  const obj = { ...prev, status, decided_by: by, decided_at: new Date().toISOString() };
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
  return obj;
}

/** 汇总所有 pending 确认（指挥台“待确认”面板用） */
function listPending() {
  const d = path.join(BB, 'tasks');
  let ids = [];
  try { ids = fs.readdirSync(d); } catch (e) { return []; }
  const out = [];
  for (const id of ids) {
    const c = readConfirmation(id);
    if (c && c.status === 'pending') out.push({ task_id: id, decision: c.decision, created_at: c.created_at });
  }
  return out;
}

const DISABLED = () => process.env.RELAY_SAFETY_DISABLED === '1';

module.exports = { decide, classify, readConfirmation, requestConfirmation, setConfirmation, listPending, DISABLED, IRREVERSIBLE, SENSITIVE };
