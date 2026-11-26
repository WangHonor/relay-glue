# Relay 胶水骨架 · 承重假设验证工具

> 这是上一版《设计简报》(WorkBuddy 联合办公主控) 的**第 4 步落地**：用最小的、不依赖任何编排框架的代码，验证那条**承重假设**——
> “WorkBuddy 能不能当‘主动派活 + 收结果’的大脑，把 CodeBuddy / VSCode / 元宝 当 worker 调起来联合办公？”

零第三方依赖，只用 Node 内置模块（`child_process` / `readline` / `fs`）。**无需 npm install、无需联网。** 环境要求：Node ≥ 18。

## 它实现了什么（对齐 Brief 三条策略）

| 策略 | 落点 |
|---|---|
| 主控调度闭环 | `dispatch_task` 工具：读契约 → 按 role 路由 → 调应用 → 回传结构化结果供主控决定下一步 |
| 自定义交接总线（不靠框架） | `blackboard/` 共享目录 + `task.json` 任务契约 + `result.md` 产物落盘（防传话游戏）|
| 可观测与一键接管 | `blackboard/runs/run-log.jsonl` 每步谁在干、成功与否、耗时 |

## 目录

```
relay-glue/
  交付说明.html          # 一页版：现状 / 上手 / 待办 / 红线
  技术架构.html          # 技术栈 + 分层架构 + 数据流 + 端口拓扑
  Relay与AgentHarness对比.html  # 与通用 agent harness 的定位对比（五支柱逐项）
  设计简报-WorkBuddy联合办公主控.html  # 最终设计简报（方向如何定下来的）
  WorkBuddy闭环提示词.md  # 整段贴进 WorkBuddy 即得自闭环主控
  Test-B-WorkBuddy清单.md # 挂 MCP + 验承重假设的逐步指引
  打包说明.txt            # 解压即用 / 前提 / 自检命令
  start.ps1              # 一键启动（位置无关，UTF-8 BOM）
  server/
    core.js           # 传输无关：dispatch(含安全闸门) + handleMessage + 11 个 MCP 工具
    safety.js         # 安全闸门：敏感词/不可逆 + 人工确认(pending/approve/reject)
    cost.js           # 成本核算 + 超预算闸门 + 单 agent 回落（优先真实 usage）
    handoff.js        # 跨 agent 交接层：结构化交接块 + 指纹校验
    pipeline.js       # 流水线数据层：业务事项 + 版本历史 + 当前版本
    roles.js          # 角色/身份卡（persona）CRUD + 前缀生成
    repair.js         # 失败分诊 + 生成给人工的修复提示词
    mcp-adapter.js    # MCP stdio server（换行分隔 JSON-RPC），薄封装 core
    sse-server.js     # 零依赖 SSE 传输（WorkBuddy stdio 挂不上时的退路）
    adapters.js       # 角色路由 + CodeBuddy/VSCode/元宝 适配器 + 黑板存取
    chain.js          # 接力编排：多步+交接压缩+依赖失效+重试+断点续跑+状态文件
    browser-cdp.js    # 零依赖 CDP 客户端（Node 原生 WebSocket+fetch 驱动 Edge）
    yuanbao.js        # 元宝腿：CDP 驱动已登录的元宝网页（launch/askQuestion）
    yuanbao-launch.js     # 起专用 profile 的 Edge 供你登录一次
    yuanbao-calibrate.js  # 打印元宝页候选选择器
    cockpit.js        # 指挥台快照渲染 + 数据聚合（被 server 复用）
    cockpit-server.js # 本地控制台：实时状态 + 一键接管 + 批准/拒绝
  blackboard/
    roles.json / pipeline.json / config.json            # 角色卡 / 流水线+版本 / 预算·项目·安全
    tasks/example-001/{task.json, task.md, input.md}   # 一条示例任务契约
    runs/run-log.jsonl / *.status.json                 # 运行后自动生成
  test/
    client.js         # 零依赖 MCP stdio 客户端（Test-A）
    sse-probe.js      # 零依赖 SSE 客户端（验 SSE 退路）
    cdp-proof.js      # 零依赖：headless Edge 导航+取值（验 CDP 引擎）
    full-flow-check.js # 四步真实流端到端（确认+成本串链）验证
    dynamic-orchestration-check.js # 动态编排闭环自检（16 项）
```

角色可驱动性（诚实标注，也是验证重点）：
- 🟢 `code` → **CodeBuddy CLI**：可全自动驱动。
- 🟡→🟢 `editor` → **VSCode**：排版腿产出 `layout.md`，真实模式用 `code` CLI 打开供你审阅（非破坏）。本机已确认 `code` 1.145.2 可用；`RELAY_DEMO_SYNTHETIC=1`/`RELAY_VSCODE_OPEN=0` 时只产文件不弹窗。
- 🔴→🟢 `research` → **元宝**：零依赖 CDP 引擎已验绿，且**已连真实登录会话跑通**：打字→回车发送→轮询读回真实答案。默认选择器已固化（输入 `.ql-editor`、答案 `.agent-chat__bubble--ai .agent-chat__bubble__content`、发送=回车）。

> **CodeBuddy 调用方式（已修）**：`codebuddy` 默认交互/无头都会去 bind 一个本地端口，与主控 WorkBuddy 自身端口撞 → `EADDRINUSE` 使 code 腿失败（且不能杀主控）。改用无头 `codebuddy -p --output-format text --max-turns 1 --tools "" --append-system-prompt "纯文本…" --port <空闲端口>`，prompt 走 **stdin**（避开 cmd 8191 上限、不污染产物）；`--port` 每次用 `net` 取一个 OS 分配的空闲端口，仍撞则换端口重试（最多 3 次）。已重跑全真四步链 → done，outline 步真产出代码/大纲。

## 生产上线记录（本版）
本版指挥台已上生产，并端到端真跑验证（元宝 50s / CodeBuddy 大纲 23s / CodeBuddy 成稿 24s / VSCode 排版，上下文交接全 ✅，当日成本 ¥0.28）。上线过程中修掉两个真实生产问题：

1. **code 腿 CLI 优先级（已修）**：`adapters.js` 原优先用 WorkBuddy 自带 CLI（`C:\Program Files\WorkBuddy\...\cli\bin\codebuddy`），但该内置版在当前 WorkBuddy 构建里缺 `../dist/codebuddy` → `Cannot find module` 崩。改为**显式 `RELAY_CODEB_BIN`（全局 npm 版，已独立登录可用）优先**，内置仅作回退；且 `--settings`（复用 WorkBuddy 登录用）只在走内置 node 脚本时才传，npm 版不传。
2. **元宝腿“追问/澄清”子态自愈（已修）**：元宝页若停在上一段对话的澄清态，主输入框 `.ql-editor` 会消失 → 报“输入框选择器需校准”。`yuanbao.js` 新增 `ensureInput()`：发送前探不到输入框就自动 `Page.navigate` 到全新对话重置再重试。选择器 `.ql-editor` 本身是对的，无需改。
3. **遗留 `blackboard/DRY_RUN.flag` 已删**：该 flag 会让 `chain.js` 强制整链走 DRY-RUN（产物写 `[DRY-RUN]`、耗时≈0），生产态不应存在。

指挥台 UI：中后台风格，通用指标全中文，**智能体一律按原始名称展示（元宝 / CodeBuddy / VSCode / WorkBuddy）**。

## 一键启动 start.ps1
一条命令拉起全部服务（幂等，已在跑就跳过）：**Edge 元宝登录态(CDP 9333) → 指挥台(8770) → SSE MCP 备用通道(18766) → 当日快照**，并设好全部 `RELAY_*` 环境变量。
```powershell
powershell -ExecutionPolicy Bypass -File relay-glue\start.ps1            # 启动
powershell -ExecutionPolicy Bypass -File relay-glue\start.ps1 -DryRun    # 只打印将做什么
powershell -ExecutionPolicy Bypass -File relay-glue\start.ps1 -NoSse     # 不起 SSE 备用通道
powershell -ExecutionPolicy Bypass -File relay-glue\start.ps1 -Stop      # 停后台（按端口反查 PID，确定性）
powershell -ExecutionPolicy Bypass -File relay-glue\start.ps1 -CockpitPort 8773 -SsePort 18770   # 指定端口
```
因为 env 已设好，**指挥台里点“断点续跑/全重跑”就是走真 worker**（元宝/CodeBuddy/VSCode）；`RELAY_PROJECT_ID` 默认取当日 → 成本按天分账。
> 实现：`.ps1` 存为 UTF-8 BOM（避 PS5.1 ANSI 解析坑）；PID 跟踪按“端口实际监听者”记录与停止（Start-Process 返回 PID 不可靠）。

**端口被旧实例占用时怎么办（已自动化）**：脚本会探针该端口上的实例（`/api/system`、`/info` 返回"跑的是哪份代码"），发现是**旧代码/别的目录**时，自动在下一个空闲端口起新实例并明确提示；要回到标准端口，请用**管理员** PowerShell 执行 `start.ps1 -Stop` 后重跑（非管理员无法结束管理员启动的进程，脚本会明确区分"已不在"与"权限不足"）。指挥台页面底部「🖥 系统与连接 → 运行时代码」会显示当前实例的**代码路径 / 端口 / 启动时间**，一眼可辨新旧。

## 怎么跑（分两级，先便宜后昂贵）

### Test-A · 先验“总线”（不需要 WorkBuddy、不需要 CodeBuddy）
```bash
# 干跑：证明 契约读→路由→result.md→run-log 全链路 OK
RELAY_DRY_RUN=1 node test/client.js
```
看到 `✅ 总线跑通` + `result.md` 生成 + `run-log.jsonl` 追加一行 → 总线成立。

```bash
# 真跑 CodeBuddy 腿：验证 worker 真的被调起来（需已安装 CodeBuddy CLI）
npm install -g @tencent-ai/codebuddy-code
node test/client.js
# 若 CodeBuddy 不在 PATH，会返回清晰错误（这本身就是 step-1 的真实信号）
```

### Test-B · 验“承重假设”（把总线交给 WorkBuddy 当主控）—— **这步成不成决定整条路线**
在 WorkBuddy 的 MCP 配置里登记本 server（stdio），把 `node` 换成绝对路径：
```json
{
  "mcpServers": {
    "relay-glue": {
      "command": "node",
      "args": ["D:/绝对路径/relay-glue/server/mcp-adapter.js"],
      "env": { "RELAY_DRY_RUN": "1" }
    }
  }
}
```
然后在 WorkBuddy 里对它说：**“调用 relay-glue 的 dispatch_task，task_id=example-001。”**
- ✅ WorkBuddy 能列出并调用这个工具、拿到 result → **“WorkBuddy 当主控大脑”成立**，可继续做接力链。
- ❌ 只能调内置工具、挂不上自定义 MCP、或调不到外部应用 → 说明 WorkBuddy 当不了那个大脑，**需要补一层极小的自研常驻 glue 服务**（README 末尾“退路”）。

## 4 步验证清单（对应之前对话）

1. **总线**：`RELAY_DRY_RUN=1 node test/client.js` —— 见 `✅ 总线跑通` 即过。
2. **CodeBuddy 腿**：装好 CLI 后 `node test/client.js` —— 见 code 腿 ok 即过。
3. **元宝腿（最难）**：用 WorkBuddy 的浏览器/GUI 能力在**网页版元宝**完成“输入问题→读回答案”。不稳 → 元宝降级为“一键搬运 + 人在环”，其余三腿仍全自动。**别一上来承诺四个全自主。**
4. **安全红线**：先测“不可逆操作会不会被误触发”，给元宝/操作型能力划**只读 + 敏感操作确认**边界。

## 成本核算 + 超预算自动降级（生死线）
`server/cost.js` 在 dispatch 里：
- **估 token**：CJK≈1字/token、其它≈4字符/token（启发式，可换真值）。
- **记账**：每步 ¥ 成本累计进 `blackboard/runs/cost.json`（按 `RELAY_PROJECT_ID` 分账，价表可 `RELAY_PRICE_JSON` 覆盖）。
- **超预算闸门**：project 已花费 > `RELAY_COST_LIMIT`（默认 ¥5）时，**后续步骤自动改走单 agent 回落**（`ADAPTERS.single`，省多 agent 协调 token），并标记 `degraded`。
- **指挥台**：新增“💰 成本核算”面板（已花费/预算/状态 + 每步 token 与 ¥ + 降级标记）。
已验：正常 2 次 code 各 ¥0.00466 累计不降级；把预算设极小 → 第 2 步自动 `worker=single`、`demo.degraded=true`、链仍 `done`。

## 安全闸门（操作型腿 · 敏感词/不可逆 + 人工确认）
`server/safety.js` 在 worker 执行前拦截，三档：
- **block**：命中不可逆/高危词（群发/删除全部/清空/转账/发布…）→ 直接拦，永不执行。
- **confirm**：命中敏感词（发送/提交/客户/合同/隐私…），**或** role 为操作型腿（research/editor，即元宝/VSCode GUI）→ 置 `confirm.json:pending`，不调用 worker，等人工批准。
- **auto**：其余（code 腿良性任务）→ 放行。
批准后由 `core.dispatch` 放行到真 worker；拒绝则 `rejected`，不执行。
开关：`RELAY_SAFETY_DISABLED=1` 关闭；`RELAY_SENSITIVE_EXTRA`/`RELAY_IRREVERSIBLE_EXTRA` 追加词。
**指挥台**：待确认任务显⏳、拦截显⛔，每步有 `✔批准执行 / ✖拒绝 / 忽略并续跑`，接口 `/api/approve`、`/api/reject`。
已验：群发→block；发送→hold→approve→codebuddy；research→默认hold→reject；halt-demo 经控制台批准后 run-log worker 由 safety-gate 变 yuanbao（闸门放行铁证）。

## 真实内容流四步（调研→大纲→成稿→排版）+ 确认/成本串链（已验）
`node server/chain.js --full` 走四步真实流。操作型腿（research/editor）默认触发人工确认，所以链会**逐个卡在调研/排版**，批准后续跑：
```powershell
# 离线端到端验证（合成模式，不需元宝/VSCode 真环境）
$env:RELAY_DRY_RUN="1"; $env:RELAY_DEMO_SYNTHETIC="1"
node relay-glue\test\full-flow-check.js
```
已验结果：阶段1 不批 → 停在调研 `awaiting_confirmation`；阶段2 循环批准 → `done`，`research✅→code✅→code✅→editor✅`，**3 处上下文交接全通过**，成本 ¥0.0345/4 步累计。
> `RELAY_DEMO_SYNTHETIC=1` 让 research/editor 产出**明确标注“合成”**的产物，仅用于离线验证编排/交接/成本/确认机制；关掉即回到真实占位/失败安全。

## 编排即 MCP 工具（WorkBuddy 当主控端到端）
server 现暴露 **12 个工具**：`dispatch_task` / `run_chain` / `approve_task` / `list_pending` / `get_repair_prompt` / `read_result` / `read_runlog` / **`list_pipelines`** / **`save_pipeline`** / **`set_pipeline_version`** / **`use_pipeline`** / **`submit_main_result`**。主控不必自己拼流程、也不必读文件，全部经 MCP 驱动与诊断：
```
run_chain{fresh:true}        → 遇操作腿返回 awaiting_confirmation + pending
approve_task{task_id}        → 批准该腿
run_chain{}                  → 续跑（循环直到 result=done）
```
`run_chain` 的返回里带 **`pipeline`**（`mode`=pipeline/builtin、`name`=流水线名、`version`=版本、`steps`=步数）——用来确认"这次跑的到底是哪条链"。链停下时返回 `hint` 明确要求主控**把 repairPrompt 展示给人工**，并禁止自行改跑内置默认四步（否则用户看到的和真实执行不一致）。
> 已验证：从 WorkBuddy 的 space 目录（它拉起 MCP 时的 cwd）经 MCP 主控跑，结果为 `pipeline={mode:pipeline, name:高项备考全攻略, version:1, steps:5}`，五步全绿 `done`。

### 总线角色 = 这一步调度到谁（别踩坑）
角色卡有两个字段，**只有「总线角色」参与调度**，「扮演应用」只是标签：
| 总线角色 | 调度到 | 说明 |
|---|---|---|
| `research` | 元宝（CDP 浏览器） | 操作型腿，默认需人工确认 |
| `code` | CodeBuddy CLI | 需已登录 |
| `editor` | VSCode | 操作型腿，默认需人工确认 |
| **`workbuddy`** | **主控（WorkBuddy）自己执行** | 不调外部程序；产物由主控 `submit_main_result{task_id,content}` 提交 |
| `single` | 单 Agent 回落 | 超预算时用 |

> 曾经「主理人（WorkBuddy）」这张卡的总线角色是 `code` → 这一步被打到 **CodeBuddy CLI**（要登录），语义完全错位。现已新增 `workbuddy` 角色：链跑到这一步会返回 `awaiting_main_agent` + 指令，主控亲自做完后提交产物，链再续跑。
> 已验证（项目政策性材料采集及方案编写 = 主理人→情报调研员）：
> `run_chain → awaiting_main_agent（指令=下需求）→ submit_main_result → run_chain → awaiting_confirmation（批准元宝）→ done`。
已端到端验通（自带 MCP 主控客户端 `test/chain-client.js`，等价 WorkBuddy 的调用）：
`run_chain→awaiting(research)→approve→run_chain→awaiting(layout)→approve→run_chain→done`，四步全真 worker（元宝/CodeBuddy/VSCode）。

### 动态编排（主控能自己改链 / 切链 / 回滚）——补强①
后四个工具把**编排权交回模型**：主控不再只能跑固定链，可以按任务现编一条链、存成新版本、切换当前执行链、回滚旧版本。
```
list_pipelines{}                        → 列出所有流水线（业务事项）+ 当前版本 + 版本历史
save_pipeline{name,steps[],note,use}    → 追加新版本（每次保存留版本，可回滚）；use=true 顺带设为当前
use_pipeline{name}                      → 切换「当前执行链」
set_pipeline_version{name,v}             → 回滚到指定历史版本
run_chain{fresh:true}                   → 按当前链·当前版本执行
```
- **步骤格式**：`{id?, persona(角色卡id), goal(该步指令)}`；`persona` 决定用哪个身份卡与其 role。
- **自测**：`RELAY_DRY_RUN=1 node test/dynamic-orchestration-check.js` → 16/16 通过（建链→改链→切链→跑新链→回滚→切回）。
- **真机回归**：`内容生产` 五步链经 MCP 主控跑 `done`（元宝→CodeBuddy×3→VSCode）。

### 真实 token 记账（不再靠字符估算）——补强②
CodeBuddy CLI 以 `--output-format json` 运行时返回 `usage`（input/output/cache tokens）+ `duration_ms`，适配器已解析并回传；记账优先用**真实用量**，无 usage 的 worker（如元宝 GUI）才回退字符估算，run-log / 成本面板都会标注来源（真实 / 估算）。
```
cost={"tokens_in":6243,"tokens_out":908,"tokens_source":"real","cost":0.17934}
```
> 退回纯文本模式：`RELAY_CODEB_FORMAT=text`（无 usage，token 走估算）。
> CodeBuddy 可执行文件的取用顺序：**`RELAY_CODEB_BIN_OVERRIDE` > `RELAY_CODEB_BIN` > PATH 上的 `codebuddy`（npm 全局）> WorkBuddy 内置 CLI（兜底，当前构建缺 `../dist/codebuddy` 会崩）**。PATH 版（裸命令名）走 cmd.exe 启动，避免 node 把它当 JS 文件解析。

### 交接压缩 + 依赖失效（上下文生命周期）——补强③
上游产物不再整段拼进下游 prompt，而是压成结构化交接块（来源 / **交接指纹** / 上游摘要 / 内容上限，默认截断 4000 字），并用指纹证明"上游确实带进来了"。
- 完整性校验改为**指纹校验**（不再逐字比对原文），截断后依然成立。
- **依赖失效**：每步记录它继承的上游指纹；上游产物变了 → 该步自动重跑（而不是继续用旧产物）。
- 断点续跑跳过的步，会从 run-log **回填**上次的真实耗时 / token / 成本，链表不再显示 0。

**WorkBuddy 侧真跑**：mcp.json 里给 relay-glue 配好真环境 env（Edge 已登录 9333、codebuddy 已登录、code 在 PATH），然后在 WorkBuddy 对话点名：
```
调用 relay-glue 的 run_chain（fresh=true）；若返回 awaiting_confirmation，就对其 pending 逐个调 approve_task，再调 run_chain 续跑，直到 done。
```
> 我这边用 MCP 客户端把这条链路验到 done；WorkBuddy 是同一个 server、同一组工具，你照上面点名即可复现。

## 异常修复提示（单腿失败 → 主控给人工的修复提示词）
某条腿异常时，系统**自动**按“失败分诊表”判根因，生成一段可直接贴回主控的中文【异常修复提示词】，提示人工怎么修链路（而不是只丢一个 `halted@worker_fail`）。
- 触发：`chain.js` 停链时写 `runs/chain-demo.repair.md` + `status.repair`；指挥台顶部出现「⚠️ 异常修复提示」面板。
- 主控侧：`run_chain` 返回里带 `repairPrompt` 字段；也可随时调只读工具 `get_repair_prompt{}` 取。
- 分类覆盖：端口冲突 / 未登录 / CLI 缺失(含中文乱码报错) / 执行超时 / 元宝页面状态漂移 / 空输出 / 安全闸门拦截 / 上下文丢失；未命中则给通用兜底动作。
- 提示词含：哪一步·哪个智能体(原始名称)·根因·建议动作(按顺序)·修好后如何 `run_chain` 续跑·可改写的该步目标模板。
```powershell
node relay-glue\test\repair-check.js   # 4 类失败归类自检
```

## 智能体身份/角色（persona）
给每个智能体定义“身份卡”，主控派活时把对应卡注入 worker 提示词前缀，让它们按各自角色协作、按契约交接。
- **自定义入口（推荐）**：指挥台 http://127.0.0.1:8770 的「🎭 角色 / 身份管理」面板——可视化新建/编辑/删除角色卡，保存即写回 `blackboard/roles.json`（自动备份、即时生效、无需重启）。可按“工作类型”给不同类型的工作建不同身份。
- 角色卡：`blackboard/roles.json`。字段：`id / 身份 / role(research|code|editor|single) / agent(元宝|CodeBuddy|VSCode|WorkBuddy) / 工作类型 / 职责 / 交付 / 协作 / 约束`。
- 注入：`server/roles.js` → `core.dispatch` 按 `task.persona`(卡 id) 或 `role` 取卡，拼到发给 worker 的提示词最前。
- 接力链：`chain.js` 每步带 `persona`，默认五步 **调研(元宝)→大纲→成稿→审稿→排版(VSCode)**，CodeBuddy 分别扮演结构策划编辑/撰稿作者/审稿把关人。
- 让主控按角色协作：在 WorkBuddy 里点名 `run_chain`，每步 worker 已自带身份；也可 `dispatch_task{task_id,role}`（task.json 里写 `persona` 指定卡）。
- 自检：`node -e "console.log(require('./server/roles').prefix('yanjiu'))"` 看注入文本；跑链时 stderr 有 `PERSONA ... card=xxx`，`RELAY_DEBUG=1` 可回显发给 worker 的完整提示词。
> 想换成你自己的团队：编辑 `roles.json` 的卡（增删角色、改身份/职责/交付/协作/约束），并在 `chain.js` 的 `FULL_STEPS` 里把每步 `persona` 指向你的卡 id。

## 流水线编排（把角色卡拼成接力链，不碰代码）
指挥台 http://127.0.0.1:8770 的「🔗 流水线编排」面板：
- **按业务事项归类**：每条流水线 = 一个业务场景（如 长文/公众号、周报、竞品调研），可建多条并“设为当前执行”；面板顶部“业务事项”字段描述该场景。
- **版本管理**：每次“保存为新版本”会追加一个版本（填变更说明），保留历史；版本列表可 **查看 / 回滚到此版本 / 删除**；`chain.js` 与主控 `run_chain` 始终按“当前流水线 · 当前版本”执行。
- **可视化编排**：从角色卡下拉选每一步用哪个身份，填该步指令，支持 加一步 / 上移下移 / 删除。
- **即时生效**：保存写 `blackboard/pipeline.json`（自动备份 + 每次写文件再整体备份 `.bak-<时间>`）；无 `pipeline.json` 时 `chain.js` 回退内置步骤（向后兼容旧数组格式，自动迁移为 v1）。
- **面板内直接跑**：▶续跑 / ↺全重跑 走当前流水线（操作型腿仍受安全闸门待确认约束）。
- HTTP 接口：`GET /api/pipeline`（含 versions/业务事项/当前版本）· `GET /api/pipeline/version?name&v` · `POST /api/pipeline/save|use|delete|run|version|version/delete`。
- 自检：`node test/pipeline-http-check.js`。

## 指挥台布局（左侧导航 · 中后台）
指挥台 http://127.0.0.1:8770 采用左侧导航 + 右侧分区，四个视图覆盖全部能力：
- **运行总览**：KPI 磁贴 + 🖥系统与连接 + ⚠️异常修复提示 + ⏳待确认 + 接力链执行 + 成本核算 + 最近调用记录 + 任务产物预览。
- **身份角色管理**：🎭 角色卡增删改（写 `roles.json`，即时生效）。
- **流水线编排**：🔗 角色卡拼链、多流水线切换、面板内跑（写 `pipeline.json`）。
- **一键接管**：🎛 断点续跑 / 全重跑 / **🤖 主控驱动全链（自动批准待确认腿）** / 逐步 重跑·忽略·批准·拒绝·🔍诊断。
- **🖥 系统与连接卡**：服务版本、当前流水线、项目/账本、预算/已花费/降级、安全闸门状态、MCP 工具清单、连接健康（指挥台/SSE/Edge CDP 端口实时探测），以及**可视化配置**（预算 ¥、项目/账本、安全闸门开关）→ 写 `blackboard/config.json`，指挥台与子进程即时生效。
- 相关 HTTP：`GET /api/system` · `GET|POST /api/config` · `POST /api/drive`（主控驱动闭环）。
- 静态快照 `cockpit.html` 同样为侧栏布局；角色/流水线/接管/系统卡在快照里为只读，交互操作在实时控制台。

## 指挥台控制台（可观测 + 一键接管 · 零依赖）
`server/cockpit.js` 生成静态快照；`server/cockpit-server.js` 是**可刷新的本地控制台**（Brief 策略③）。
```powershell
$env:RELAY_DRY_RUN="1"          # 想真跑 CodeBuddy 就不设
node relay-glue\server\cockpit-server.js
# 打开 http://127.0.0.1:8770
```
- 实时看：链每步状态 / 上下文交接✅❌ / run-log / 各环节产物
- **各环节产物**（新版展示）：每张卡片 = 环节名 + 状态徽标 + 智能体原名 + 耗时/成本/Token/时间 + 失败原因 + 摘要 + **Markdown 渲染的产物正文**（超长折叠、可展开全文）；顶部有「共 N 个 · 成功 N · 失败 N」与「只看失败」「展开全部」；成功卡左侧绿边、失败卡左侧红边 + 淡红底，一眼区分
- **一键接管**：`断点续跑(跳过已ok)`、`全重跑`、每步 `重跑该步`、失败步 `忽略并续跑`
- 接口：`GET /api/status`、`POST /api/run[?fresh=1]`、`POST /api/retry{task}`、`POST /api/ignore{task}`
- 已现场验证：造一条停在元宝步的失败链 → `忽略 layout → 续跑` → 状态由 `halted@worker_fail` 变 `done`。
> 安全：仅监听 127.0.0.1，动作只读写本机 blackboard 目录。
> **改过 server 代码后要重启才生效**：脚本用「代码戳」（server 目录所有 .js 的最新修改时间）识别旧实例，端口上跑的是旧代码时会自动让位到下一个空闲端口并打印新地址。

## step-3 元宝腿（A 档全自动 · 零 npm CDP · 已连真实会话跑通）
引擎层已**当场验绿**：`server/browser-cdp.js` 用 Node 原生 `WebSocket`+`fetch` 驱动 headless Edge，成功 `导航 + DOM 取值`（`test/cdp-proof.js` 读回 `CDP-OK / relay-cdp-engine-works`）。不装 Playwright/Puppeteer。
**并已连你登录的真实元宝会话端到端跑通**：`yuanbao-probe.js` 探出选择器 → 默认固化 → `askQuestion` 真"打字→回车→读回 820 字真实答案" → 经总线+安全闸门+成本记账全链路 `ok=true worker=yuanbao`。

**但元宝要扫码登录，且其 DOM 选择器需对着你真实页面校准**——这两步只能你在本机做。流程：
```powershell
# 1) 起一个专用 profile 的 Edge，弹窗里扫码登录元宝一次（登录态持久化）
node relay-glue\server\yuanbao-launch.js
# 2) 保持 Edge 开着，打印候选选择器（输入框/发送键/按钮）
node relay-glue\server\yuanbao-calibrate.js
# 3) 把校准结果固化后启用元宝腿，再跑接力链（--halt-demo 会带上 research 步）
$env:RELAY_YUANBAO_ENABLED="1"
$env:RELAY_YB_INPUT_SEL="textarea"; $env:RELAY_YB_SEND_SEL="<校准到的发送键>"; $env:RELAY_YB_ANSWER_SEL="<回答节点>"
node relay-glue\server\chain.js --halt-demo
```
失败安全（已验）：未启用→占位 `ok:false`；启用但 Edge 没起→CDP 连不上被捕获、`ok:false`，**链不崩、停在该步上报** → 命中 A 档主风险的预期行为。

## 安全红线（A 档高权限必读）
- `code` adapter 不把任务文本直接拼进命令行：目标写进 `prompt.txt`，仅传**固定指令 + 路径**，降低命令注入与误执行。
- adapter 白名单化：`role` 只接受 `code/editor/research`，未知角色直接拒绝。
- 默认边界：产物只落本机 `blackboard/`，不联网、不动任务目录之外路径。
- 真实接入元宝/VSCode 前，务必先加“敏感/不可逆操作需人工确认”的闸门（对应 Brief 的可观测与一键接管）。

## 退路（已实现 + 验绿）：SSE 传输
WorkBuddy 桌面版自定义连接器至少支持 sse/http。若 stdio 这条挂不上，直接用已实现并验证过的 SSE 版：
```powershell
# 常驻启动（窗口别关）
$env:RELAY_SSE_PORT="18766"; $env:RELAY_DRY_RUN="1"
node server/sse-server.js
# 自检（不依赖 WorkBuddy，验证完整握手→tools/list→dispatch_task）
node test/sse-probe.js
```
mcp.json 里把 relay-glue 改成 `{ "type":"sse", "url":"http://127.0.0.1:18766/sse", "autoStart":true, "timeout":60000 }`。
两条传输（stdio + SSE）共用 `server/core.js` 里的同一份 dispatch 逻辑；run-log 已各自有 `ok:true` 记录。

> **Test-A 实测（本机）**：stdio 与 SSE 两条传输均已跑通——`initialize → tools/list → dispatch_task → result.md + run-log` 全链路 `ok:true`。承重假设里"总线 / server 协议正确"这部分已证；唯一待你在 WorkBuddy 侧确认的是 Test-B 的 Host 连接。
