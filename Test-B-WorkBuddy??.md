# Test-B 操作清单 · 用 WorkBuddy 当主控，验证承重假设

> **承重假设**：WorkBuddy 能不能"主动把活派给外部应用、并收回结果"。
> 这条成，整条 Relay 路线才成立；不成，就要走末尾的"退路"。
> 本清单只用本机已有的 relay-glue 胶水，**全程 DRY_RUN，不依赖 CodeBuddy、不联网、不改任务目录外的任何文件**。

---

## 第 0 步 · 已为你预验（无需你操作）
胶水 server 自带 MCP 客户端已自检通过：`initialize → tools/list → dispatch_task` 正常，`result.md` + `run-log` 已落盘。
→ 所以 Test-B 里**唯一的新变量就是 WorkBuddy 这个 Host**，排障时别先怀疑 server。

---

## 第 1 步 · 打开 WorkBuddy 的 MCP 配置入口
左侧栏进入：**专家 · 技能 · 连接器** → 切到 **连接器** 页签 → 右上角 **自定义连接器**（有的版本写"MCP 服务器"）→ **配置 MCP**。
它会打开配置文件编辑器。用户级路径（推荐，所有项目复用）：
```
C:\Users\Administrator\.workbuddy\mcp.json
```

## 第 2 步 · 把下面这段【合并】进 mcpServers（不要覆盖已有连接器）
已有别的 server 配置时，只往 `mcpServers` 里加一个键，别整段替换：
```json
{
  "mcpServers": {
    "relay-glue": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\Tools\\qianwen\\relay-glue\\server\\mcp-adapter.js"],
      "env": { "RELAY_DRY_RUN": "1" },
      "autoStart": true,
      "timeout": 60000,
      "disabled": false
    }
  }
}
```
要点：
- `command` 用**绝对 node 路径**（WorkBuddy 启动环境里 `node` 不一定在 PATH，否则报 `local proxy failed`）。
- Windows 路径里反斜杠要写成 `\\`，JSON 才合法。
- `env.RELAY_DRY_RUN=1`：先验"总线 + WorkBuddy 能调外部工具"这件事本身，不牵扯 CodeBuddy。
- 保存后用 `node -e "JSON.parse(require('fs').readFileSync('C:/Users/Administrator/.workbuddy/mcp.json','utf8'))"` 校验一次没语法错。

## 第 3 步 · 点"信任"，看到绿灯 + 1 个工具（关键，别漏）
写配置**不会自动生效**。回连接器列表：
- 找到 `relay-glue` → 点 **信任** / 打开**启用**开关；
- 状态变**绿点**，并显示 **1/1 个工具已启用**（这个工具就是 `dispatch_task`）。

| 状态 | 含义 | 处理 |
|---|---|---|
| 🟢 绿点 + 1/1 | 连上且枚举到工具 | 进第 4 步 |
| 🟢 绿点 + 0/1 | 进程起了但握手/注册没成 | 多为协议版本或路径问题，见排障 |
| 🔴 红点 | 连不上 | 多为 command 路径，见排障 |

## 第 4 步 · 在对话里【点名】触发，证明真执行（这步就是判定）
新建任务，直接发这句（点名连接器，未发布的自定义连接器在"+"选择列表里看不到，靠点名触发）：
```
调用 relay-glue 连接器的 dispatch_task 工具，参数 task_id=example-001
```
**成功判据（缺一不可）：**
1. 执行过程面板出现 **"正在调用 relay-glue.dispatch_task"** 这一步（不是模型自己编的答案）；
2. 返回里是结构化 JSON（含 `"ok": true`、`"worker": "codebuddy"`、`result_file` 路径）；
3. 回终端确认确实写盘了（见第 5 步）。

## 第 5 步 · 用 run-log 反查"真的执行了"
在 `D:\Tools\qianwen\relay-glue` 目录终端跑：
```powershell
Get-Content .\blackboard\runs\run-log.jsonl -Tail 3
Get-Item .\blackboard\tasks\example-001\result.md | Select-Object LastWriteTime
```
→ 只要 run-log **新增一行**（带 `worker` / `duration_ms`）、result.md 的修改时间**变新**，就铁证 WorkBuddy 真的把调用打到外部进程并收回了结果。

## 第 6 步 · 判定
- ✅ 第 4、5 步全过 → **承重假设成立**：WorkBuddy 能主动派活给外部应用并收结果。可继续做接力链（下一步接 step-2 真 CodeBuddy，再 step-3 元宝）。
- ❌ 挂了 / 调不动 / 模型只编不调 → 别硬推，看排障与退路。

---

## 排障（按 WorkBuddy 实战规律）
- **红点 / `local proxy failed`**：`command` 没找到 → 用绝对 node 路径（已给）；反斜杠没转义会 JSON 解析失败。
- **绿点 0/1**：协议版本或脚本路径不对 → 确认 args 绝对路径存在；先回第 0 步（自带客户端能跑 = server 没问题）。
- **连接器绿但对话里模型不调工具、自己编答案**：工具描述太泛或没点名 → 提问里**显式写"调用 relay-glue 的 dispatch_task"**，必要时加前缀 `@relay-glue` 提命中率。
- **"+"→连接器 列表里选不到**：自定义连接器**未发布**就不在列表里，这是正常的 → 走对话点名触发（第 4 步）。
- **想验证失败注入**：把 `task_id` 改成不存在的 `foo`，应返回清晰错误（`task.json 缺失/合成契约`）而不是卡死——证明超时/错误处理生效。

## 退路（已实现 + 当场验绿）：SSE 传输
若这版 WorkBuddy 不认本地 stdio（只认 sse/http），我已为 relay-glue 加好 **SSE 版 server**，并已用自带客户端验通完整握手 → tools/list → dispatch_task 全链路（run-log 里有 SSE 的 `ok:true` 记录）。
**用两步：**
1. 单开一个终端常驻启动（窗口别关）：
```powershell
$env:RELAY_SSE_PORT="18766"; $env:RELAY_DRY_RUN="1"
node D:\Tools\qianwen\relay-glue\server\sse-server.js
# 看到：[relay-glue-sse] listening http://127.0.0.1:18766/sse  即就绪
```
2. mcp.json 里把 `relay-glue` 改成 SSE（其余字段同上）：
```json
"relay-glue": { "type": "sse", "url": "http://127.0.0.1:18766/sse", "autoStart": true, "timeout": 60000, "disabled": false }
```
> 端口先确认空闲：`Get-NetTCPConnection -LocalPort 18766 -State Listen`，无输出即空闲；被占就改 18767 等。
> 自检命令（不依赖 WorkBuddy）：`node D:\Tools\qianwen\relay-glue\test\sse-probe.js`

---

## 一句话提醒
**先 DRY_RUN 把"WorkBuddy 能不能当大脑"这件事验了**，别一上来就接真 CodeBuddy / 操作元宝。这条过了，剩下的只是往三个 adapter 里逐个填实现；这条不过，就换退路。省你最大的一档风险。
