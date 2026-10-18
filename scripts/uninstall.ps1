# uninstall.ps1 — 卸载 dsh-usage-board
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -DryRun
#
# 做的事：
#   1. 删除 <DSH_HOME>/profiles/node_modules/dsh-usage-board
#   2. 从 profile 的 cordis.patch.yml 移除插件行（带备份）
#   3. 不会删除你的面板 token / API key（凭据是共享的，可能还有别处在用）
param(
    [string]$Profile = 'desktop',
    [string]$PatchPath,
    [switch]$DryRun,
    # 只清理配置文件、保留插件文件（测试/排障用）
    [switch]$KeepFiles
)

$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host $m }
function Ok($m) { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$dest = Join-Path $dshHome (Join-Path 'profiles\node_modules' 'dsh-usage-board')
$patch = if ($PatchPath) { $PatchPath } else { Join-Path $dshHome (Join-Path "profiles\$Profile" 'cordis.patch.yml') }

if ($DryRun) { Warn '-- DryRun：只打印，不改文件 --' }
Info "插件目录: $dest"
Info "配置文件: $patch"

# ── 1. 删除插件目录 ─────────────────────────────────────────────────
if ($KeepFiles) {
    Info '已指定 -KeepFiles：保留插件文件，只清理配置'
} elseif (Test-Path $dest) {
    if ($DryRun) { Info '[dry-run] 删除插件目录' }
    else { Remove-Item $dest -Recurse -Force; Ok '已删除插件目录' }
} else {
    Info '插件目录不存在（可能已卸载）'
}

# ── 2. 从补丁文件移除插件行 ─────────────────────────────────────────
if (-not (Test-Path $patch)) { Warn "找不到 $patch，跳过配置清理"; exit 0 }

$lines = [IO.File]::ReadAllLines($patch)
$out = New-Object System.Collections.Generic.List[string]
$removed = 0
$i = 0
while ($i -lt $lines.Count) {
    $line = $lines[$i]
    if ($line -match '^\s*-\s*insert:\s*$') {
        # 从这个 insert 开始，找到 `name: dsh-usage-board` 所在位置（最多向后 12 行）
        $nameIdx = -1
        for ($j = $i + 1; $j -lt [Math]::Min($lines.Count, $i + 13); $j++) {
            if ($lines[$j] -match '^\s*-\s' -and $j -gt $i + 1) { break }  # 到了下一个列表项
            if ($lines[$j] -match 'dsh-usage-board') { $nameIdx = $j; break }
        }
        if ($nameIdx -ge 0) {
            # 向后吞掉同一块里缩进更深的行
            $end = $nameIdx
            for ($k = $nameIdx + 1; $k -lt $lines.Count; $k++) {
                if ($lines[$k] -match '^\s*$') { break }
                if ($lines[$k] -match '^[^\s]' -or $lines[$k] -match '^-\s') { break }
                $end = $k
            }
            $removed += ($end - $i + 1)
            $i = $end + 1
            continue
        }
    }
    $out.Add($line)
    $i++
}

if ($removed -eq 0) {
    Info '配置里没有插件行（无需清理）'
    exit 0
}
if ($DryRun) {
    Info "[dry-run] 将移除 $removed 行配置"
    exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $patch "$patch.bak-uninstall-$stamp" -Force
[IO.File]::WriteAllLines($patch, $out, (New-Object Text.UTF8Encoding($false)))
Ok "已移除 $removed 行配置（备份: cordis.patch.yml.bak-uninstall-$stamp）"
Info ''
Ok '卸载完成。重启 DSH 生效。'
