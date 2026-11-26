'use strict';
/**
 * test/dynamic-orchestration-check.js —— 补强① 端到端验证（零依赖 MCP 客户端）
 *
 * 验证主控（harness）能只靠 MCP 工具完成「动态编排」闭环：
 *   list_pipelines → save_pipeline(改链/新增版本) → use_pipeline(切当前) → run_chain(按新链跑)
 *   → set_pipeline_version(回滚) → use_pipeline(切回原链)
 *
 * 安全：不碰用户现有流水线；测试用独立流水线名 __selftest__，结束前删除并还原 current。
 * 用法：RELAY_DRY_RUN=1 node test/dynamic-orchestration-check.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server', 'mcp-adapter.js');
const PIPE_FILE = path.join(__dirname, '..', 'blackboard', 'pipeline.json');
const TEST_NAME = '__selftest__';
const STATUS_FILE = path.join(__dirname, '..', 'blackboard', 'runs', 'chain-demo.status.json');

const backup = fs.existsSync(PIPE_FILE) ? fs.readFileSync(PIPE_FILE, 'utf8') : null;
const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 1;
const pending = new Map();
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
function request(method, params) {
  const id = nextId++;
  const p = new Promise((res) => pending.set(id, res));
  send({ jsonrpc: '2.0', id, method, params });
  return p;
}
const watchdog = setTimeout(() => { console.error('⛔ 超时 120s'); child.kill(); process.exit(2); }, 120000);
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const callTool = async (name, args) => {
  const r = await request('tools/call', { name, arguments: args || {} });
  const txt = (r.result && r.result.content && r.result.content[0] && r.result.content[0].text) || '{}';
  try { return JSON.parse(txt); } catch (e) { return { raw: txt }; }
};
let pass = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); }
};

(async () => {
  console.log('\n== 补强① 动态编排闭环（MCP 往返）==\n');
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'relay-dyn-check', version: '0.1.0' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await request('tools/list', {});
  const names = (list.result.tools || []).map((t) => t.name);
  console.log('工具(' + names.length + '): ' + names.join(', ') + '\n');
  ['list_pipelines', 'save_pipeline', 'set_pipeline_version', 'use_pipeline'].forEach((n) => check(names.includes(n), '工具已暴露: ' + n));

  // 1) 读现状
  const before = await callTool('list_pipelines', {});
  const originName = before.current;
  const originVersion = (before.pipelines.find((p) => p.name === originName) || {}).当前版本;
  check(!!originName, 'list_pipelines 读到当前流水线', originName);
  console.log(`   当前流水线「${originName}」版本 v${originVersion}，共 ${before.pipelines.length} 条\n`);

  // 2) 主控新建一条链（不切当前）
  const save1 = await callTool('save_pipeline', {
    name: TEST_NAME,
    steps: [
      { id: 'st-a', persona: 'dagang', goal: '步骤A：列出三个要点。' },
      { id: 'st-b', persona: 'zhuangao', goal: '步骤B：基于上游要点写成一段成稿。见：' },
    ],
    note: '补强①自测：主控动态建链',
    业务事项: '自测',
    use: false,
  });
  check(save1.ok === true && save1.version === 1, 'save_pipeline 新建测试链 v1', JSON.stringify(save1).slice(0, 120));

  // 3) 改链 → 追加 v2
  const save2 = await callTool('save_pipeline', {
    name: TEST_NAME,
    steps: [
      { id: 'st-a', persona: 'dagang', goal: '步骤A：列出三个要点。' },
      { id: 'st-b', persona: 'zhuangao', goal: '步骤B：基于上游要点写成一段成稿。见：' },
      { id: 'st-c', persona: 'shengao', goal: '步骤C：审校上文并指出问题点。见：' },
    ],
    note: '补强①自测：主控加一步审稿',
    use: false,
  });
  check(save2.ok === true && save2.version === 2, 'save_pipeline 追加 v2（3 步）', 'version=' + save2.version);

  // 4) 切当前
  const use = await callTool('use_pipeline', { name: TEST_NAME });
  check(use.ok === true && use.current === TEST_NAME, 'use_pipeline 切到测试链', 'current=' + use.current);
  check((use.steps || []).length === 3, '切当前后执行步骤 = 3 步', 'steps=' + (use.steps || []).length);

  // 5) 按新链跑（DRY）
  const run = await callTool('run_chain', { fresh: true });
  check(run.result === 'done', 'run_chain 按新链跑到 done', 'result=' + run.result + ' steps=' + JSON.stringify(run.steps));
  const st = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  const ids = (st.steps || []).map((s) => s.id);
  check(ids.join(',') === 'st-a,st-b,st-c', '执行的正是新链的三个步骤', ids.join(','));
  const handoffs = (st.steps || []).filter((s) => s.handoff);
  check(handoffs.length === 2 && handoffs.every((h) => h.handed_off_from_upstream === true), '③ 交接指纹校验全部通过', JSON.stringify(handoffs.map((h) => ({ id: h.id, ok: h.handed_off_from_upstream, chars: h.handoff.chars, total: h.handoff.upstream_total_chars, trunc: h.handoff.truncated }))));
  check(handoffs.every((h) => h.handoff && h.handoff.fingerprint), '③ 每步交接都带指纹');

  // 6) 回滚到 v1 → 应变 2 步
  const rb = await callTool('set_pipeline_version', { name: TEST_NAME, v: 1 });
  check(rb.ok === true && rb.当前版本 === 1, 'set_pipeline_version 回滚到 v1', JSON.stringify(rb).slice(0, 100));
  check((rb.steps || []).length === 2, '回滚后步骤回到 2 步', 'steps=' + (rb.steps || []).length);

  // 7) 切回原链 + 清理
  const back = await callTool('use_pipeline', { name: originName });
  check(back.ok === true && back.current === originName, 'use_pipeline 切回原流水线', 'current=' + back.current);

  console.log(`\n结果：✅ ${pass} 通过 / ❌ ${fail} 失败\n`);
  clearTimeout(watchdog);
  child.stdin.end(); child.kill();
  // 还原：删除测试流水线并把 pipeline.json 还原到测试前
  try {
    const pipeline = require('../server/pipeline');
    pipeline.removePipeline(TEST_NAME);
    if (backup != null) fs.writeFileSync(PIPE_FILE, backup, 'utf8');
  } catch (e) { console.error('还原失败:', e.message); }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('验证异常:', e);
  try {
    const pipeline = require('../server/pipeline');
    pipeline.removePipeline(TEST_NAME);
    if (backup != null) fs.writeFileSync(PIPE_FILE, backup, 'utf8');
  } catch (e2) {}
  clearTimeout(watchdog); child.kill(); process.exit(1);
});
