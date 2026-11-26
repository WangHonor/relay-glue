'use strict';
/**
 * adapters.js — 角色路由 + 应用适配器 + 黑板存取（零第三方依赖，只用 Node 内置）
 *
 * 这套胶水对应 Brief 里「文件 + MCP + CLI 交接总线」：
 *   黑板目录 blackboard/ = 所有应用共享的事实源（防传话游戏）
 *   任务契约 task.json   = 主控写、worker 读（含目标/输入/期望输出/边界）
 *   run-log.jsonl        = 可观测：每一步谁在干、成功与否、耗时
 *
 * 诚实标注：code 腿走 CodeBuddy CLI（可自动驱动）；
 *           editor(VSCode) / research(元宝) 仅占位，返回“需 GUI 自动化”。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const BB = path.join(__dirname, '..', 'blackboard');

function taskDir(taskId) {
  const safe = String(taskId).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(BB, 'tasks', safe);
}

/** 读任务契约；缺失时返回合成契约（便于冒烟测试） */
function readTask(taskId) {
  const file = path.join(taskDir(taskId), 'task.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {
      task_id: taskId,
      role: 'code',
      goal: '(task.json 缺失 — 合成契约)',
      inputs: [],
      expected_output: 'md',
      constraints: '数据不出本机',
    };
  }
}

/** 把 worker 结果写回黑板 result.md（产物落盘、轻引用回传） */
function writeResult(taskId, result) {
  const dir = taskDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  const md = [
    `# Result — ${taskId}`,
    '',
    `- role: ${result.role}`,
    `- worker: ${result.worker}`,
    `- ok: ${result.ok}`,
    `- finished_at: ${result.finished_at}`,
    result.note ? `- note: ${result.note}` : '',
    '',
    '## Summary',
    result.summary || '(空)',
    '',
    '## Output',
    result.resultText || '',
    '',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(dir, 'result.md'), md, 'utf8');
  return path.join(dir, 'result.md');
}

/** 读取该任务已有的 result.md（解析 ok / worker / output）——用于 workbuddy 步判断主控是否已提交
 *  注意：只认 worker=workbuddy 的产物；此前以 code 角色跑出的旧产物不能被当成"主控已提交"。 */
function readPriorResult(taskId) {
  try {
    const md = fs.readFileSync(path.join(taskDir(taskId), 'result.md'), 'utf8');
    const ok = (md.match(/^- ok:\s*(\S+)/m) || [])[1];
    const worker = (md.match(/^- worker:\s*(\S+)/m) || [])[1];
    const output = (md.split('## Output')[1] || '').trim();
    return { ok: ok === 'true', worker, output };
  } catch (e) { return null; }
}

/** 追加一行 run-log（可观测 + 一键接管的事实基础） */
function appendLog(entry) {
  fs.mkdirSync(path.join(BB, 'runs'), { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(path.join(BB, 'runs', 'run-log.jsonl'), line, 'utf8');
}

/** 安全地用 shell 跑一条命令（Windows 下全局 npm CLI 是 .cmd，需要 shell） */
function runShellCommand(parts) {
  // 命令名（首项）不含空格则不加引号，否则 cmd 会把 "code"/"codebuddy" 当成带引号的可执行路径而找不到
  const cmd = parts.map((p, i) => (i === 0 && !/\s/.test(String(p)) ? String(p) : shellQuote(p))).join(' ');
  return new Promise((resolve) => {
    const p = spawn(cmd, { shell: true, env: process.env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill();
      resolve({ ok: false, code: 'TIMEOUT', out, err: (err + '\n[timed out 180s]') });
    }, 180000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, out, err: String(e) }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out, err }); });
  });
}

/** 把参数包进双引号并转义内部字符，降低命令注入风险 */
function shellQuote(s) {
  return '"' + String(s).replace(/(["\\$`])/g, '\\$1') + '"';
}

/** 取一个当前空闲的本地端口（listen 0 让 OS 分配，随即释放） */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

/** 单次无头调用（指定 --port，避开与主控/其它会话端口冲突） */
/**
 * CLI 的工作目录固定为 relay-glue 项目根。
 * 原因：CodeBuddy CLI 按「工作目录」解析自己的项目态/会话上下文；若跟着调用方（WorkBuddy 会把子进程 cwd 设成它的 space 目录）
 * 漂移，同一条腿在不同调用方下会表现不一致（曾出现同一 CLI 在 relay-glue 下正常、在 WorkBuddy space 下报未登录）。
 */
const CLI_CWD = path.join(__dirname, '..');
const AUTH_RE = /authentication required|please use \/login|not logged in|please (sign|log) ?in|未登录/i;
function authFailed(r) { return AUTH_RE.test((r && r.out || '') + ' ' + (r && r.err || '') + ' ' + (r && r.raw || '')); }
/** 从 CLI 原始输出里摘出含鉴权关键词的那一行（便于人工判断真实原因） */
function authLine(r) {
  const blob = String((r && r.raw || '') + '\n' + (r && r.err || '') + '\n' + (r && r.out || ''));
  const hit = blob.split(/\r?\n/).find((l) => AUTH_RE.test(l));
  return hit ? hit.trim().slice(0, 240) : '';
}
/** 鉴权失败时落一份诊断（原始输出头 + 环境变量键名，值做脱敏） */
function writeAuthDiag(bin, r) {
  try {
    const dir = path.join(BB, 'runs');
    fs.mkdirSync(dir, { recursive: true });
    const envKeys = Object.keys(process.env).filter((k) => /CODEBUDDY|TOKEN|AUTH|PROXY|SESSION/i.test(k))
      .map((k) => ({ key: k, len: String(process.env[k] || '').length, head: String(process.env[k] || '').slice(0, 6) + '…' }));
    fs.writeFileSync(path.join(dir, 'codebuddy-auth-diag.json'), JSON.stringify({
      at: new Date().toISOString(), bin, cwd: CLI_CWD, argv_cwd_of_caller: process.cwd(),
      raw_head: String((r && r.raw || '') + (r && r.err || '')).slice(0, 1500),
      auth_line: authLine(r), env_keys: envKeys,
    }, null, 2), 'utf8');
  } catch (e) { /* 诊断失败不影响主流程 */ }
}

function onceCodebuddy(bin, promptText, port) {
  const SYS = '你是纯文本助手：不要调用任何工具、不要执行命令，直接给出简洁的最终文本答案。';
  const toolsVal = process.env.RELAY_CODEB_TOOLS === 'all' ? null : '';
  // 启动方式判定：.cmd/.bat → 走 cmd.exe；存在的无扩展名文件（WorkBuddy 内置 node 脚本）→ 用 node 跑；
  // 裸命令名（如 PATH 上的 codebuddy，实际是 npm 的 .cmd shim）→ 也必须走 cmd.exe，否则 node 会把它当 JS 文件解析。
  const isCmd = /\.cmd$/i.test(bin) || /\.bat$/i.test(bin) || !fs.existsSync(bin);
  // 输出格式：默认 json —— 可拿到【真实 usage】(input/output/cache tokens) + duration_ms + 最终文本；
  // RELAY_CODEB_FORMAT=text 可退回纯文本模式（无 usage，token 走估算）。
  const fmt = process.env.RELAY_CODEB_FORMAT === 'text' ? 'text' : 'json';
  const args = [bin, '-p', '--output-format', fmt, '--max-turns', '1', '--port', String(port)];  if (toolsVal !== null) args.push('--tools', toolsVal);
  if (process.env.RELAY_CODEB_MODEL) args.push('--model', process.env.RELAY_CODEB_MODEL);
  // 复用桌面会话 settings（含登录态/插件上下文），避免无头 CLI 误判未登录
  let wbSettings = process.env.RELAY_CODEB_SETTINGS || '';
  if (!wbSettings) {
    try {
      const base = path.join(process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
      const dirs = fs.readdirSync(base).filter((d) => /^workbuddy-cli-args-/i.test(d));
      dirs.sort((a, b) => {
        const sa = fs.statSync(path.join(base, a)), sb = fs.statSync(path.join(base, b));
        return sb.mtimeMs - sa.mtimeMs;
      });
      for (const d of dirs) {
        const f = path.join(base, d, 'settings.json');
        if (fs.existsSync(f)) { wbSettings = f; break; }
      }
    } catch (e) {}
  }
  // 仅“内置 node 脚本”需要 --settings 复用 WorkBuddy 登录；npm .cmd 版有独立登录，不传，避免被 WorkBuddy 上下文带偏。
  if (!isCmd && wbSettings && fs.existsSync(wbSettings)) args.push('--settings', wbSettings);
  args.push('--append-system-prompt', SYS);
  const timeoutMs = parseInt(process.env.RELAY_CODEB_TIMEOUT || '120000', 10);
  // 保留父进程完整环境（含 CODEBUDDY_SERVICE_PROXY_URL）以免无头 CLI 误判“需登录”；
  // 端口冲突已由上方 getFreePort()+--port 解决，无需剔除认证变量。
  return new Promise((resolve) => {
    let p;
    try {
      // .cmd（全局 npm 版）走 cmd.exe /c；node 脚本（内置 CLI）直接用当前 node 执行，避免 cmd 对空格路径/无扩展脚本的解析问题
      // cwd 固定为项目根（见 CLI_CWD 注释）：不让调用方的工作目录影响 CLI 的项目态解析
      p = isCmd
        ? spawn('cmd.exe', ['/c', ...args], { shell: false, env: process.env, cwd: CLI_CWD })
        : spawn(process.execPath, args, { shell: false, env: process.env, cwd: CLI_CWD });
    } catch (e) { return resolve({ ok: false, out: '', err: String(e) }); }
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} resolve({ ok: false, out, err: err + '\n[timeout ' + timeoutMs + 'ms]' }); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (er) => { clearTimeout(timer); resolve({ ok: false, out, err: String(er) }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      // json 模式：stdout 是一串事件数组，取 result 事件的 result(最终文本) + usage(真实 token) + duration_ms
      if (fmt === 'json') {
        try {
          const arr = JSON.parse(out.trim());
          const list = Array.isArray(arr) ? arr : [arr];
          const res = list.filter((e) => e && e.type === 'result').pop();
          if (res) {
            const usage = res.usage || null;
            const text = String(res.result == null ? '' : res.result);
            return resolve({ ok: code === 0 && !res.is_error, out: text, err, raw: out, usage, duration_ms: res.duration_ms, num_turns: res.num_turns, total_cost_usd: res.total_cost_usd });
          }
        } catch (e) { /* 解析失败 → 退回纯文本处理 */ }
      }
      resolve({ ok: code === 0, out, err, raw: out });
    });
    try { p.stdin.write(promptText); p.stdin.end(); } catch (e) { /* 忽略写失败，交给 close */ }
  });
}

/**
 * 无头调用 CodeBuddy CLI：-p + stdin 传 prompt + --tools ""/max-turns 1/纯文本系统提示。
 * 关键：每次取一个空闲 --port，避免与主控(WorkBuddy)或其它会话端口撞 EADDRINUSE；仍撞则换端口重试。
 */
async function runCodebuddyHeadless(bin, promptText) {
  if (process.env.RELAY_DEBUG) process.stderr.write('[relay-debug] 发给 worker 的完整提示词 ↓↓↓\n' + String(promptText).slice(0, 600) + '\n[relay-debug] ↑↑↑ (共 ' + String(promptText).length + ' 字)\n');
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    let port;
    try { port = await getFreePort(); } catch (e) { port = 40000 + Math.floor(Math.random() * 20000); }
    last = await onceCodebuddy(bin, promptText, port);
    if (!/EADDRINUSE|address already in use/i.test((last.out || '') + ' ' + (last.err || ''))) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  return last;
}

const ADAPTERS = {
  /**
   * 主控（WorkBuddy）自己执行的步骤 —— 不调任何外部程序。
   * 背景：角色卡里「扮演应用=WorkBuddy」只是标签，真正决定调度的是「总线角色」；
   *       在没有 workbuddy 角色之前，主理人这类步骤会被打到 CodeBuddy CLI（要登录），语义完全错位。
   * 流程：链跑到这一步 → 返回 awaiting_main_agent + 指令 → 主控自己干完 → submit_main_result 提交 → 链续跑。
   */
  async workbuddy(task) {
    const prior = readPriorResult(task.task_id);
    if (prior && prior.ok && prior.worker === 'workbuddy') {
      return { ok: true, role: 'workbuddy', worker: 'workbuddy', summary: '主控已提交本步产物', resultText: prior.output || '' };
    }
    return {
      ok: false, held: true, awaiting_main: true, status: 'awaiting_main_agent',
      role: 'workbuddy', worker: 'workbuddy',
      summary: '该步由主控（WorkBuddy）亲自执行',
      instruction: String(task.goal || ''),
      note: '主控按指令执行后，调用 submit_main_result{task_id, content} 提交产物，链即可续跑',
    };
  },

  /** CodeBuddy 腿 —— 唯一可自动编程驱动的一条 */
  async code(task) {
    if (process.env.RELAY_DRY_RUN === '1') {
      return {
        ok: true,
        role: 'code',
        worker: 'codebuddy',
        summary: '[DRY-RUN] 契约读写 + result 回传 + run-log 全链路跑通',
        resultText: `# ${task.goal}\n\n（DRY-RUN 合成输出；把 RELAY_DRY_RUN 去掉即走真实 CodeBuddy CLI）`,
      };
    }
    // 真实调用：无头 -p + stdin 传 prompt（避开 cmd 8191 上限）；--tools "" + max-turns 1 + 纯文本系统提示 → 不调工具、不弹权限
    // 优先级：显式 RELAY_CODEB_BIN_OVERRIDE > RELAY_CODEB_BIN > PATH 上的 codebuddy（npm 全局，已独立登录）> WorkBuddy 内置 CLI（最后兜底）。
    // 注：内置 CLI 在当前 WorkBuddy 构建里缺 ../dist/codebuddy 会崩，故仅在 PATH 版不可用时兜底。
    const builtinBin = 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy';
    const pickBin = () => process.env.RELAY_CODEB_BIN_OVERRIDE || process.env.RELAY_CODEB_BIN || 'codebuddy';
    const bin = pickBin();
    const promptFull = (task.personaText ? task.personaText + '\n\n---任务---\n' : '') + String(task.goal || '');
    let r = await runCodebuddyHeadless(bin, promptFull);
    // PATH 上没有 codebuddy → 退到 WorkBuddy 内置 CLI 再试一次
    if (!r.ok && /ENOENT|not recognized|不是内部|command not found/i.test(r.err + ' ' + r.out) && !process.env.RELAY_CODEB_BIN && !process.env.RELAY_CODEB_BIN_OVERRIDE && fs.existsSync(builtinBin)) {
      process.stderr.write('[relay-glue] PATH 无 codebuddy → 回退 WorkBuddy 内置 CLI\n');
      r = await runCodebuddyHeadless(builtinBin, promptFull);
    }
    if (!r.ok && /ENOENT|not recognized|不是内部|command not found/i.test(r.err + ' ' + r.out)) {
      return {
        ok: false,
        role: 'code',
        worker: 'codebuddy',
        summary: 'CodeBuddy CLI 不在 PATH（或未安装）',
        note: '这是 step-1 的真实信号：装好 @tencent-ai/codebuddy-code 后重跑即验证 worker 腿。先用 RELAY_DRY_RUN=1 验总线。',
      };
    }
    // 关键：未登录时 codebuddy 退出码仍为 0，只把“Authentication required”打到输出 → 必须按内容识别，避免假成功
    // （json 模式下该提示在事件流里，故同时扫描 raw 原始输出）
    if (authFailed(r)) {
      // 鉴权失效常是瞬时的（token 刷新窗口 / 并发会话抢锁）→ 等 4 秒原样重试一次
      process.stderr.write('[relay-glue] CodeBuddy 鉴权失败 → 4s 后重试一次（token 可能自动刷新）\n');
      await new Promise((z) => setTimeout(z, 4000));
      const r2 = await runCodebuddyHeadless(bin, promptFull);
      if (!authFailed(r2) && r2.ok && String(r2.out || '').trim()) {
        r = r2;
        process.stderr.write('[relay-glue] CodeBuddy 鉴权重试成功，继续\n');
      } else {
        const rawLine = authLine(r2) || authLine(r) || '(未捕获到原始报错行)';
        writeAuthDiag(bin, r2);
        return {
          ok: false,
          role: 'code',
          worker: 'codebuddy',
          summary: 'CodeBuddy 需登录（已自动重试一次仍失败）',
          note: '原始报错：' + rawLine + ' ｜ 工作目录：' + CLI_CWD + ' ｜ 处理：终端执行 codebuddy.cmd 进入后输入 /login 完成登录，再重跑该步（诊断见 blackboard/runs/codebuddy-auth-diag.json）',
        };
      }
    }
    if (!r.ok || !String(r.out || '').trim()) {
      return { ok: false, role: 'code', worker: 'codebuddy', summary: 'CodeBuddy 输出为空/失败', note: (r.err || '').slice(0, 300) };
    }
    return {
      ok: true,
      role: 'code',
      worker: 'codebuddy',
      summary: 'CodeBuddy CLI 执行成功',
      note: (r.err || '').slice(0, 200),
      resultText: (r.out || '').slice(0, 20000),
      // 真实用量（来自 CLI 的 result 事件）：有则用真实 token 记账，没有则退回字符估算
      usage: r.usage || null,
      cli_duration_ms: r.duration_ms || 0,
      num_turns: r.num_turns || 0,
    };
  },

  /** VSCode 腿 —— 排版：产出 layout.md，真实模式用 code CLI 打开供你审阅（diff 对比上游） */
  async editor(task) {
    const dir = taskDir(task.task_id);
    fs.mkdirSync(dir, { recursive: true });
    // 简单确定性“排版”：把目标/上游内容整理成带标题结构的 layout.md
    const body = String(task.goal || '').replace(/\n{2,}/g, '\n').trim();
    const layout = ['# 排版产物', '', '> 由 editor(VSCode) 腿生成；供人工在 VSCode 审阅/微调。', '', body, ''].join('\n');
    const outFile = path.join(dir, 'layout.md');
    fs.writeFileSync(outFile, layout, 'utf8');

    const bin = process.env.RELAY_CODE_BIN || 'code';
    // 真实模式（RELAY_VSCODE_OPEN=1）：分离式启动 VSCode 打开 layout.md 供审阅（不阻塞编排）
    if (process.env.RELAY_VSCODE_OPEN === '1') {
      try {
        const gui = spawn(bin, [outFile], { shell: true, detached: true, stdio: 'ignore' });
        gui.on('error', () => {});
        gui.unref();
        return { ok: true, role: 'editor', worker: 'vscode', summary: '已在 VSCode 打开排版产物供审阅（不阻塞）', note: outFile, resultText: layout };
      } catch (e) {
        return { ok: false, role: 'editor', worker: 'vscode', summary: 'code CLI 启动失败', note: String(e), resultText: layout };
      }
    }
    // 合成/离线：只验证“产物已生成 + 编排链路”，不弹 VSCode 窗口
    if (process.env.RELAY_DEMO_SYNTHETIC === '1' || process.env.RELAY_VSCODE_OPEN === '0') {
      return { ok: true, role: 'editor', worker: 'vscode', summary: '[DEMO-SYNTH] 排版产物已生成（未真正打开 VSCode）', resultText: layout };
    }
    return { ok: true, role: 'editor', worker: 'vscode', summary: '排版产物已生成（未设 RELAY_VSCODE_OPEN=1，不弹窗）', note: outFile, resultText: layout };
  },

  /** 元宝腿 —— A 档全自动：仅在 RELAY_YUANBAO_ENABLED=1 且已登录 Edge 时走 CDP，否则占位失败安全 */
  async research(task) {
    if (process.env.RELAY_DRY_RUN === '1') {
      return { ok: true, role: 'research', worker: 'yuanbao', summary: '[DRY-RUN] 调研腿合成输出', resultText: '# 调研要点（合成）\n- 要点 A：多 agent 接力可降低上下文丢失\n- 要点 B：黑板作为共享事实源避免传话游戏\n- 要点 C：操作型腿需人工确认闸门\n（DRY-RUN 合成，非真实元宝输出）' };
    }
    if (process.env.RELAY_YUANBAO_ENABLED === '1') {
      try {
        const yb = require('./yuanbao');
        const port = parseInt(process.env.RELAY_CDP_PORT || '9333', 10);
        const r = await yb.askQuestion(port, (task.personaText ? task.personaText + '\n\n---任务---\n' : '') + String(task.goal || ''), { wait: parseInt(process.env.RELAY_YB_WAIT || '60000', 10) });
        if (!r.ok) return { ok: false, role: 'research', worker: 'yuanbao', summary: '元宝自动化未成功', note: r.reason || '选择器需校准 / 未登录' };
        return { ok: true, role: 'research', worker: 'yuanbao', summary: '元宝网页自动化返回结果', resultText: (r.answer || '').slice(0, 20000) };
      } catch (e) {
        return { ok: false, role: 'research', worker: 'yuanbao', summary: '元宝自动化异常（Edge 未起 / 未登录 / 端口不通）', note: String(e) };
      }
    }
    if (process.env.RELAY_DEMO_SYNTHETIC === '1') {
      return { ok: true, role: 'research', worker: 'yuanbao', summary: '[DEMO-SYNTH] 调研完成', resultText: '# 调研要点\n- 合成要点 A/B/C\n（合成输出，非真实元宝；离线验证编排用）' };
    }
    return {
      ok: false,
      role: 'research',
      worker: 'yuanbao',
      summary: '元宝腿未启用（占位）：设 RELAY_YUANBAO_ENABLED=1 并先 launch 登录 Edge',
      note: 'A 档主风险。先 node server/yuanbao-launch.js 登录，再校准选择器。不稳则降级人在环。',
    };
  },

  /** 单 agent 回落 —— 超预算时用一次调用跑完整目标，省多 agent 协调 token */
  async single(task) {
    if (process.env.RELAY_DRY_RUN === '1') {
      return { ok: true, role: 'single', worker: 'single', summary: '[DRY] 单 agent 一次性完成（省多 agent 协调开销）', resultText: '# ' + task.goal + '\n\n（单 agent 回落输出）' };
    }
    const r = await ADAPTERS.code({ ...task, role: 'code' });
    r.role = 'single'; r.worker = 'single';
    r.note = (r.note || '') + '（超预算→单 agent 回落执行）';
    return r;
  },
};

module.exports = { BB, taskDir, readTask, writeResult, appendLog, runShellCommand, ADAPTERS };
