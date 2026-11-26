'use strict';
/**
 * pipeline.js —— 流水线编排数据层（零依赖）· 业务事项 + 版本管理
 *   每条流水线 = 一个“业务事项”，带版本历史；每次保存追加一个版本，可回滚/查看历史。
 *   chain.js 与主控 run_chain 按“当前流水线 → 当前版本”的步骤执行。
 *   结构：
 *   { current:"内容生产",
 *     pipelines:{ "内容生产": { 业务事项:"长文/公众号内容生产", 当前版本:2,
 *                 版本:[ {v:1, at, note, steps:[{id,persona,goal}]}, {v:2, at, note, steps:[...]} ] } } }
 *   兼容旧格式：pipelines[name] 直接是 steps 数组时，自动视为 v1。
 */
const fs = require('fs');
const path = require('path');
const { BB } = require('./adapters');
const roles = require('./roles');

const FILE = path.join(BB, 'pipeline.json');
const DEFAULT = {
  current: '内容生产',
  pipelines: {
    '内容生产': {
      业务事项: '长文 / 公众号内容生产',
      当前版本: 1,
      版本: [{
        v: 1, at: '', note: '初始：调研→大纲→成稿→审稿→排版',
        steps: [
          { id: 'p-research', persona: 'yanjiu', goal: '调研主题「多 agent 内容接力」，输出要点 + 每条结论的引用来源。' },
          { id: 'p-outline', persona: 'dagang', goal: '基于调研要点产出初稿大纲（小标题 + 每节要点）。见：' },
          { id: 'p-draft', persona: 'zhuangao', goal: '基于大纲扩写成 300 字成稿。大纲见：' },
          { id: 'p-review', persona: 'shengao', goal: '对照调研要点与大纲审校成稿，列出问题点 + 定位 + 建议。成稿见：' },
          { id: 'p-layout', persona: 'paiban', goal: '对成稿做排版（标题层级/列表/加粗），保持语气术语一致。成稿见：' },
        ],
      }],
    },
  },
};

let cache = null, cacheM = 0;
function load() {
  try { const m = fs.statSync(FILE).mtimeMs; if (cache && m === cacheM) return cache; cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); cacheM = m; return normalizeAll(cache); }
  catch (e) { return JSON.parse(JSON.stringify(DEFAULT)); }
}
/** 兼容旧数组格式：把 pipelines[name] 规整成 {业务事项,当前版本,版本:[{v,at,note,steps}]} */
function normalizeOne(v) {
  if (Array.isArray(v)) return { 业务事项: '', 当前版本: 1, 版本: [{ v: 1, at: '', note: '（旧格式自动迁移）', steps: v }] };
  const o = v || {};
  const versions = Array.isArray(o.版本) && o.版本.length ? o.版本.map((x, i) => ({ v: x.v || i + 1, at: x.at || '', note: x.note || '', steps: x.steps || [] })) : [{ v: 1, at: '', note: '（空）', steps: [] }];
  const cur = o.当前版本 || versions[versions.length - 1].v;
  return { 业务事项: o.业务事项 || '', 当前版本: cur, 版本: versions };
}
function normalizeAll(p) { p.pipelines = p.pipelines || {}; Object.keys(p.pipelines).forEach((k) => { p.pipelines[k] = normalizeOne(p.pipelines[k]); }); return p; }
function save(p) { try { if (fs.existsSync(FILE)) { const ts = new Date().toISOString().replace(/[:.]/g, '-'); fs.copyFileSync(FILE, FILE + '.bak-' + ts); } } catch (e) {} fs.writeFileSync(FILE, JSON.stringify(p, null, 2), 'utf8'); cache = null; cacheM = 0; }

function names() { return Object.keys(load().pipelines || {}); }
function currentName() { const p = load(); return p.current || Object.keys(p.pipelines || {})[0] || ''; }
function meta(name) { const p = load(); return p.pipelines[name || currentName()] || null; }
function curVersionObj(m) { if (!m) return null; return m.版本.find((x) => x.v === m.当前版本) || m.版本[m.版本.length - 1] || null; }
function get(name) { const m = meta(name); const vo = curVersionObj(m); return vo ? vo.steps : []; }
function getStepsAt(name, v) { const m = meta(name); if (!m) return []; const vo = m.版本.find((x) => x.v === Number(v)); return vo ? vo.steps : []; }
function versionsOf(name) { const m = meta(name); return m ? m.版本.map((x) => ({ v: x.v, at: x.at, note: x.note, steps: x.steps.length })) : []; }

/** 当前流水线当前版本的可执行步骤（persona→role 解析）；无文件返回 [] 让 chain 回退内置 */
function currentSteps() {
  if (!fs.existsSync(FILE)) return [];
  return get(currentName()).map((s, i) => ({ id: s.id || ('p-' + i), persona: s.persona, role: (roles.find(s.persona) || {}).role || 'code', goal: s.goal || '' }));
}

function use(name) { const p = load(); if (!p.pipelines[name]) return { ok: false, error: '无此流水线' }; p.current = name; save(p); return { ok: true, current: name }; }

/** 保存 = 追加一个新版本（steps 与当前版本相同且无 note 时不产生新版本） */
function savePipeline(name, steps, opts = {}) {
  if (!name) return { ok: false, error: '流水线名必填' };
  if (!Array.isArray(steps)) return { ok: false, error: 'steps 需为数组' };
  const p = load(); p.pipelines = p.pipelines || {};
  let m = p.pipelines[name]; if (!m) { m = { 业务事项: opts.业务事项 || '', 当前版本: 0, 版本: [] }; p.pipelines[name] = m; }
  if (opts.业务事项 !== undefined && opts.业务事项 !== '') m.业务事项 = opts.业务事项;
  const norm = steps.map((s, i) => ({ id: s.id || ('p-' + i), persona: s.persona || '', goal: s.goal || '' }));
  const cur = curVersionObj(m);
  if (cur && JSON.stringify(cur.steps) === JSON.stringify(norm) && !opts.note) {
    if (!p.current) p.current = name; save(p); return { ok: true, name, version: m.当前版本, unchanged: true, count: norm.length };
  }
  const nv = (m.版本.reduce((a, x) => Math.max(a, x.v), 0)) + 1;
  m.版本.push({ v: nv, at: new Date().toISOString(), note: opts.note || ('v' + nv), steps: norm });
  m.当前版本 = nv; if (!p.current) p.current = name;
  save(p); return { ok: true, name, version: nv, count: norm.length };
}

/** 回滚/切换当前版本 */
function setVersion(name, v) {
  const p = load(); const m = p.pipelines[name || currentName()]; if (!m) return { ok: false, error: '无此流水线' };
  v = Number(v); if (!m.版本.find((x) => x.v === v)) return { ok: false, error: '无此版本' };
  m.当前版本 = v; save(p); return { ok: true, name: name || currentName(), 当前版本: v };
}
function removeVersion(name, v) {
  const p = load(); const m = p.pipelines[name || currentName()]; if (!m) return { ok: false, error: '无此流水线' };
  v = Number(v); if (m.版本.length <= 1) return { ok: false, error: '至少保留一个版本' };
  m.版本 = m.版本.filter((x) => x.v !== v);
  if (m.当前版本 === v) m.当前版本 = m.版本[m.版本.length - 1].v;
  save(p); return { ok: true };
}
function removePipeline(name) { const p = load(); delete (p.pipelines || {})[name]; if (p.current === name) p.current = Object.keys(p.pipelines || {})[0] || ''; save(p); return { ok: true }; }

module.exports = { FILE, load, save, names, currentName, meta, get, getStepsAt, versionsOf, currentSteps, use, savePipeline, setVersion, removeVersion, removePipeline, DEFAULT };
