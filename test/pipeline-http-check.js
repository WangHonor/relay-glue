'use strict';
// pipeline-http-check.js —— 端到端验证“流水线编排入口”：经 HTTP 建/切自定义流水线 → chain.js 按它执行 → 恢复。
const { spawnSync } = require('child_process');
const H = 'http://127.0.0.1:8770';
const post = (p, b) => fetch(H + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const getp = (p) => fetch(H + p).then((r) => r.json());

(async () => {
  const sv = await post('/api/pipeline/save', { name: '办公周报', steps: [
    { id: 'w1', persona: 'dagang', goal: '把本周要点整理成周报骨架（进展/风险/下周）。' },
    { id: 'w2', persona: 'zhuangao', goal: '基于骨架扩写成简洁周报正文。见：' },
  ] });
  console.log('save:', JSON.stringify(sv));
  const us = await post('/api/pipeline/use', { name: '办公周报' });
  console.log('use:', JSON.stringify(us));
  const pl = await getp('/api/pipeline');
  console.log('names:', pl.names.join(','), '| current:', pl.current, '| steps:', pl.steps.length);

  // 用当前(办公周报)流水线 DRY 跑 chain，断言只跑 2 步且 persona 正确
  const env = Object.assign({}, process.env, { RELAY_DRY_RUN: '1', RELAY_DEMO_SYNTHETIC: '1', RELAY_SAFETY_DISABLED: '1' });
  const r = spawnSync('C:\\Program Files\\nodejs\\node.exe', ['server/chain.js', '--fresh'], { env, encoding: 'utf8', cwd: process.cwd() });
  const personaLines = (r.stderr || '').split('\n').filter((l) => /PERSONA/.test(l));
  console.log('chain 跑了', personaLines.length, '步:');
  personaLines.forEach((l) => console.log('  ' + l.trim()));
  const okSteps = personaLines.length === 2 && /card=dagang/.test(personaLines[0]) && /card=zhuangao/.test(personaLines[1]);
  console.log(okSteps ? '✅ 自定义流水线驱动 chain 正确（2 步 dagang→zhuangao）' : '❌ 不符预期');

  // 恢复默认
  await post('/api/pipeline/use', { name: '内容生产' });
  await post('/api/pipeline/delete', { name: '办公周报' });
  const g2 = await getp('/api/pipeline');
  console.log('恢复后 names:', g2.names.join(','), '| current:', g2.current);
  process.exit(okSteps ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
