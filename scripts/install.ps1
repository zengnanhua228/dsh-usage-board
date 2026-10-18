# install.ps1 — 一键安装 dsh-usage-board 到本机 DSH
#
# 用法（普通用户请直接双击仓库根目录的「安装.cmd」）：
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Profile web
#
# 做的事：
#   1. 把 lib/ package.json cordis.patch.yml 复制到 <DSH_HOME>/profiles/node_modules/dsh-usage-board
#   2. 在 profile 的 cordis.patch.yml 里插入一行（已存在则跳过），带备份
#   3. 有 Node 时做 YAML 校验；没有则只做文本级检查
#   4. 打印后续步骤（重启 DSH、可选配置面板 token）
param(
    [string]$Profile = 'desktop',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host $m }
function Ok($m) { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Bad($m) { Write-Host $m -ForegroundColor Red }

$repo = Split-Path $PSScriptRoot -Parent
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profiles = Join-Path $dshHome 'profiles'
$nodeModules = Join-Path $profiles 'node_modules'
$dest = Join-Path $nodeModules 'dsh-usage-board'
$patch = Join-Path (Join-Path $profiles $Profile) 'cordis.patch.yml'
$payload = @('lib', 'cordis.patch.yml', 'package.json')

Info '============================================================'
Info '  dsh-usage-board 安装器'
Info '============================================================'
Info "源码目录 : $repo"
Info "DSH_HOME : $dshHome"
Info "目标 profile: $Profile"
Info "主目录   : $dest"
Info ''

# ── 0. 检查 ─────────────────────────────────────────────────────────
if (-not (Test-Path $dshHome)) { Bad "找不到 DSH_HOME：$dshHome（请先安装并运行一次 DSH）"; exit 1 }
if (-not (Test-Path (Join-Path $profiles $Profile))) {
    Warn "profile '$Profile' 不存在。桌面版通常是 desktop，Web 版是 web。"
    Warn "现有 profile: " + ((Get-ChildItem $profiles -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'node_modules' } | ForEach-Object { $_.Name }) -join ', ')
    exit 1
}
foreach ($p in $payload) {
    if (-not (Test-Path (Join-Path $repo $p))) { Bad "源码缺少 $p，请在仓库根目录下运行"; exit 1 }
}

if ($DryRun) { Warn '-- DryRun：只打印要做的动作，不写任何文件 --' }

# ── 1. 复制插件文件 ─────────────────────────────────────────────────
if ($DryRun) {
    Info "[dry-run] 复制 $($payload -join ', ') -> $dest"
} else {
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    foreach ($p in $payload) { Copy-Item (Join-Path $repo $p) (Join-Path $dest $p) -Recurse -Force }
    Ok "已安装文件 -> $dest"
}

# ── 2. 合并 profile 补丁 ────────────────────────────────────────────
$block = @'
- insert:
    - id: usage-board
      name: dsh-usage-board
      config:
        balanceThreshold: 5
        cacheMs: 4000
        notifyEnabled: true
        notifyMinHours: 12
'@

if (-not (Test-Path $patch)) {
    Warn "找不到 $patch —— 该 profile 可能还没初始化。请先启动一次 DSH 再重跑安装。"
    exit 1
}

$text = Get-Content $patch -Raw -Encoding UTF8
if ($text -match 'dsh-usage-board') {
    Ok '配置里已存在 dsh-usage-board 行，跳过（如需重装可先运行卸载器）'
} else {
    if ($DryRun) {
        Info "[dry-run] 向 $patch 追加插件行"
    } else {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item $patch "$patch.bak-install-$stamp" -Force
        $new = $text.TrimEnd() + "`r`n`r`n" + ($block -replace "`n", "`r`n") + "`r`n"
        [IO.File]::WriteAllText($patch, $new, (New-Object Text.UTF8Encoding($false)))
        Ok "已写入配置（备份: cordis.patch.yml.bak-install-$stamp）"
    }
}

# ── 3. 校验 ─────────────────────────────────────────────────────────
if (-not $DryRun) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $verifyJs = Join-Path $PSScriptRoot 'patch-merge.cjs'
    if ($node -and (Test-Path $verifyJs)) {
        # 有 Node：用 DSH 自带的 js-yaml 做真正的解析校验
        $out = & node $verifyJs $patch add '{"balanceThreshold":5,"cacheMs":4000,"notifyEnabled":true,"notifyMinHours":12}' 2>&1
        try {
            $j = $out | ConvertFrom-Json
            if ($j.ok) { Ok "YAML 校验通过（条目 $($j.rows)）" }
            else { Warn "YAML 校验未通过：$($j.reason)（可回滚备份）" }
        } catch {
            Warn "YAML 校验跳过（输出无法解析）: $out"
        }
    } else {
        $t = Get-Content $patch -Raw -Encoding UTF8
        if ($t -match 'dsh-usage-board' -and $t -notmatch "`t") { Ok '文本级检查通过（无 Node，未做严格 YAML 校验）' }
        else { Warn '文本级检查发现问题，请回滚备份后检查' }
    }
    if (-not (Test-Path (Join-Path $dest 'lib\index.js'))) { Bad '安装后找不到 lib/index.js'; exit 1 }
}

Info ''
Ok '安装完成。下一步：'
Info '  1) 完全退出 DSH（托盘图标右键 → 退出）后重新打开'
Info '  2) 打开 设置 → 应出现「用量与额度」'
Info '  3) 想看「金额/余额」：双击「配置面板Token.cmd」'
Info ''
Info "卸载：双击「卸载.cmd」（或 scripts\uninstall.ps1）"
