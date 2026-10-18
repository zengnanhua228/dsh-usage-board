# setup-panel-token.ps1 — 配置 HotDogAPI 面板的 refresh_token（启用「金额/余额」功能）
#
# 说明：Token 片段只用于读取面板用量（只读），等价于面板登录态，明文存在
#       <DSH_HOME>/.credentials.yaml（仅本机用户可读）。不配置也能用 Token 看板。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\setup-panel-token.ps1          # 交互粘贴
#   powershell -ExecutionPolicy Bypass -File scripts\setup-panel-token.ps1 -Check   # 只检查已存的
#   powershell -ExecutionPolicy Bypass -File scripts\setup-panel-token.ps1 -DryRun  # 只验证不写入
param(
    [switch]$Check,
    [switch]$DryRun,
    [string]$Token
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$base = 'https://sub.ihc.qzz.io'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$cred = Join-Path $dshHome '.credentials.yaml'
$ref = 'HOTDOG_PANEL_REFRESH_TOKEN'

function Info($m) { Write-Host $m }
function Ok($m) { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Bad($m) { Write-Host $m -ForegroundColor Red }
function Mask([string]$v) {
    if ([string]::IsNullOrEmpty($v)) { return '(空)' }
    if ($v.Length -le 14) { return ('*' * $v.Length) }
    return $v.Substring(0, 8) + '…' + $v.Substring($v.Length - 4) + " (len=$($v.Length))"
}
function ReadStored {
    if (-not (Test-Path $cred)) { return $null }
    $m = [regex]::Match((Get-Content $cred -Raw -Encoding UTF8), '(?m)^\s*' + $ref + ':\s*"?([^"\r\n]+)')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

# 换票 + 读一次 profile，验证可用性
function TestToken([string]$rt) {
    try {
        $body = @{ refresh_token = $rt } | ConvertTo-Json -Compress
        $r = Invoke-RestMethod -Uri "$base/api/v1/auth/refresh" -Method POST `
            -ContentType 'application/json' -Body $body -TimeoutSec 30 -ErrorAction Stop
    } catch {
        $msg = $_.Exception.Message
        if ($_.Exception.Response) { $msg = "HTTP $([int]$_.Exception.Response.StatusCode)" }
        return [pscustomobject]@{ ok = $false; error = $msg; access = $null; next = $null; balance = $null }
    }
    $access = $r.data.access_token
    if (-not $access) { return [pscustomobject]@{ ok = $false; error = '响应里没有 access_token'; access = $null; next = $null; balance = $null } }
    $next = $r.data.refresh_token
    $balance = $null
    try {
        $p = Invoke-RestMethod -Uri "$base/api/v1/user/profile" -Headers @{ Authorization = "Bearer $access" } -TimeoutSec 20 -ErrorAction Stop
        $balance = $p.data.balance
    } catch { }
    return [pscustomobject]@{ ok = $true; error = $null; access = $access; next = $next; balance = $balance }
}

# ── -Check ─────────────────────────────────────────────────────────
if ($Check) {
    $stored = ReadStored
    if (-not $stored) { Warn "凭据里还没有 $ref（金额功能未启用）"; exit 1 }
    Info "已存 token: $(Mask $stored)"
    $r = TestToken $stored
    if (-not $r.ok) { Bad "❌ 已失效：$($r.error)（重新运行本脚本登录面板后粘贴新的）"; exit 2 }
    Ok "✅ 可用$(if ($r.balance -ne $null) { "，面板余额 `$$($r.balance)" })"
    exit 0
}

# ── 取新 token ─────────────────────────────────────────────────────
if ($Token) {
    $new = $Token.Trim().Trim('"')
} else {
    Write-Host ''
    Info '获取步骤：浏览器登录 https://sub.ihc.qzz.io → F12 → Application/应用'
    Info '          → Local Storage → https://sub.ihc.qzz.io → 复制 refresh_token 的值'
    Write-Host ''
    Write-Host '请粘贴 refresh_token（不回显），回车确认：' -ForegroundColor Cyan
    $sec = Read-Host -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $new = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $new = $new.Trim().Trim('"')
}
if ([string]::IsNullOrWhiteSpace($new)) { Warn '没有输入，退出'; exit 1 }
if ($new -notmatch '^rt_') { Warn "警告：值不像 rt_ 开头（实际是 $($new.Substring(0,[Math]::Min(6,$new.Length)))…），继续校验" }

Info '校验中（换票 + 读取面板余额）…'
$res = TestToken $new
if (-not $res.ok) {
    Bad "❌ token 无效，未写入：$($res.error)"
    Info '常见原因：复制漏字符 / 面板已退出登录 / 误复制成 auth_token。'
    exit 2
}
Ok "✅ token 可用$(if ($res.balance -ne $null) { "，面板余额 `$$($res.balance)" })"
$toSave = if ($res.next -and $res.next -ne $new) { $res.next } else { $new }
if ($toSave -ne $new) { Warn '上游发生了 token 轮换，将保存新的那一个' }

if ($DryRun) { Warn '-- DryRun：只验证，不写入 --'; exit 0 }

# ── 写入凭据 ───────────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path $cred) {
    Copy-Item $cred "$cred.bak-paneltoken-$stamp" -Force
    $lines = [IO.File]::ReadAllLines($cred)
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*$ref`:") {
            $indent = ($lines[$i] -replace '^(\s*).*$', '$1')
            $lines[$i] = $indent + $ref + ': "' + $toSave + '"'
            $found = $true
            break
        }
    }
    if (-not $found) {
        $list = New-Object System.Collections.Generic.List[string]
        $inserted = $false
        foreach ($l in $lines) {
            $list.Add($l)
            if (-not $inserted -and $l -match '^(\s+)HOTDOG_API_KEY:') {
                $list.Add($matches[1] + $ref + ': "' + $toSave + '"'); $inserted = $true
            }
        }
        if (-not $inserted) {
            # 没有 refs 段就补一个
            $list.Add('refs:')
            $list.Add('  ' + $ref + ': "' + $toSave + '"')
        }
        $lines = $list.ToArray()
    }
    [IO.File]::WriteAllLines($cred, $lines, (New-Object Text.UTF8Encoding($false)))
} else {
    $content = "version: 1`r`nrefs:`r`n  $ref`: `"$toSave`"`r`n"
    [IO.File]::WriteAllText($cred, $content, (New-Object Text.UTF8Encoding($false)))
}

$verify = ReadStored
if ($verify -ne $toSave) { Bad "写入后回读不一致！从备份恢复：$cred.bak-paneltoken-$stamp"; exit 3 }
Ok "✅ 已写入凭据：$(Mask $verify)"
Info ''
Ok '完成。重启 DSH 后，看板「面板金额」区块会自动出现（未重启也会在 60 秒内轮询到）。'
