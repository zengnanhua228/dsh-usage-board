# verify.ps1 — 检查 dsh-usage-board 安装状态
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
param([string]$Profile = 'desktop')

$ErrorActionPreference = 'Continue'
function Line($k, $v, $color) {
    if ($color) { Write-Host ("{0,-22} {1}" -f $k, $v) -ForegroundColor $color }
    else { Write-Host ("{0,-22} {1}" -f $k, $v) }
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$dest = Join-Path $dshHome 'profiles\node_modules\dsh-usage-board'
$patch = Join-Path $dshHome "profiles\$Profile\cordis.patch.yml"
$cred = Join-Path $dshHome '.credentials.yaml'

Write-Host '============================================================'
Write-Host '  dsh-usage-board 安装自检'
Write-Host '============================================================'
Line 'DSH_HOME' $dshHome

# 1) 插件文件
$files = @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js', 'lib\panel.js')
$missing = @()
foreach ($f in $files) { if (-not (Test-Path (Join-Path $dest $f))) { $missing += $f } }
if ($missing.Count -eq 0) { Line '插件文件' '完整' 'Green' }
else { Line '插件文件' ('缺少: ' + ($missing -join ', ')) 'Red' }

# 2) 版本
$pkgFile = Join-Path $dest 'package.json'
if (Test-Path $pkgFile) {
    try { $pkg = Get-Content $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json; Line '版本' $pkg.version } catch {}
}

# 3) 配置行
if (Test-Path $patch) {
    $t = Get-Content $patch -Raw -Encoding UTF8
    if ($t -match 'dsh-usage-board') { Line '配置行' '已注册' 'Green' }
    else { Line '配置行' '缺失（重跑安装器）' 'Red' }
} else {
    Line '配置行' "找不到 $patch" 'Red'
}

# 4) 面板 token（金额功能，可选）
if (Test-Path $cred) {
    $c = Get-Content $cred -Raw -Encoding UTF8
    if ($c -match '(?m)^\s*HOTDOG_PANEL_REFRESH_TOKEN:\s*"?([^"\r\n]+)') {
        $v = $matches[1]
        $masked = if ($v.Length -gt 14) { $v.Substring(0, 8) + '…' + $v.Substring($v.Length - 4) } else { '***' }
        Line '面板 token' "已配置 $masked" 'Green'
    } else {
        Line '面板 token' '未配置（只影响金额/余额功能）' 'Yellow'
    }
} else {
    Line '面板 token' '凭据文件不存在' 'Yellow'
}

# 5) 插件加载标记
$marker = Join-Path $env:TEMP 'dsh-usage-board-loaded.log'
if (Test-Path $marker) {
    $last = Get-Content $marker -Tail 1
    Line '插件加载记录' $last
} else {
    Line '插件加载记录' '还没有（重启 DSH 后生成）' 'Yellow'
}

Write-Host ''
Write-Host '提示：设置页出现「用量与额度」即表示加载成功。' -ForegroundColor Cyan
