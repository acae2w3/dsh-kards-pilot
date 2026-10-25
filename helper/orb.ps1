# KARDS pilot — desktop floating ball (always-on-top, borderless, circular).
#
# A standalone WinForms process. The host plugin owns its lifetime and talks to
# it through small JSON files, so the ball can sit above a fullscreen game where
# a web overlay cannot:
#
#   $StatePath    written by the host  -> {"phase":"idle|waking|active|error","label":"..."}
#   $CommandPath  written by the ball  -> {"action":"toggle|wake|stop","at":<ms>}
#   $PosPath      remembered position  -> {"x":..,"y":..}
#
# The window is a locked square with a magenta transparency key, so the corners
# are simply transparent (a Region would have to agree with the client size at
# every DPI).
#
# Single instance: a second launch (for example the plugin starting it while a
# hand-started copy still runs) exits immediately and the running one serves.
#
# NOTE: keep this file UTF-8 **with BOM** — Windows PowerShell 5.1 otherwise
# reads the Chinese strings as ANSI and fails to parse.
param(
  [Parameter(Mandatory = $true)][string]$StatePath,
  [Parameter(Mandatory = $true)][string]$CommandPath,
  [string]$PosPath = '',
  [int]$Size = 76
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\dsh-kards-orb', [ref]$created)
if (-not $created) { return }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class OrbWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][OrbWin]::SetProcessDPIAware()

# ---- state -----------------------------------------------------------------
$script:Phase = 'idle'
$script:Label = '进入对局'
$script:Hi    = [System.Drawing.Color]::FromArgb(59, 143, 230)
$script:Lo    = [System.Drawing.Color]::FromArgb(10, 47, 94)
$script:Dot   = [System.Drawing.Color]::FromArgb(150, 158, 170)
$script:Pulse = 0
$script:LastRaw = ''
$script:DownPos = $null
$script:Dragging = $false
$script:WinPos = $null

function Update-Palette {
  switch ($script:Phase) {
    'active' { $script:Hi = [System.Drawing.Color]::FromArgb(70, 211, 138); $script:Lo = [System.Drawing.Color]::FromArgb(10, 92, 54);  $script:Dot = [System.Drawing.Color]::FromArgb(58, 200, 120) }
    'waking' { $script:Hi = [System.Drawing.Color]::FromArgb(242, 199, 107); $script:Lo = [System.Drawing.Color]::FromArgb(109, 71, 8); $script:Dot = [System.Drawing.Color]::FromArgb(232, 169, 60) }
    'error'  { $script:Hi = [System.Drawing.Color]::FromArgb(241, 142, 142); $script:Lo = [System.Drawing.Color]::FromArgb(102, 23, 23); $script:Dot = [System.Drawing.Color]::FromArgb(220, 70, 70) }
    default  { $script:Hi = [System.Drawing.Color]::FromArgb(59, 143, 230); $script:Lo = [System.Drawing.Color]::FromArgb(10, 47, 94);  $script:Dot = [System.Drawing.Color]::FromArgb(150, 158, 170) }
  }
}

function Save-Position($point) {
  if (-not $PosPath) { return }
  try {
    [System.IO.File]::WriteAllText($PosPath, ('{"x":' + $point.X + ',"y":' + $point.Y + '}'))
  } catch { }
}

function Get-SavedPosition {
  if (-not $PosPath -or -not (Test-Path $PosPath)) { return $null }
  try {
    $j = [System.IO.File]::ReadAllText($PosPath) | ConvertFrom-Json
    $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
    if ($j.x -lt $screen.X - 40 -or $j.y -lt $screen.Y - 40) { return $null }
    if ($j.x -gt $screen.Right - 20 -or $j.y -gt $screen.Bottom - 20) { return $null }
    return (New-Object System.Drawing.Point([int]$j.x, [int]$j.y))
  } catch { return $null }
}

function Show-Host {
  try {
    $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $proc) { return }
    $h = $proc.MainWindowHandle
    if ([OrbWin]::IsIconic($h)) { [void][OrbWin]::ShowWindow($h, 9) }
    [void][OrbWin]::ShowWindow($h, 5)
    [void][OrbWin]::SetForegroundWindow($h)
  } catch { }
}

function Send-Command([string]$action) {
  try {
    $payload = '{"action":"' + $action + '","at":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '}'
    [System.IO.File]::WriteAllText($CommandPath, $payload)
  } catch { }
  # No host has refreshed the state file for a while: nobody is listening yet,
  # so fall back to raising the Harness window where the in-page ball lives.
  $fresh = $false
  try {
    if (Test-Path $StatePath) { $fresh = ((Get-Date) - (Get-Item $StatePath).LastWriteTime).TotalSeconds -lt 12 }
  } catch { }
  if (-not $fresh) { Show-Host }
}

# ---- window ----------------------------------------------------------------
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.MinimizeBox = $false
$form.MaximizeBox = $false
$form.Text = 'KARDS 悬浮球'
$form.BackColor = [System.Drawing.Color]::Fuchsia
$form.TransparencyKey = [System.Drawing.Color]::Fuchsia
$form.MinimumSize = New-Object System.Drawing.Size($Size, $Size)
$form.MaximumSize = New-Object System.Drawing.Size($Size, $Size)
$form.ClientSize = New-Object System.Drawing.Size($Size, $Size)

$saved = Get-SavedPosition
if ($saved) {
  $form.Location = $saved
} else {
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Location = New-Object System.Drawing.Point(($area.Right - $Size - 24), ($area.Y + [int]($area.Height * 0.34)))
}

$tip = New-Object System.Windows.Forms.ToolTip
$tip.SetToolTip($form, '点一下：唤醒智能体打这局 KARDS · 拖动可移动 · 右键：菜单')

$form.Add_Paint({
    param($s, $e)
    $g = $e.Graphics
    # No anti-aliasing on the silhouette: blended edge pixels are not the exact
    # transparency key, so they would show up as a coloured fringe.
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
    $sz = [float]$s.ClientSize.Width
    $pad = [float]5
    $rect = New-Object System.Drawing.RectangleF($pad, $pad, ($sz - $pad * 2), ($sz - $pad * 2))

    if ($script:Phase -eq 'active' -or $script:Phase -eq 'waking') {
      $t = ($script:Pulse % 12) / 12.0
      $radius = ($sz / 2.0) - 1.5 - $t * 4
      $alpha = [int](130 - $t * 100)
      $ring = New-Object System.Drawing.Pen(([System.Drawing.Color]::FromArgb($alpha, $script:Hi.R, $script:Hi.G, $script:Hi.B)), 2)
      $g.DrawEllipse($ring, [float](($sz / 2.0) - $radius), [float](($sz / 2.0) - $radius), [float]($radius * 2), [float]($radius * 2))
      $ring.Dispose()
    }

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse($rect)
    $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
    $brush.CenterPoint = New-Object System.Drawing.PointF([float]($sz * 0.36), [float]($sz * 0.30))
    $brush.CenterColor = $script:Hi
    $brush.SurroundColors = @($script:Lo)
    $g.FillPath($brush, $path)

    $rim = New-Object System.Drawing.Pen(([System.Drawing.Color]::FromArgb(95, 255, 255, 255)), 1.2)
    $g.DrawEllipse($rim, $rect)
    $rim.Dispose()

    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $c = $sz / 2.0
    $ink = New-Object System.Drawing.Pen(([System.Drawing.Color]::FromArgb(242, 255, 255, 255)), 2.4)
    $ink.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $ink.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawEllipse($ink, [float]($c - 9.5), [float]($c - 9.5), 19, 19)
    $g.DrawLine($ink, [float]$c, [float]($c - 17), [float]$c, [float]($c - 12))
    $g.DrawLine($ink, [float]$c, [float]($c + 12), [float]$c, [float]($c + 17))
    $g.DrawLine($ink, [float]($c - 17), [float]$c, [float]($c - 12), [float]$c)
    $g.DrawLine($ink, [float]($c + 12), [float]$c, [float]($c + 17), [float]$c)
    $ink.Dispose()

    $dot = New-Object System.Drawing.SolidBrush($script:Dot)
    $g.FillEllipse($dot, [float]($sz - 21), [float]($sz - 21), 12, 12)
    $dot.Dispose()
    $path.Dispose()
})

$form.Add_MouseDown({
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      $script:Dragging = $false
      $script:DownPos = [System.Windows.Forms.Cursor]::Position
      $script:WinPos = $s.Location
    }
})

$form.Add_MouseMove({
    param($s, $e)
    if ($null -eq $script:DownPos) { return }
    $cur = [System.Windows.Forms.Cursor]::Position
    $dx = $cur.X - $script:DownPos.X
    $dy = $cur.Y - $script:DownPos.Y
    if (-not $script:Dragging -and ([Math]::Abs($dx) + [Math]::Abs($dy)) -gt 4) { $script:Dragging = $true }
    if ($script:Dragging) { $s.Location = New-Object System.Drawing.Point(($script:WinPos.X + $dx), ($script:WinPos.Y + $dy)) }
})

$form.Add_MouseUp({
    param($s, $e)
    if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
    $moved = $script:Dragging
    $script:DownPos = $null
    $script:Dragging = $false
    if ($moved) { Save-Position $s.Location } else { Send-Command 'toggle' }
})

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemToggle = $menu.Items.Add('唤醒 / 结束对局')
$itemToggle.Add_Click({ Send-Command 'toggle' })
$itemShow = $menu.Items.Add('切到 Harness 窗口')
$itemShow.Add_Click({ Show-Host })
$itemHide = $menu.Items.Add('收起悬浮球（重启后回来）')
$itemHide.Add_Click({ $form.Hide() })
$itemQuit = $menu.Items.Add('退出悬浮球')
$itemQuit.Add_Click({ $form.Close() })
$form.ContextMenuStrip = $menu

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.Add_Tick({
    $repaint = $false
    try {
      if (Test-Path $StatePath) {
        $raw = [System.IO.File]::ReadAllText($StatePath)
        if ($raw -ne $script:LastRaw) {
          $script:LastRaw = $raw
          $j = $raw | ConvertFrom-Json
          if ($j.phase -and [string]$j.phase -ne $script:Phase) { $script:Phase = [string]$j.phase; $repaint = $true }
          if ($null -ne $j.label) { $script:Label = [string]$j.label }
          Update-Palette
          $tip.SetToolTip($form, $script:Label + ' · 拖动可移动 · 右键：菜单')
        }
      }
    } catch { }
    if ($script:Phase -eq 'active' -or $script:Phase -eq 'waking') { $script:Pulse++; $repaint = $true }
    if ($repaint) { $form.Invalidate() }
})
$timer.Start()

[void]$form.Show()
# Startup diagnostic: proves the geometry this process actually got.
try {
  [System.IO.File]::WriteAllText(($StatePath + '.log'), ('client=' + $form.ClientSize.Width + 'x' + $form.ClientSize.Height + ' window=' + $form.Width + 'x' + $form.Height + ' at=' + $form.Location.X + ',' + $form.Location.Y + ' dpi-aware=1'))
} catch { }

[System.Windows.Forms.Application]::Run($form)
