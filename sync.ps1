# 把工作区源码同步进 DSH profile 的 node_modules（部署）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\sync.ps1
#   powershell -ExecutionPolicy Bypass -File .\sync.ps1 -Check   # 只校验是否为最新
#
# 部署成**真实目录**而不是 junction/符号链接：Windows 上工具进程创建的
# junction 不可遍历，会让 pnpm 全面失效（DSH 插件生态里记录过这个坑）。
param([switch]$Check)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\dsh-usage-board'
$payload = @('lib', 'cordis.patch.yml', 'package.json')

function Get-PayloadHash([string]$root) {
    $sb = New-Object System.Text.StringBuilder
    foreach ($p in $payload) {
        $full = Join-Path $root $p
        if (-not (Test-Path $full)) { continue }
        if (Test-Path $full -PathType Container) {
            $files = Get-ChildItem $full -Recurse -File -ErrorAction SilentlyContinue | Sort-Object FullName
        } else {
            $files = @(Get-Item $full)
        }
        foreach ($f in $files) {
            $rel = $f.FullName.Substring($root.Length).Replace('\', '/')
            $h = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
            [void]$sb.AppendLine("$rel $h")
        }
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($sb.ToString())
    $ms = New-Object IO.MemoryStream(, $bytes)
    return (Get-FileHash -InputStream $ms -Algorithm SHA256).Hash
}

$srcHash = Get-PayloadHash $src

if ($Check) {
    if (-not (Test-Path $dst)) { Write-Host 'NOT DEPLOYED'; exit 1 }
    $dstHash = Get-PayloadHash $dst
    if ($srcHash -eq $dstHash) { Write-Host "IN SYNC ($($srcHash.Substring(0,12)))"; exit 0 }
    Write-Host "OUT OF SYNC  src=$($srcHash.Substring(0,12))  dst=$($dstHash.Substring(0,12))"
    exit 2
}

if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dst | Out-Null
foreach ($p in $payload) { Copy-Item (Join-Path $src $p) (Join-Path $dst $p) -Recurse -Force }

$dstHash = Get-PayloadHash $dst
Write-Host "deployed -> $dst"
Write-Host "hash $($dstHash.Substring(0,12))  (src $($srcHash.Substring(0,12)))"
if ($srcHash -ne $dstHash) { Write-Host 'WARNING: hash mismatch after copy' -ForegroundColor Yellow; exit 3 }
