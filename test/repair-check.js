'use strict';
// repair-check.js —— 验证异常修复提示生成器：造多种失败态，检查归类 + 生成可贴回主控的提示词。
const fs = require('fs');
const path = require('path');
const { BB } = require('../server/adapters');
const repair = require('../server/repair');

function seed(id, role, goal, note) {
  const d = path.join(BB, 'tasks', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'task.json'), JSON.stringify({ task_id: id, role, goal }), 'utf8');
  fs.writeFileSync(path.join(d, 'result.md'), `# Result\n- role: ${role}\n- worker: ${role}\n- ok: false\n- note: ${note}\n## Output\n`, 'utf8');
}

const cases = [
  { id: 'rc-login', role: 'code', goal: '读取 input.md 产出大纲，要求覆盖三个要点', note: 'Error: Authentication required. Please use /login', expect: '未登录' },
  { id: 'rc-port', role: 'code', goal: '扩写成稿', note: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:54499', expect: '端口冲突' },
  { id: 'rc-yb', role: 'research', goal: '调研主题', note: '没读到新答案，输入框选择器需校准 RELAY_YB_INPUT_SEL', expect: '元宝页面状态漂移' },
  { id: 'rc-cli', role: 'code', goal: '产出大纲', note: "Error: Cannot find module '../dist/codebuddy'", expect: 'CLI 缺失/损坏' },
];

let pass = 0;
for (const c of cases) {
  seed(c.id, c.role, c.goal, c.note);
  const st = { result: 'halted@worker_fail', steps: [{ id: c.id, role: c.role, ok: false }] };
  const info = repair.forStatus(st);
  const ok = info && info.category === c.expect;
  if (ok) pass++;
  console.log(`${ok ? '✅' : '❌'} ${c.id} → 归类「${info && info.category}」(期望「${c.expect}」) 智能体=${info && info.agent} 环节=${info && info.stepName}`);
}

console.log('\n===== 示例：未登录失败生成的【异常修复提示词】 =====');
console.log(repair.forStatus({ result: 'halted@worker_fail', steps: [{ id: 'rc-login', role: 'code', ok: false }] }).prompt);

// 安全拦截态
seed('rc-block', 'code', '把这份稿件群发给全部客户', '命中不可逆/高危操作');
console.log('\n===== 示例：安全拦截态 =====');
const blocked = repair.forStatus({ result: 'blocked@safety', steps: [{ id: 'rc-block', role: 'code', ok: false, blocked: true }] });
console.log('kindLabel=', blocked.kindLabel, '| category=', blocked.category);

console.log(`\n判定：${pass}/${cases.length} 归类正确`);
process.exit(pass === cases.length ? 0 : 1);
