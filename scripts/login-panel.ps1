# login-panel.ps1 — 独立的小登录窗口（不打开 DSH 设置页也能登录面板、启用金额）
#
# 用法：
#   双击仓库根目录的「登录面板.cmd」（或 login-panel.cmd）
#   命令行无界面测试： powershell -ExecutionPolicy Bypass -File scripts\login-panel.ps1 -Headless -Email a@b.c -Password xxx
#
# 做的事：用面板邮箱+密码登录 → 保存 refresh_token 到 ~/.dsh/.credentials.yaml → 关闭窗口
# 安全：密码只在内存里用一次，不写盘、不写日志。
param(
    [string]$Email,
    [string]$Password,
    [switch]$Headless
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$base = 'https://sub.ihc.qzz.io'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$cred = Join-Path $dshHome '.credentials.yaml'
$loginInfo = Join-Path $dshHome 'usage-board-login.json'
$ref = 'HOTDOG_PANEL_REFRESH_TOKEN'

function Get-RememberedEmail {
    if (Test-Path $loginInfo) {
        try { return (Get-Content $loginInfo -Raw -Encoding UTF8 | ConvertFrom-Json).email } catch { }
    }
    return ''
}

function Save-LoginInfo([string]$email) {
    try { [IO.File]::WriteAllText($loginInfo, (@{ email = $email; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) } catch { }
}

function Save-Token([string]$token) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    if (Test-Path $cred) {
        Copy-Item $cred "$cred.bak-panel-login-$stamp" -Force
        $lines = [IO.File]::ReadAllLines($cred)
        $found = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^\s*$ref`:") {
                $indent = ($lines[$i] -replace '^(\s*).*$', '$1')
                $lines[$i] = $indent + $ref + ': "' + $token + '"'
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
                    $list.Add($matches[1] + $ref + ': "' + $token + '"'); $inserted = $true
                }
            }
            if (-not $inserted) { $list.Add('refs:'); $list.Add('  ' + $ref + ': "' + $token + '"') }
            $lines = $list.ToArray()
        }
        [IO.File]::WriteAllLines($cred, $lines, (New-Object Text.UTF8Encoding($false)))
    } else {
        [IO.File]::WriteAllText($cred, "version: 1`r`nrefs:`r`n  $ref`: `"$token`"`r`n", (New-Object Text.UTF8Encoding($false)))
    }
}

function Classify([int]$status, $json, [string]$netErr) {
    $raw = if ($json) { if ($json.message) { [string]$json.message } elseif ($json.reason) { [string]$json.reason } else { '' } } else { '' }
    $low = $raw.ToLower()
    if ($status -eq 401 -or $low -match 'invalid credential') {
        return @{ ok = $false; msg = '账号或密码不正确'; hint = '检查邮箱是否完整、密码大小写/特殊字符；也可用「粘贴 refresh_token」方式。' }
    }
    if ($status -eq 429) { return @{ ok = $false; msg = '登录尝试过于频繁'; hint = '等 1–2 分钟再试。' } }
    if ($status -eq 403) { return @{ ok = $false; msg = '账号被限制或需要额外验证'; hint = '到网页面板确认账号状态。' } }
    if ($low -match 'captcha|turnstile|verify|人机') { return @{ ok = $false; msg = '面板要求人机验证'; hint = '先在浏览器登录一次，再用「粘贴 refresh_token」。' } }
    if ($low -match 'locked|disabled|banned|suspend') { return @{ ok = $false; msg = '账号已锁定/禁用'; hint = '联系面板管理员。' } }
    if ($status -eq 0 -or $netErr) { return @{ ok = $false; msg = '连不上面板服务'; hint = '检查网络/代理后重试。' } }
    if ($status -ge 500) { return @{ ok = $false; msg = "面板服务端异常（HTTP $status）"; hint = '稍后重试。' } }
    if ($raw) { return @{ ok = $false; msg = $raw; hint = '' } }
    return @{ ok = $false; msg = '登录失败'; hint = '' }
}

function Invoke-PanelLogin([string]$mail, [string]$pass) {
    if ([string]::IsNullOrWhiteSpace($mail) -or [string]::IsNullOrWhiteSpace($pass)) {
        return @{ ok = $false; msg = '请填写邮箱和密码'; hint = '' }
    }
    try {
        $body = @{ email = $mail.Trim(); password = $pass } | ConvertTo-Json -Compress
        $r = Invoke-RestMethod -Uri "$base/api/v1/auth/login" -Method POST -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30 -ErrorAction Stop
    } catch {
        $status = 0; $json = $null
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            try {
                $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
                $json = $sr.ReadToEnd() | ConvertFrom-Json
            } catch { }
        }
        $c = Classify $status $json $_.Exception.Message
        return $c
    }
    $d = $r.data
    if (-not $d -or -not $d.refresh_token) {
        return @{ ok = $false; msg = '登录响应缺少 refresh_token'; hint = '面板接口可能改版。' }
    }
    try { Save-Token $d.refresh_token } catch { return @{ ok = $false; msg = '写入凭据失败'; hint = $_.Exception.Message } }
    $balance = $null
    try {
        $p = Invoke-RestMethod -Uri "$base/api/v1/user/profile" -Headers @{ Authorization = "Bearer $($d.access_token)" } -TimeoutSec 20 -ErrorAction Stop
        $balance = $p.data.balance
    } catch { }
    return @{ ok = $true; msg = '登录成功'; balance = $balance; email = $mail.Trim() }
}

# ── Headless（测试/自动化）───────────────────────────────────────────
if ($Headless) {
    $r = Invoke-PanelLogin $Email $Password
    $out = @{ ok = $r.ok; message = $r.msg; hint = $r.hint; balance = $r.balance }
    $out | ConvertTo-Json -Compress
    if ($r.ok) { Save-LoginInfo $Email.Trim(); exit 0 } else { exit 2 }
}

# ── 图形界面 ────────────────────────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'HotDogAPI 一键登录'
$form.Size = New-Object System.Drawing.Size(460, 300)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$note = New-Object System.Windows.Forms.Label
$note.Text = "用面板账号密码换 token，保存到 DSH 凭据后即可在看板看到金额。`r`n密码只在本机内存里用一次，不写入磁盘。"
$note.Location = New-Object System.Drawing.Point(20, 15)
$note.Size = New-Object System.Drawing.Size(410, 42)
$form.Controls.Add($note)

$lblEmail = New-Object System.Windows.Forms.Label
$lblEmail.Text = '面板邮箱'
$lblEmail.Location = New-Object System.Drawing.Point(20, 65)
$lblEmail.Size = New-Object System.Drawing.Size(70, 22)
$form.Controls.Add($lblEmail)

$txtEmail = New-Object System.Windows.Forms.TextBox
$txtEmail.Location = New-Object System.Drawing.Point(95, 62)
$txtEmail.Size = New-Object System.Drawing.Size(330, 24)
$txtEmail.Text = Get-RememberedEmail
$form.Controls.Add($txtEmail)

$lblPass = New-Object System.Windows.Forms.Label
$lblPass.Text = '密码'
$lblPass.Location = New-Object System.Drawing.Point(20, 103)
$lblPass.Size = New-Object System.Drawing.Size(70, 22)
$form.Controls.Add($lblPass)

$txtPass = New-Object System.Windows.Forms.TextBox
$txtPass.Location = New-Object System.Drawing.Point(95, 100)
$txtPass.Size = New-Object System.Drawing.Size(330, 24)
$txtPass.UseSystemPasswordChar = $true
$form.Controls.Add($txtPass)

$chkRemember = New-Object System.Windows.Forms.CheckBox
$chkRemember.Text = '记住邮箱（只存邮箱，不存密码）'
$chkRemember.Location = New-Object System.Drawing.Point(95, 130)
$chkRemember.Size = New-Object System.Drawing.Size(300, 24)
$chkRemember.Checked = $true
$form.Controls.Add($chkRemember)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = '登录并保存'
$btn.Location = New-Object System.Drawing.Point(95, 165)
$btn.Size = New-Object System.Drawing.Size(150, 32)
$form.Controls.Add($btn)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = '关闭'
$btnClose.Location = New-Object System.Drawing.Point(255, 165)
$btnClose.Size = New-Object System.Drawing.Size(80, 32)
$form.Controls.Add($btnClose)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(20, 205)
$status.Size = New-Object System.Drawing.Size(410, 46)
$status.ForeColor = [System.Drawing.Color]::DimGray
$form.Controls.Add($status)

$btnClose.Add_Click({ $form.Close() })
$form.AcceptButton = $btn

$btn.Add_Click({
    $status.ForeColor = [System.Drawing.Color]::DimGray
    $status.Text = '登录中…'
    $btn.Enabled = $false
    [System.Windows.Forms.Application]::DoEvents()
    $r = Invoke-PanelLogin $txtEmail.Text $txtPass.Text
    if ($r.ok) {
        if ($chkRemember.Checked) { Save-LoginInfo $txtEmail.Text.Trim() }
        $bal = if ($r.balance -ne $null) { "，余额 `$$([math]::Round([double]$r.balance, 2))" } else { '' }
        $status.ForeColor = [System.Drawing.Color]::ForestGreen
        $status.Text = "✅ 登录成功$bal`r`n凭据已保存，DSH 看板会在 60 秒内刷新（或重启 DSH 立即生效）。"
        $txtPass.Text = ''
        $btn.Enabled = $true
        Start-Sleep -Milliseconds 1200
        $form.Close()
    } else {
        $status.ForeColor = [System.Drawing.Color]::Firebrick
        $status.Text = "❌ $($r.msg)" + $(if ($r.hint) { "`r`n建议：$($r.hint)" } else { '' })
        $btn.Enabled = $true
    }
})

[void]$form.ShowDialog()
