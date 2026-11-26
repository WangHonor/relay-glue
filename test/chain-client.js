'use strict';
/**
 * test/chain-client.js —— 扮演主控（等价 WorkBuddy 经 MCP 做的事）：
 *   连 stdio MCP server → run_chain（全真四步）→ 遇 pending 调 approve_task → 再 run_chain → done。
 *   证明「编排 + 安全确认」都能经 MCP 工具由主控驱动。
 * 用法（先备好真环境）：
 *   $env:RELAY_YUANBAO_ENABLED="1"; $env:RELAY_VSCODE_OPEN="1"; $env:RELAY_CODEB_BIN="...codebuddy.cmd"
 *   node test/chain-client.js
 */
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server', 'mcp-adapter.js');
const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });

let nextId = 1;
const pending = new Map();
function send(o) { child.stdin.write(JSON.stringify(o) + '\n'); }
function request(method, params) {
  const id = nextId++;
  const p = new Promise((res) => pending.set(id, res));
  send({ jsonrpc: '2.0', id, method, params });
  return p;
}
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const toolText = (r) => { try { return JSON.parse(r.result.content[0].text); } catch (e) { return r.result || r; } };
const callTool = async (name, args) => toolText(await request('tools/call', { name, arguments: args || {} }));

(async () => {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'master-client', version: '1' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tl = await request('tools/list', {});
  console.log('主控可见工具 =', tl.result.tools.map((t) => t.name).join(', '));

  console.log('\n== 主控经 MCP 驱动全真四步链 ==\n');
  let res = await callTool('run_chain', { fresh: true });
  let g = 0;
  console.log(`run_chain → ${res.result}  pending=[${(res.pending || []).map(p => p.task_id).join(',')}]`);
  while (res.result === 'awaiting_confirmation' && g++ < 6) {
    for (const p of res.pending || []) {
      const a = await callTool('approve_task', { task_id: p.task_id });
      console.log(`  主控批准 → ${p.task_id}（原因：${p.reason}）= ok=${a.ok}`);
    }
    res = await callTool('run_chain', {});
    console.log(`run_chain → ${res.result}  pending=[${(res.pending || []).map(x => x.task_id).join(',')}]`);
  }
  console.log('\n步骤轨迹 =', (res.steps || []).map((s) => s.role + (s.ok ? '✅' : s.held ? '⏳' : '❌')).join(' → '));
  console.log('最终 =', res.result, res.result === 'done' ? '✅ 端到端 MCP 主控驱动全真链跑通' : '⚠ 未完成');
  child.stdin.end(); child.kill(); process.exit(0);
})().catch((e) => { console.error('失败:', e); child.kill(); process.exit(1); });

setTimeout(() => { console.error('⛔ 超时 240s'); child.kill(); process.exit(2); }, 240000);
