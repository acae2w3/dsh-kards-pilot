# KARDS pilot — Windows input/vision helper.
# Long-lived process speaking newline-delimited JSON on stdin/stdout.
# Request:  {"id":1,"op":"shot","path":"...","maxWidth":1200}
# Response: {"id":1,"ok":true,"data":{...}}  |  {"id":1,"ok":false,"error":"..."}
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class KW {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
}
'@

[void][KW]::SetProcessDPIAware()

$sw = [System.Windows.Forms.SystemInformation]
$script:VScreen = $sw::VirtualScreen
$script:DPI = $null

$VK = @{
  'backspace'=8; 'tab'=9; 'enter'=13; 'return'=13; 'shift'=16; 'ctrl'=17; 'control'=17; 'alt'=18
  'pause'=19; 'capslock'=20; 'esc'=27; 'escape'=27; 'space'=32; 'pageup'=33; 'pagedown'=34
  'end'=35; 'home'=36; 'left'=37; 'up'=38; 'right'=39; 'down'=40; 'insert'=45; 'delete'=46
  'win'=91; 'lwin'=91; 'numlock'=144; 'scrolllock'=145
  'f1'=112; 'f2'=113; 'f3'=114; 'f4'=115; 'f5'=116; 'f6'=117; 'f7'=118; 'f8'=119; 'f9'=120
  'f10'=121; 'f11'=122; 'f12'=123
  '+'=187; '='=187; '-'=189; ','=188; '.'=190; '/'=191; ';'=186; ''''=222; '['=219; ']'=221; '\'=220
}
$MOUSEEVENTF = @{ LEFT_DOWN=2; LEFT_UP=4; RIGHT_DOWN=8; RIGHT_UP=16; MIDDLE_DOWN=32; MIDDLE_UP=64; WHEEL=2048 }
$KEYEVENTF = @{ KEYUP=2 }

function Get-WinText([IntPtr]$h) {
  $len = [KW]::GetWindowTextLengthW($h)
  if ($len -le 0) { return '' }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][KW]::GetWindowTextW($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

function Get-SettledRect([IntPtr]$hwnd) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds(1200)
  while ([DateTime]::UtcNow -lt $deadline) {
    $r = Get-WinRect $hwnd
    if ($r -and $r.width -gt 40 -and $r.height -gt 40 -and $r.x -gt -30000) { return $r }
    Start-Sleep -Milliseconds 80
  }
  return (Get-WinRect $hwnd)
}

function Get-WinRect([IntPtr]$h) {
  $r = New-Object KW+RECT
  if (-not [KW]::GetWindowRect($h, [ref]$r)) { return $null }
  return @{ x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
}

function Get-Windows {
  $list = New-Object System.Collections.ArrayList
  $fg = [KW]::GetForegroundWindow()
  $cb = [KW+EnumProc] {
    param([IntPtr]$h, [IntPtr]$p)
    try {
      $visible = [KW]::IsWindowVisible($h)
      if ($script:ListAllWindows -or $visible) {
        $t = Get-WinText $h
        if ($t -and $t.Trim().Length -gt 0) {
          $r = Get-WinRect $h
          $minimized = [KW]::IsIconic($h)
          if ($r -and ($minimized -or ($r.width -gt 40 -and $r.height -gt 40))) {
            $procId = 0
            [void][KW]::GetWindowThreadProcessId($h, [ref]$procId)
            [void]$list.Add([pscustomobject]@{
              title = $t; pid = $procId; hwnd = [int64]$h
              x = $r.x; y = $r.y; width = $r.width; height = $r.height
              visible = $visible
              minimized = $minimized
              foreground = ([int64]$h -eq [int64]$fg)
            })
          }
        }
      }
    } catch { }
    return $true
  }
  [void][KW]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

function Find-Window([string]$needle, [bool]$includeHidden) {
  if (-not $needle) { return $null }
  $script:ListAllWindows = $true
  try { $w = Get-Windows } finally { $script:ListAllWindows = $false }
  $n = $needle.Trim().ToLowerInvariant()
  $best = $null
  $bestScore = -9999
  foreach ($c in $w) {
    $t = ([string]$c.title).Trim()
    $tl = $t.ToLowerInvariant()
    if ($tl -eq $n) { $score = 100 }
    elseif ($tl.StartsWith($n)) { $score = 50 }
    elseif ($tl.Contains($n)) { $score = 10 }
    else { continue }
    if ($c.visible) { $score += 20 }
    if ($c.foreground) { $score += 30 }
    if ($c.minimized) { $score -= 10 }
    if ($c.width -gt 800 -and $c.height -gt 500) { $score += 5 }
    if ($c.width -lt 200 -or $c.height -lt 200) { $score -= 60 }   # small helper/overlay windows never shadow the game
    if ($score -gt $bestScore) { $bestScore = $score; $best = $c }
  }
  return $best
}

function Focus-Window($win) {
  if (-not $win) { return $false }
  $h = [IntPtr]$win.hwnd
  if (-not [KW]::IsWindowVisible($h)) { [void][KW]::ShowWindow($h, 5) }   # SW_SHOW
  elseif ([KW]::IsIconic($h)) { [void][KW]::ShowWindow($h, 9) }          # SW_RESTORE
  [void][KW]::BringWindowToTop($h)
  [void][KW]::SetForegroundWindow($h)
  $deadline = [DateTime]::UtcNow.AddMilliseconds(700)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ([int64][KW]::GetForegroundWindow() -eq $win.hwnd) { return $true }
    Start-Sleep -Milliseconds 40
  }
  return ([int64][KW]::GetForegroundWindow() -eq $win.hwnd)
}

function Save-Scaled($bmp, [string]$path, [int]$maxWidth) {
  $w = $bmp.Width; $h = $bmp.Height
  if ($maxWidth -gt 0 -and $w -gt $maxWidth) {
    $nw = $maxWidth
    $nh = [int][Math]::Max(1, [Math]::Round($h * $maxWidth / $w))
    $small = New-Object System.Drawing.Bitmap($nw, $nh)
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g2.DrawImage($bmp, 0, 0, $nw, $nh)
    $small.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g2.Dispose(); $small.Dispose()
    return @{ width = $nw; height = $nh }
  }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  return @{ width = $w; height = $h }
}

function Do-Capture([int]$x, [int]$y, [int]$w, [int]$h, [string]$path, [int]$maxWidth) {
  if ($w -le 0 -or $h -le 0) { throw "invalid capture region ${w}x${h}" }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)), [System.Drawing.CopyPixelOperation]::SourceCopy)
    $g.Dispose()
    $out = Save-Scaled $bmp $path $maxWidth
    return @{ width = $out.width; height = $out.height; sourceWidth = $w; sourceHeight = $h }
  } finally {
    if ($g) { $g.Dispose() }
    $bmp.Dispose()
  }
}

function Get-KeyVk([string]$name) {
  $n = $name.ToLowerInvariant()
  if ($VK.ContainsKey($n)) { return [int]$VK[$n] }
  if ($n.Length -eq 1) {
    $c = $n.ToUpperInvariant()[0]
    if ([char]::IsLetterOrDigit($c)) { return [int][char]$c }
  }
  throw "unknown key name: $name"
}

function Send-Keys([string]$combo) {
  $parts = $combo -split '\+'
  $codes = @()
  foreach ($p in $parts) { $codes += (Get-KeyVk $p.Trim()) }
  foreach ($c in $codes) { [KW]::keybd_event([byte]$c, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 25 }
  [array]::Reverse($codes)
  foreach ($c in $codes) { [KW]::keybd_event([byte]$c, 0, [uint32]$KEYEVENTF.KEYUP, [IntPtr]::Zero); Start-Sleep -Milliseconds 25 }
}

function Invoke-Op($req) {
  $op = [string]$req.op
  switch ($op) {
    'ping' { return @{ pong = $true } }
    'info' {
      $p = [KW+POINT]::new()
      [void][KW]::GetCursorPos([ref]$p)
      $primary = $sw::PrimaryMonitorSize
      return @{
        screen = @{ x = $script:VScreen.X; y = $script:VScreen.Y; width = $script:VScreen.Width; height = $script:VScreen.Height }
        primary = @{ width = $primary.Width; height = $primary.Height }
        cursor = @{ x = $p.X; y = $p.Y }
        dpiAware = $true
        os = [System.Environment]::OSVersion.VersionString
      }
    }
    'windows' {
      $script:ListAllWindows = [bool]$req.all
      try { $list = @(Get-Windows) } finally { $script:ListAllWindows = $false }
      return @{ windows = $list }
    }
    'focus' {
      $win = Find-Window ([string]$req.title) $true
      if (-not $win) { throw "no window matches '$($req.title)'" }
      $focused = Focus-Window $win
      Start-Sleep -Milliseconds 150
      $r = Get-SettledRect ([IntPtr]$win.hwnd)
      return @{ focused = $focused; title = $win.title; visible = [KW]::IsWindowVisible([IntPtr]$win.hwnd); rect = $r }
    }
    'shot' {
      $maxWidth = 0
      if ($req.maxWidth) { $maxWidth = [int]$req.maxWidth }
      if ($req.method -eq 'print' -and $req.title) {
        $win = Find-Window ([string]$req.title) $true
        if (-not $win) { throw "no window matches '$($req.title)'" }
        $r = Get-WinRect ([IntPtr]$win.hwnd)
        if (-not $r -or $r.width -le 0 -or $r.height -le 0) { throw "could not read the rect of '$($win.title)'" }
        $bmp = New-Object System.Drawing.Bitmap($r.width, $r.height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $printed = $false
        try { $printed = [KW]::PrintWindow([IntPtr]$win.hwnd, $hdc, 2) } finally { $g.ReleaseHdc($hdc) }
        $g.Dispose()
        if (-not $printed) { $bmp.Dispose(); throw "PrintWindow refused for '$($win.title)'" }
        $cap = Save-Scaled $bmp ([string]$req.path) $maxWidth
        $bmp.Dispose()
        return @{
          path = [string]$req.path
          imageWidth = $cap.width; imageHeight = $cap.height
          regionX = $r.x; regionY = $r.y
          regionWidth = $r.width; regionHeight = $r.height
          scaleX = ($r.width / $cap.width); scaleY = ($r.height / $cap.height)
          method = 'print'
        }
      }
      $region = $null
      if ($req.title) {
        $win = Find-Window ([string]$req.title) $true
        if (-not $win) { throw "no window matches '$($req.title)'" }
        if (-not $req.keepFocus) { [void](Focus-Window $win) }
        Start-Sleep -Milliseconds 120
        $r = Get-SettledRect ([IntPtr]$win.hwnd)
        if (-not $r -or $r.width -le 40 -or $r.height -le 40) { throw "window '$($win.title)' did not restore to a capturable size (rect $($r.x),$($r.y) $($r.width)x$($r.height))" }
        $region = $r
      } else {
        $region = @{ x = $script:VScreen.X; y = $script:VScreen.Y; width = $script:VScreen.Width; height = $script:VScreen.Height }
      }
      $cap = Do-Capture $region.x $region.y $region.width $region.height ([string]$req.path) $maxWidth
      $scaleX = $cap.sourceWidth / $cap.width
      $scaleY = $cap.sourceHeight / $cap.height
      return @{
        path = [string]$req.path
        imageWidth = $cap.width; imageHeight = $cap.height
        regionX = $region.x; regionY = $region.y
        regionWidth = $cap.sourceWidth; regionHeight = $cap.sourceHeight
        scaleX = $scaleX; scaleY = $scaleY
      }
    }
    'mouse' {
      $x = [int]$req.x; $y = [int]$req.y
      if (-not [KW]::SetCursorPos($x, $y)) { throw "SetCursorPos($x,$y) failed" }
      $action = [string]$req.action
      $delay = 60
      if ($req.delayMs) { $delay = [int]$req.delayMs }
      Start-Sleep -Milliseconds 30
      $down = $MOUSEEVENTF.LEFT_DOWN; $up = $MOUSEEVENTF.LEFT_UP
      if ($action -eq 'right_click' -or $action -eq 'right') { $down = $MOUSEEVENTF.RIGHT_DOWN; $up = $MOUSEEVENTF.RIGHT_UP }
      if ($action -eq 'click' -or $action -eq 'right_click' -or $action -eq 'right') {
        [KW]::mouse_event([uint32]$down, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds $delay
        [KW]::mouse_event([uint32]$up, 0, 0, 0, [IntPtr]::Zero)
      } elseif ($action -eq 'double_click' -or $action -eq 'double') {
        for ($i = 0; $i -lt 2; $i++) {
          [KW]::mouse_event([uint32]$down, 0, 0, 0, [IntPtr]::Zero)
          Start-Sleep -Milliseconds 40
          [KW]::mouse_event([uint32]$up, 0, 0, 0, [IntPtr]::Zero)
          if ($i -eq 0) { Start-Sleep -Milliseconds 70 }
        }
      } elseif ($action -eq 'move') {
        # positioned above; nothing else to do
      } else { throw "unsupported mouse action '$action'" }
      Start-Sleep -Milliseconds 40
      $p = [KW+POINT]::new(); [void][KW]::GetCursorPos([ref]$p)
      return @{ x = $p.X; y = $p.Y }
    }
    'drag' {
      $x1 = [int]$req.x; $y1 = [int]$req.y
      $x2 = [int]$req.toX; $y2 = [int]$req.toY
      $steps = 12
      if ($req.steps) { $steps = [Math]::Max(2, [int]$req.steps) }
      $duration = 260
      if ($req.durationMs) { $duration = [int]$req.durationMs }
      $pause = [int][Math]::Max(1, [Math]::Floor($duration / $steps))
      if (-not [KW]::SetCursorPos($x1, $y1)) { throw "SetCursorPos($x1,$y1) failed" }
      Start-Sleep -Milliseconds 80
      [KW]::mouse_event([uint32]$MOUSEEVENTF.LEFT_DOWN, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 90
      for ($i = 1; $i -le $steps; $i++) {
        $nx = [int][Math]::Round($x1 + ($x2 - $x1) * $i / $steps)
        $ny = [int][Math]::Round($y1 + ($y2 - $y1) * $i / $steps)
        [void][KW]::SetCursorPos($nx, $ny)
        Start-Sleep -Milliseconds $pause
      }
      Start-Sleep -Milliseconds 90
      [KW]::mouse_event([uint32]$MOUSEEVENTF.LEFT_UP, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 60
      return @{ x = $x2; y = $y2 }
    }
    'wheel' {
      $delta = -120
      if ($req.delta) { $delta = [int]$req.delta }
      [KW]::mouse_event([uint32]$MOUSEEVENTF.WHEEL, 0, 0, [uint32]$delta, [IntPtr]::Zero)
      return @{ delta = $delta }
    }
    'key' {
      Send-Keys ([string]$req.keys)
      return @{ keys = [string]$req.keys }
    }
    'sleep' {
      $ms = 300; if ($req.ms) { $ms = [int]$req.ms }
      Start-Sleep -Milliseconds $ms
      return @{ sleptMs = $ms }
    }
    'quit' { return @{ bye = $true } }
    default { throw "unknown op '$op'" }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $data = Invoke-Op $req
    $resp = @{ id = $id; ok = $true; data = $data }
    $stop = ([string]$req.op -eq 'quit')
  } catch {
    $resp = @{ id = $id; ok = $false; error = $_.Exception.Message }
    $stop = $false
  }
  $json = $resp | ConvertTo-Json -Depth 8 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
  if ($stop) { break }
}
