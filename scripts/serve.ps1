# 乡野星图 · 本地服务模式
# 用最小的 TcpListener 起一个只监听 127.0.0.1 的静态服务，再用 Edge/Chrome 的
# “应用窗口”打开。相比直接打开 html 文件，http://127.0.0.1 属于安全上下文，
# 浏览器才允许调用麦克风（语音提问）、剪贴板和 Service Worker。
# 全部在本机运行，不监听外网网卡，不联网。
param(
  [switch]$NoBrowser,
  [switch]$Demo,
  [int]$Port = 0,
  [int]$IdleMinutes = 30,
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# 用 -File 启动时 $PSScriptRoot 可用；被 IEX / 脚本块调用时可能为空，做一层兜底
$here = if ($PSScriptRoot) {
  $PSScriptRoot
} elseif ($MyInvocation.MyCommand.Path) {
  Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
  (Get-Location).Path
}
$root = if ($Root) { $Root } else { Join-Path $here 'App' }

if (-not (Test-Path -LiteralPath (Join-Path $root 'index.html'))) {
  Write-Host '没找到 App\index.html，请把整个文件夹一起拷走。'
  exit 1
}

# 端口：优先复用上次成功的端口
# 原因：浏览器按「协议+主机+端口」隔离本地存储，端口一变，账号和记录就"看不见"了。
# 所以这里固定优先 8765，并把上次成功的端口记下来，下次继续用同一个。
$stateDir = Join-Path $env:LOCALAPPDATA 'XiangYeXingTu'
try { if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null } } catch {}
$portFile = Join-Path $stateDir 'serve-port.txt'

function Test-OurApp([int]$p) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/index.html" -UseBasicParsing -TimeoutSec 1
    return ($r.StatusCode -eq 200 -and $r.Content -match '乡野星图')
  } catch { return $false }
}

# 已经在跑就直接开窗口，不再起第二个服务（避免端口漂移，也避免两份数据）
$running = 0
$probe = @()
if ($Port -gt 0) { $probe += $Port } else {
  if (Test-Path -LiteralPath $portFile) {
    try { $saved = [int]((Get-Content -LiteralPath $portFile -ErrorAction Stop) -join '') } catch { $saved = 0 }
    if ($saved -gt 0) { $probe += $saved }
  }
  $probe += 8765..8777
}
foreach ($p in $probe) {
  if (Test-OurApp $p) { $running = $p; break }
}

if ($running -gt 0) {
  $url = "http://127.0.0.1:$running/"
  if ($Demo) { $url = "$url`?demo=1#home" }
  Write-Host "乡野星图已经在运行：$url"
  if (-not $NoBrowser) {
    $candidates = @(
      (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
    )
    $browser = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    $profileDir = Join-Path $env:LOCALAPPDATA 'XiangYeXingTu'
    if ($browser) {
      Start-Process -FilePath $browser -ArgumentList @("--app=$url", "--user-data-dir=$profileDir", '--window-size=1180,860', '--no-first-run', '--no-default-browser-check', '--lang=zh-CN') | Out-Null
    } else {
      Start-Process $url | Out-Null
    }
  }
  exit 0
}

$listener = $null
$startPort = if ($Port -gt 0) { $Port } else { 8765 }
foreach ($p in $startPort..($startPort + 12)) {
  try {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    $l.Start()
    $listener = $l
    $Port = $p
    break
  } catch {
    if ($l) { try { $l.Stop() } catch {} }
  }
}
if (-not $listener) {
  Write-Host '端口都被占用了，请关掉其他程序后重试。'
  exit 1
}
try { [System.IO.File]::WriteAllText($portFile, [string]$Port) } catch {}

$url = "http://127.0.0.1:$Port/"
if ($Demo) { $url = "$url`?demo=1#home" }
Write-Host "乡野星图已启动：$url"
Write-Host '关闭这个窗口即可停止服务。'

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.txt'  = 'text/plain; charset=utf-8'
}

if (-not $NoBrowser) {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
  )
  $browser = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  $profileDir = Join-Path $env:LOCALAPPDATA 'XiangYeXingTu'
  if ($browser) {
    Start-Process -FilePath $browser -ArgumentList @(
      "--app=$url",
      "--user-data-dir=$profileDir",
      '--window-size=1180,860',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=zh-CN'
    ) | Out-Null
  } else {
    Start-Process $url | Out-Null
  }
}

$idle = 0
$idleLimit = $IdleMinutes * 60

while ($true) {
  if ($listener.Pending()) {
    $idle = 0
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 3000
      $stream = $client.GetStream()
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 4096, $true)
      $line = $reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($line)) { $client.Close(); continue }

      $parts = $line -split ' '
      $method = $parts[0]
      $rawPath = if ($parts.Length -gt 1) { $parts[1] } else { '/' }

      # 读完请求头
      $guard = 0
      while ($guard -lt 100) {
        $h = $reader.ReadLine()
        if ($null -eq $h -or $h -eq '') { break }
        $guard++
      }

      $path = $rawPath.Split('?')[0]
      if ($path -eq '/' -or $path -eq '') { $path = '/index.html' }
      try { $path = [System.Uri]::UnescapeDataString($path) } catch {}

      $rel = $path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
      $full = Join-Path $root $rel

      $status = '200 OK'
      $body = $null
      if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        if ($path -notmatch '\.') {
          $full = Join-Path $root 'index.html'
        }
      }
      if (Test-Path -LiteralPath $full -PathType Leaf) {
        $body = [System.IO.File]::ReadAllBytes($full)
        $ext = [System.IO.Path]::GetExtension($full).ToLower()
        $ctype = $mime[$ext]
        if (-not $ctype) { $ctype = 'application/octet-stream' }
      } else {
        $status = '404 Not Found'
        $ctype = 'text/plain; charset=utf-8'
        $body = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
      }

      $head = "HTTP/1.1 $status`r`nContent-Type: $ctype`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
      $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
      $stream.Write($hb, 0, $hb.Length)
      if ($method -ne 'HEAD') { $stream.Write($body, 0, $body.Length) }
      $stream.Flush()
    } catch {
      # 单个请求出错不影响整体
    } finally {
      try { $client.Close() } catch {}
    }
  } else {
    Start-Sleep -Milliseconds 120
    $idle += 0.12
    if ($idle -gt $idleLimit) { break }
  }
}

$listener.Stop()
