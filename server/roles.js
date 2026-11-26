'use strict';
/**
 * roles.js —— 智能体身份/角色卡（persona）层（零依赖）
 *   读 blackboard/roles.json 的角色卡；dispatch 时把对应身份卡注入 worker 提示词前缀，
 *   让每个智能体按“你是谁 / 职责 / 交付格式 / 协作关系 / 硬约束”行动并按契约交接。
 *   卡片字段：id（唯一）、身份、role（research/code/editor/single，对应总线角色）、agent（元宝/CodeBuddy/VSCode/WorkBuddy）、
 *            职责、交付、协作、约束。
 *   匹配：优先按 task.persona=卡片 id；否则按 role 找第一张同 role 卡。
 */
const fs = require('fs');
const path = require('path');
const { BB } = require('./adapters');

const FILE = path.join(BB, 'roles.json');
let cache = null, cacheM = 0;

function load() {
  try {
    const m = fs.statSync(FILE).mtimeMs;
    if (cache && m === cacheM) return cache;
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); cacheM = m; return cache;
  } catch (e) { return { roles: [] }; }
}
function find(key) {
  if (!key) return null;
  const rs = load().roles || [];
  return rs.find((r) => r.id === key) || rs.find((r) => r.role === key) || null;
}
/** 生成注入 worker 的身份前缀；无卡返回空串 */
function prefix(key) {
  const r = find(key);
  if (!r) return '';
  const L = [];
  if (r['身份']) L.push(`【你的身份】${r['身份']}`);
  if (r['agent']) L.push(`【你由哪个应用扮演】${r['agent']}`);
  if (r['职责']) L.push(`【工作角色/职责】${r['职责']}`);
  if (r['交付']) L.push(`【交付格式（必须遵守）】${r['交付']}`);
  if (r['协作']) L.push(`【协作关系】${r['协作']}`);
  if (r['约束']) L.push(`【硬性约束】${r['约束']}`);
  L.push('请严格按上述身份与职责完成下面的任务，并严格按“交付格式”输出，不要越界做别的角色的事。');
  return L.join('\n');
}
function list() { return (load().roles || []).map((r) => ({ id: r.id, 身份: r['身份'], role: r.role, agent: r.agent, 工作类型: r['工作类型'] || '' })); }

// ── 写操作（供指挥台“角色管理”入口调用）：每次保存前先备份 roles.json ──
function all() { return (load().roles || []).slice(); }
function backup() { try { if (fs.existsSync(FILE)) { const ts = new Date().toISOString().replace(/[:.]/g, '-'); fs.copyFileSync(FILE, FILE + '.bak-' + ts); } } catch (e) {} }
function saveList(roles) { backup(); const obj = { roles }; fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8'); cache = null; cacheM = 0; return obj; }
function upsert(card) {
  if (!card || !String(card.id || '').trim()) return { ok: false, error: 'id 必填' };
  if (!/^[a-zA-Z0-9_-]+$/.test(String(card.id))) return { ok: false, error: 'id 只能含字母/数字/下划线/连字符' };
  const rs = all(); const i = rs.findIndex((r) => r.id === card.id);
  if (i >= 0) rs[i] = card; else rs.push(card);
  saveList(rs); return { ok: true, id: card.id, count: rs.length };
}
function remove(id) { const rs = all().filter((r) => r.id !== id); saveList(rs); return { ok: true, removed: id, count: rs.length }; }

module.exports = { FILE, load, find, prefix, list, all, upsert, remove, saveList };
