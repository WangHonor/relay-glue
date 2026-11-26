# start.ps1 —— Relay 一键启动（全家桶）
# 起：① Edge(元宝登录态+CDP) ② 指挥台(可观测/一键接管) ③ SSE MCP 备用通道 ④ 当日快照
# 用法：
#   powershell -ExecutionPolicy Bypass -File start.ps1              # 正常启动（幂等，已在跑就跳过）
#   powershell -ExecutionPolicy Bypass -File start.ps1 -DryRun      # 只打印将做什么
#   powershell -ExecutionPolicy Bypass -File start.ps1 -NoSse       # 不起 SSE 备用通道
#   powershell -ExecutionPolicy Bypass -File start.ps1 -Stop        # 停掉本脚本起过的全部后台进程
param(
  [switch]$Stop,
  [switch]$DryRun,
  [switch]$NoSse,
  [int]$CockpitPort = 0,
  [int]$SsePort = 0
)
$ErrorActionPreference = 'Stop'

# 位置无关：优先用脚本所在目录（若在 relay-glue 内）；旁边没有 server\ 就回退到规范安装目录。
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$install   = 'D:\Tools\qianwen\relay-glue'
if (Test-Path (Join-Path $scriptDir 'server\cockpit.js')) {
  $root = $scriptDir
} elseif (Test-Path (Join-Path $install 'server\cockpit.js')) {
  $root = $install
  Write-Host "提示：脚本不在 relay-glue 目录内，已自动定位到代码目录 $root" -ForegroundColor Yellow
} else {
  throw "找不到 relay-glue 的 server\ 目录（脚本目录=$scriptDir，回退目录=$install）。请把 start.ps1 放在 relay-glue 内运行，或确认代码在 $install。"
}
$runfile = Join-Path $root '.relay-run.json'
$node    = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

$cdpPort     = '9333'    # Edge CDP（元宝）
$cockpitPort = if ($CockpitPort -gt 0) { "$CockpitPort" } else { '8770' }
$ssePort     = if ($SsePort -gt 0) { "$SsePort" } else { '18766' }

# ── 环境变量（子进程继承；指挥台/链里点“续跑/全重跑”即走真 worker）──
$env:RELAY_YUANBAO_ENABLED = '1'
$env:RELAY_VSCODE_OPEN     = '1'
$env:RELAY_CODEB_BIN       = 'C:\Users\Administrator\AppData\Roaming\npm\codebuddy.cmd'
$env:RELAY_YB_WAIT         = '45000'
$env:RELAY_CODEB_TIMEOUT   = '120000'
$env:RELAY_CDP_PORT        = $cdpPort
$env:RELAY_COCKPIT_PORT    = $cockpitPort
$env:RELAY_SSE_PORT        = $ssePort
if (-not $env:RELAY_PROJECT_ID) { $env:RELAY_PROJECT_ID = (Get-Date -Format 'yyyy-MM-dd') }

function Port-InUse($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }
function Port-Owner($p) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.OwningProcess }
  return $null
}
# 端口上跑的是不是「当前这份代码」？旧实例（跑着别的目录/旧版本）→ 自动换端口，避免以为在用新代码
function Probe-Instance($port) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/system" -TimeoutSec 3 -ErrorAction Stop
    return $r
  } catch { return $null }
}
function Find-FreePort($from) {
  for ($i = 0; $i -lt 20; $i++) {
    $p = [int]$from + $i
    if (-not (Port-InUse $p)) { return $p }
  }
  return $from
}

# ── 读取已跟踪 PID（跨次合并，避免“跳过的服务停不掉”）──
function Load-Tracked {
  if (Test-Path $runfile) { try { return @( (Get-Content $runfile -Raw | ConvertFrom-Json).pids ) } catch { return @() } }
  return @()
}
function Save-Tracked($pids) {
  $obj = @{ pids = @($pids | Select-Object -Unique); started_at = (Get-Date).ToString('o'); project = $env:RELAY_PROJECT_ID } | ConvertTo-Json
  Set-Content -Path $runfile -Value $obj -Encoding UTF8
}

# ── 停止：按端口反查真实 PID（确定性）+ 兜底 kill 已跟踪 PID ──
if ($Stop) {
  $tracked = Load-Tracked
  $targets = @()
  foreach ($port in @($cockpitPort, $ssePort)) {
    $owner = Port-Owner $port
    if ($owner) { $targets += $owner; Write-Host "端口 $port 的进程：PID $owner" }
  }
  $targets = @($targets + $tracked | Where-Object { $_ } | Select-Object -Unique)
  if ($targets.Count -eq 0) { Write-Host '没有需要停止的进程。'; return }
  foreach ($pid2 in $targets) {
    try { Stop-Process -Id $pid2 -Force -ErrorAction Stop; Write-Host "已停止 PID $pid2" }
    catch {
      $msg = $_.Exception.Message
      if ($msg -match '拒绝访问|Access is denied|access denied') {
        Write-Host "PID $pid2 结束失败：权限不足（该进程由【管理员权限】启动，当前 shell 不是管理员）" -ForegroundColor Yellow
        Write-Host '    → 请在【管理员】PowerShell 里执行： powershell -ExecutionPolicy Bypass -File start.ps1 -Stop' -ForegroundColor Yellow
      } else {
        Write-Host "PID $pid2 已不在"
      }
    }
  }
  Remove-Item $runfile -Force -ErrorAction SilentlyContinue
  Write-Host '后台服务已停。Edge（元宝）窗口请手动关闭。'
  return
}

Write-Host '== Relay 一键启动 ==' -ForegroundColor Cyan
Write-Host "project=$($env:RELAY_PROJECT_ID)  Edge-CDP=$cdpPort  指挥台=$cockpitPort  SSE=$ssePort  DryRun=$DryRun  NoSse=$NoSse"

$tracked = Load-Tracked

# ── 1) Edge：元宝登录态（专用 profile + CDP 端口）──
if (Port-InUse $cdpPort) {
  Write-Host "[1] Edge CDP $cdpPort 已在监听 → 跳过" -ForegroundColor Green
} else {
  $edge = (Get-Command msedge -ErrorAction SilentlyContinue).Source
  if (-not $edge) { $edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }
  $profile = Join-Path $env:APPDATA 'relay-edge-profile'
  $eargs = @("--remote-debugging-port=$cdpPort", '--remote-allow-origins=*', "--user-data-dir=$profile", '--no-first-run', '--no-default-browser-check', 'https://yuanbao.tencent.com/')
  if ($DryRun) { Write-Host "[1] (DryRun) 将启动 Edge: $edge $($eargs -join ' ')" -ForegroundColor Yellow }
  else {
    if (-not (Test-Path $edge)) { throw "找不到 Edge：$edge" }
    $p = Start-Process -FilePath $edge -ArgumentList $eargs -PassThru
    Write-Host "[1] 已启动 Edge (PID $($p.Id))。首次请在窗口里扫码登录元宝。" -ForegroundColor Green
  }
}

# ── 2) 指挥台（cockpit-server.js）──
$localTools = 0
try {
  $probe = & $node -e "const p=process.argv[1];try{console.log(require(p).TOOLS.length)}catch(e){console.log(0)}" (Join-Path $root 'server\core.js')
  $localTools = [int](@($probe)[0])
} catch { $localTools = 0 }
# 本地代码戳 = server 目录里所有 .js 的最新修改时间（秒），与运行中实例自报的 stamp 对比
$localStamp = 0
try {
  $newest = (Get-ChildItem (Join-Path $root 'server') -Filter *.js | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
  $localStamp = [int64]([DateTimeOffset]::new([DateTime]::SpecifyKind($newest, 'Local')).ToUnixTimeSeconds())
} catch { $localStamp = 0 }
if (Port-InUse $cockpitPort) {
  $inst = Probe-Instance $cockpitPort
  $sameCode = $false
  if ($inst -and $inst.build) {
    $sameCode = ($inst.build.tools -eq $localTools) -and ($inst.build.file -eq (Join-Path $root 'server\cockpit-server.js')) -and ($inst.build.stamp -eq $localStamp)
  }
  if ($sameCode) {
    Write-Host "[2] 指挥台 $cockpitPort 已在监听（同一份代码）→ 跳过" -ForegroundColor Green
  } else {
    $old = if ($inst -and $inst.build) { "旧实例：$($inst.build.file)（工具 $($inst.build.tools) 个，启动于 $($inst.build.boot_at)）" } elseif ($inst) { '旧实例（无构建标识，多半是更早版本）' } else { '占用者不是本项目的指挥台' }
    $newPort = Find-FreePort ([int]$cockpitPort + 1)
    Write-Host "[2] 端口 $cockpitPort 被占用：$old" -ForegroundColor Yellow
    Write-Host "    → 改为在 $newPort 启动新实例（当前权限无法结束占用者时最稳的做法）" -ForegroundColor Yellow
    Write-Host '    → 想回到标准端口：请在【管理员】PowerShell 里执行 start.ps1 -Stop 后重跑本脚本' -ForegroundColor Yellow
    $cockpitPort = "$newPort"
  }
}
if (-not (Port-InUse $cockpitPort)) {
  $srv = Join-Path $root 'server\cockpit-server.js'
  if ($DryRun) { Write-Host "[2] (DryRun) 将启动指挥台: $node $srv (端口 $cockpitPort)" -ForegroundColor Yellow }
  else {
    $env:RELAY_COCKPIT_PORT = $cockpitPort
    $p = Start-Process -FilePath $node -ArgumentList $srv -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $tracked += $p.Id
    Write-Host "[2] 指挥台已启动 (PID $($p.Id)) → http://127.0.0.1:$cockpitPort" -ForegroundColor Green
  }
}

# ── 3) SSE MCP 备用通道（WorkBuddy stdio 挂不上时用 type:sse）──
if ($NoSse) {
  Write-Host '[3] 按参数跳过 SSE' -ForegroundColor Yellow
} elseif (Port-InUse $ssePort) {
  $inst2 = $null
  try { $inst2 = Invoke-RestMethod -Uri "http://127.0.0.1:$ssePort/info" -TimeoutSec 3 -ErrorAction Stop } catch { $inst2 = $null }
  $sseSame = ($inst2 -and $inst2.tools -eq $localTools -and $inst2.file -eq (Join-Path $root 'server\sse-server.js') -and $inst2.stamp -eq $localStamp)
  if ($sseSame) {
    Write-Host "[3] SSE $ssePort 已在监听（同一份代码）→ 跳过" -ForegroundColor Green
  } else {
    $oldS = if ($inst2) { "旧实例：$($inst2.file)（工具 $($inst2.tools) 个，启动于 $($inst2.boot_at)）" } else { '占用者不是本项目的 SSE' }
    $newSse = Find-FreePort ([int]$ssePort + 1)
    Write-Host "[3] 端口 $ssePort 被占用：$oldS" -ForegroundColor Yellow
    Write-Host "    → 改为在 $newSse 启动新实例（当前权限无法结束占用者时最稳的做法）" -ForegroundColor Yellow
    $ssePort = "$newSse"
  }
}
if (-not $NoSse -and -not (Port-InUse $ssePort)) {
  $sse = Join-Path $root 'server\sse-server.js'
  if ($DryRun) { Write-Host "[3] (DryRun) 将启动 SSE: $node $sse" -ForegroundColor Yellow }
  else {
    $env:RELAY_SSE_PORT = $ssePort
    $p = Start-Process -FilePath $node -ArgumentList $sse -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $tracked += $p.Id
    Write-Host "[3] SSE MCP 已启动 (PID $($p.Id)) → http://127.0.0.1:$ssePort/sse" -ForegroundColor Green
  }
}

# ── 4) 当日快照 ──
$snap = Join-Path $root 'server\cockpit.js'
if ($DryRun) { Write-Host "[4] (DryRun) 将生成快照: $node $snap" -ForegroundColor Yellow }
else {
  Start-Sleep -Seconds 1
  & $node $snap | Out-Null
  Write-Host "[4] 当日快照 → $(Join-Path $root 'cockpit.html')" -ForegroundColor Green
}

if (-not $DryRun) {
  # 以“端口实际监听者”为准记录 PID（Start-Process 返回值不可靠），再合并本次新起的
  $owners = @()
  foreach ($port in @($cockpitPort, $ssePort)) { $o = Port-Owner $port; if ($o) { $owners += $o } }
  Save-Tracked (@($owners + $tracked) | Where-Object { $_ } | Select-Object -Unique)
}

Write-Host ''
Write-Host '== 就绪 ==' -ForegroundColor Cyan
Write-Host "指挥台      : http://127.0.0.1:$cockpitPort   （可观测 / 一键接管 / 成本 / 待确认）"
Write-Host "SSE MCP(备) : http://127.0.0.1:$ssePort/sse   （WorkBuddy 里 type:sse 用这条；stdio 正常就不用它）"
Write-Host 'WorkBuddy 驱动全链（在对话里点名）：'
Write-Host '  调用 relay-glue 的 run_chain（fresh=true）；遇 awaiting_confirmation 就对 pending 逐个 approve_task，再 run_chain 续跑，直到 done。'
Write-Host "停止后台：powershell -ExecutionPolicy Bypass -File start.ps1 -Stop"
