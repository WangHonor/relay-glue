'use strict';
/**
 * repair.js —— 链路异常修复提示生成器（零依赖）
 *   当某条腿失败/被拦截/上下文丢失时，按“失败分诊表”判定根因，
 *   生成一段可直接贴回主控（WorkBuddy）的中文【异常修复提示词】，
 *   提示人工：是哪一步、哪个智能体、为什么、该怎么修、修好后怎么续跑。
 *
 *   入口：forStatus(statusObj) → { stepId, stepName, agent, category, cause, humanActions[], currentGoal, prompt }
 */
const fs = require('fs');
const path = require('path');
const { BB } = require('./adapters');

const AGENT_ZH = { research: '元宝', code: 'CodeBuddy', editor: 'VSCode', single: '单Agent', workbuddy: 'WorkBuddy' };
const agentOf = (role) => AGENT_ZH[role] || role || '未知';
const stepNameOf = (id) => { const s = String(id || ''); if (/research/i.test(s)) return '调研'; if (/outline/i.test(s)) return '大纲'; if (/draft/i.test(s)) return '成稿'; if (/layout/i.test(s)) return '排版'; if (/halt/i.test(s)) return '失败注入步'; return '步骤'; };

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }
function taskDir(id) { return path.join(BB, 'tasks', String(id).replace(/[^a-zA-Z0-9_.-]/g, '_')); }

// 失败分诊表：按 note/summary 关键词判根因 + 给建议动作
const RULES = [
  { test: /命中不可逆|高危|群发|清空|删除全部|转账|发布|拦截|blocked|safety/i, category: '安全闸门拦截', cause: '该步目标命中不可逆/高危动作，被安全闸门拦下（不会自动执行）', actions: ['人工确认该动作是否真的要执行；确需执行→在指挥台点“批准执行”或调 approve_task 后 run_chain 续跑', '若是误触发（如正文里恰好含“发布/删除”等词），把该步 goal 改写得更精确、去掉歧义高危词，再 run_chain fresh=true 重跑'] },
  { test: /EADDRINUSE|address already in use|端口/i, category: '端口冲突', cause: 'worker 本地端口与主控/其它会话相撞', actions: ['一般已由适配器自动换空闲 --port 重试解决；若仍失败，贴出本提示词让我重试该步（run_chain fresh=true）', '确认没有多个 codebuddy 交互会话残留占用端口'] },
  { test: /Authentication required|需登录|\/login|未登录/i, category: '未登录', cause: 'CodeBuddy CLI 未完成一次性登录', actions: ['在普通终端运行 codebuddy（用 .cmd 壳，别用 .ps1），进入后输入 /login 扫码登录', '登录成功后贴回本提示词，我重跑该步'] },
  { test: /Cannot find module|ENOENT|not recognized|不是内部|command not found|不在 PATH|内置.*崩|找不到|无法识别|系统找|ϵͳ|找不到指定的/i, category: 'CLI 缺失/损坏', cause: 'worker 命令找不到或所指向的 CLI 损坏（含中文/乱码的“找不到路径/命令”报错）', actions: ['确认 RELAY_CODEB_BIN 指向可用的 npm 版 codebuddy.cmd（C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codebuddy.cmd）', '必要时 npm install -g @tencent-ai/codebuddy-code 重装；或检查 Edge/CLI 登录态'] },
  { test: /timeout|超时|wait/i, category: '执行超时', cause: 'worker 在等待窗口内未返回', actions: ['调大对应超时（RELAY_CODEB_TIMEOUT / RELAY_YB_WAIT）后重跑该步', '把该步目标改得更具体、更短，减少 worker 负担'] },
  { test: /选择器|校准|没读到新答案|RELAY_YB_|clarify|澄清|追问/i, category: '元宝页面状态漂移', cause: '元宝网页 UI 变化或停在“追问/澄清”子态，输入框/答案节点定位失败', actions: ['运行 node server/yuanbao-probe.js 重新校准 RELAY_YB_INPUT_SEL / RELAY_YB_ANSWER_SEL', '确认 Edge(9333) 里元宝已登录且停在正常聊天页（新版已能自动重置澄清态）'] },
  { test: /输出为空|空/ , category: '空输出', cause: '模型返回空（可能额度/异常）', actions: ['重试一次该步', '检查该 worker 账号额度/状态'] },
];

function diagnose(role, text) {
  const t = String(text || '');
  for (const r of RULES) if (r.test.test(t)) return { category: r.category, cause: r.cause, actions: r.actions };
  return { category: '未分类失败', cause: 'worker 返回 ok=false（未能自动归类）', actions: ['查看该步 result.md 的 note 原文定位', '把该步目标改具体后 run_chain fresh=true 重跑'] };
}

// 从 status 找出失败/卡住的那一步
function failingStep(status) {
  const steps = (status && status.steps) || [];
  if (!steps.length) return null;
  if (status.result === 'halted@context_loss') {
    const s = steps.find((x) => x.handed_off_from_upstream === false);
    if (s) return { step: s, kind: 'context_loss' };
  }
  if (status.result === 'blocked@safety') return { step: steps[steps.length - 1], kind: 'blocked' };
  if (status.result === 'awaiting_confirmation') return { step: steps[steps.length - 1], kind: 'awaiting' };
  // worker_fail：最后一步（ok=false）
  return { step: steps[steps.length - 1], kind: 'worker_fail' };
}

function buildPrompt(info) {
  const idx = info.index ? `第 ${info.index} 步` : '某步';
  const lines = [];
  lines.push('【链路异常 · 需人工修复提示词】');
  lines.push(`失败步骤：${idx}「${info.stepName}」· 智能体 ${info.agent}（task_id=${info.stepId}）`);
  lines.push(`异常类型：${info.kindLabel}`);
  lines.push(`根因判定：${info.category} —— ${info.cause}`);
  if (info.noteExcerpt) lines.push(`失败原文摘录：${info.noteExcerpt}`);
  lines.push('');
  lines.push('建议动作（按顺序试）：');
  info.actions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  lines.push('');
  lines.push('修好后，把下面这句原样贴回主控 WorkBuddy 续跑：');
  lines.push(`「调用 relay-glue 的 run_chain（fresh=false）续跑；若仍停在 ${info.stepId}，先按上面建议修复，再 run_chain（fresh=true）重跑该步，直到 done。」`);
  lines.push('');
  if (info.currentGoal) {
    lines.push('如需改写该步提示词（目标太宽/不清导致失败），可把该步 task.json 的 goal 换成更具体的版本，例如：');
    lines.push(`「${String(info.currentGoal).replace(/\n+/g, ' ').slice(0, 160)}…」← 在这基础上把要求写具体`);
    lines.push('');
  }
  lines.push('（可选项）人工也可直接编辑该步 goal 后调用 MCP 工具 get_repair_prompt 复核，或 dispatch_task{task_id:' + info.stepId + '} 单步重跑。');
  return lines.join('\n');
}

function forStatus(status) {
  const f = failingStep(status);
  if (!f || !f.step) return null;
  const step = f.step;
  const kindLabel = f.kind === 'context_loss' ? '上下文交接丢失' : f.kind === 'blocked' ? '安全闸门拦截（不可逆/高危词）' : f.kind === 'awaiting' ? '操作型腿待人工确认' : 'worker 执行失败';
  const resultMd = safeRead(path.join(taskDir(step.id), 'result.md'));
  const taskJson = (() => { try { return JSON.parse(safeRead(path.join(taskDir(step.id), 'task.json'))); } catch (e) { return {}; } })();
  const noteMatch = resultMd.match(/-\s*note:\s*([\s\S]+?)(?:\n##|\n$|$)/);
  const noteExcerpt = (noteMatch ? noteMatch[1] : (resultMd.match(/Error:[^\n]+/) || [''])[0]).replace(/\s+/g, ' ').trim().slice(0, 200);
  const dg = diagnose(step.role, (noteExcerpt || '') + ' ' + (taskJson.goal || '') + ' ' + kindLabel);
  const idx = ((status.steps || []).findIndex((s) => s.id === step.id)) + 1;
  const info = {
    stepId: step.id, stepName: stepNameOf(step.id), agent: agentOf(step.role),
    kind: f.kind, kindLabel, index: idx,
    category: dg.category, cause: dg.cause, actions: dg.actions,
    noteExcerpt, currentGoal: taskJson.goal || '',
  };
  info.prompt = buildPrompt(info);
  return info;
}

module.exports = { forStatus, diagnose, agentOf, stepNameOf };
