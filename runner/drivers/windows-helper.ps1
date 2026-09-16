# Desktop primitives for the Windows driver.
#
# Probed on windows-2025: the runner session is interactive, CopyFromScreen
# returns a real 1024x768 desktop, SendKeys is delivered, and the UI Automation
# root is reachable. Mouse input needs SendInput from user32, which SendKeys
# does not cover.

param(
    [Parameter(Mandatory = $true)][string]$Action,
    [string]$Arg1,
    [string]$Arg2,
    [string]$Arg3
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class VsimInput {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    public const int MINIMIZE = 6, RESTORE = 9;
    const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
    const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
    public static void Click(int x, int y, string button) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(40);
        uint down = LEFTDOWN, up = LEFTUP;
        if (button == "right") { down = RIGHTDOWN; up = RIGHTUP; }
        else if (button == "middle") { down = MIDDLEDOWN; up = MIDDLEUP; }
        mouse_event(down, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        mouse_event(up, 0, 0, 0, UIntPtr.Zero);
    }
}
'@

function Get-Bounds { [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }

switch ($Action) {
    'prepare' {
        # The runner's own agent console sits on top of the desktop and swallows
        # every click and keystroke aimed at an app underneath it. Get it out of
        # the way once, at session start, rather than making every flow do it.
        Get-Process |
            Where-Object { $_.MainWindowTitle -like '*HostedComputeAgent*' -or $_.MainWindowTitle -like '*hosted-compute-agent*' } |
            ForEach-Object { [void][VsimInput]::ShowWindow($_.MainWindowHandle, [VsimInput]::MINIMIZE) }
        $b = Get-Bounds
        @{ os = 'windows'; display = 'session-interactive'; width = $b.Width; height = $b.Height } |
            ConvertTo-Json -Compress
    }
    'focus' {
        # Windows blocks a background process from stealing focus, so
        # SetForegroundWindow alone fails. AppActivate goes through the shell,
        # which is allowed.
        $p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Arg1*" } | Select-Object -First 1
        if (-not $p) { throw "no window matching: $Arg1" }
        [void][VsimInput]::ShowWindow($p.MainWindowHandle, [VsimInput]::RESTORE)
        [void][VsimInput]::SetForegroundWindow($p.MainWindowHandle)
        [void](New-Object -ComObject WScript.Shell).AppActivate($p.Id)
        @{ focused = $p.MainWindowTitle } | ConvertTo-Json -Compress
    }
    'info' {
        $b = Get-Bounds
        @{ os = 'windows'; display = 'session0-interactive'; width = $b.Width; height = $b.Height } |
            ConvertTo-Json -Compress
    }
    'screenshot' {
        $b = Get-Bounds
        $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
        $bmp.Save($Arg1, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
    }
    'move' { [void][VsimInput]::SetCursorPos([int]$Arg1, [int]$Arg2) }
    'click' { [VsimInput]::Click([int]$Arg1, [int]$Arg2, $(if ($Arg3) { $Arg3 } else { 'left' })) }
    'type' {
        # SendKeys treats these as control characters; send them literally.
        $escaped = [regex]::Replace($Arg1, '[+^%~(){}\[\]]', '{$0}')
        [System.Windows.Forms.SendKeys]::SendWait($escaped)
    }
    'key' {
        $map = @{
            'return' = '{ENTER}'; 'enter' = '{ENTER}'; 'tab' = '{TAB}'; 'escape' = '{ESC}'; 'esc' = '{ESC}'
            'space' = ' '; 'backspace' = '{BACKSPACE}'; 'delete' = '{DELETE}'
            'up' = '{UP}'; 'down' = '{DOWN}'; 'left' = '{LEFT}'; 'right' = '{RIGHT}'; 'home' = '{HOME}'; 'end' = '{END}'
        }
        $prefix = ''
        $key = ''
        foreach ($part in $Arg1.ToLower().Split('+')) {
            switch ($part) {
                'ctrl' { $prefix += '^' }
                'control' { $prefix += '^' }
                'alt' { $prefix += '%' }
                'shift' { $prefix += '+' }
                'win' { $prefix += '' }
                default { $key = $(if ($map.ContainsKey($part)) { $map[$part] } else { $part }) }
            }
        }
        [System.Windows.Forms.SendKeys]::SendWait("$prefix$key")
    }
    'tree' {
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $nodes = @()
        $child = $walker.GetFirstChild($root)
        while ($child -ne $null) {
            $c = $child.Current
            $r = $c.BoundingRectangle
            $nodes += @{
                name    = $c.Name
                type    = $c.ControlType.ProgrammaticName
                class   = $c.ClassName
                x       = [int]$r.X; y = [int]$r.Y
                width   = [int]$r.Width; height = [int]$r.Height
                enabled = $c.IsEnabled
            }
            $child = $walker.GetNextSibling($child)
        }
        @{ kind = 'windows-uiautomation'; windows = $nodes } | ConvertTo-Json -Compress -Depth 4
    }
    default { throw "unknown action: $Action" }
}
