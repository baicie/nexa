param(
  [Parameter(Mandatory = $true)][int] $ProcessId,
  [Parameter(Mandatory = $true)][ValidateSet("accept", "cancel")][string] $Action,
  [Parameter(Mandatory = $true)][string] $Title,
  [Parameter(Mandatory = $true)][int] $TimeoutMilliseconds,
  [string] $SelectionPath = ""
)

$ErrorActionPreference = "Stop"
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NexaDialogPickerNative {
    public delegate bool EnumWindowProc(IntPtr hwnd, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maximum);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maximum);

    [DllImport("user32.dll")]
    public static extern int GetDlgCtrlID(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    public static extern IntPtr SendMessageTimeoutPointer(
        IntPtr hwnd,
        uint message,
        IntPtr word,
        IntPtr parameter,
        uint flags,
        uint timeout,
        out IntPtr result
    );

    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeoutString(
        IntPtr hwnd,
        uint message,
        IntPtr word,
        string parameter,
        uint flags,
        uint timeout,
        out IntPtr result
    );

    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeoutBuilder(
        IntPtr hwnd,
        uint message,
        IntPtr word,
        StringBuilder parameter,
        uint flags,
        uint timeout,
        out IntPtr result
    );
}
"@

$script:automationAvailable = $false
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $script:automationAvailable = $true
} catch {
  Write-Verbose "UI Automation is unavailable: $($_.Exception.Message)"
}

function Get-RemainingMessageTimeout([string] $Operation) {
  $remaining = $TimeoutMilliseconds - $stopwatch.ElapsedMilliseconds
  if ($remaining -le 0) {
    throw "real rfd picker exhausted the timeout budget before $Operation"
  }
  return [uint32] [Math]::Max(1, [Math]::Min($remaining, 1000))
}

function Get-WindowText([IntPtr] $Handle) {
  $text = [System.Text.StringBuilder]::new(1024)
  [void] [NexaDialogPickerNative]::GetWindowText($Handle, $text, $text.Capacity)
  return $text.ToString()
}

function Get-WindowClass([IntPtr] $Handle) {
  $text = [System.Text.StringBuilder]::new(256)
  [void] [NexaDialogPickerNative]::GetClassName($Handle, $text, $text.Capacity)
  return $text.ToString()
}

function Find-DialogWindow {
  $script:found = [IntPtr]::Zero
  $callback = [NexaDialogPickerNative+EnumWindowProc] {
    param([IntPtr] $handle, [IntPtr] $parameter)
    $owner = [uint32] 0
    [void] [NexaDialogPickerNative]::GetWindowThreadProcessId($handle, [ref] $owner)
    if (
      $owner -eq [uint32] $ProcessId -and
      [NexaDialogPickerNative]::IsWindowVisible($handle) -and
      (Get-WindowClass $handle) -eq "#32770" -and
      (Get-WindowText $handle) -ceq $Title
    ) {
      $script:found = $handle
      return $false
    }
    return $true
  }
  [void] [NexaDialogPickerNative]::EnumWindows($callback, [IntPtr]::Zero)
  return $script:found
}

function Find-DialogControl([IntPtr] $Dialog, [int] $ControlId, [string[]] $ExpectedClasses) {
  $script:foundControl = [IntPtr]::Zero
  $callback = [NexaDialogPickerNative+EnumWindowProc] {
    param([IntPtr] $handle, [IntPtr] $parameter)
    if (
      [NexaDialogPickerNative]::GetDlgCtrlID($handle) -eq $ControlId -and
      $ExpectedClasses -ccontains (Get-WindowClass $handle)
    ) {
      $script:foundControl = $handle
      return $false
    }
    return $true
  }
  [void] [NexaDialogPickerNative]::EnumChildWindows($Dialog, $callback, [IntPtr]::Zero)
  return $script:foundControl
}

function Find-DescendantControl([IntPtr] $Root, [string[]] $ExpectedClasses) {
  $script:foundDescendant = [IntPtr]::Zero
  $callback = [NexaDialogPickerNative+EnumWindowProc] {
    param([IntPtr] $handle, [IntPtr] $parameter)
    if ($ExpectedClasses -ccontains (Get-WindowClass $handle)) {
      $script:foundDescendant = $handle
      return $false
    }
    return $true
  }
  [void] [NexaDialogPickerNative]::EnumChildWindows($Root, $callback, [IntPtr]::Zero)
  return $script:foundDescendant
}

function Find-FileNameControl([IntPtr] $Dialog) {
  $container = Find-DialogControl $Dialog 1148 @("ComboBoxEx32", "ComboBox", "Edit")
  if ($container -eq [IntPtr]::Zero) {
    return Find-DialogControl $Dialog 1152 "Edit"
  }
  if ((Get-WindowClass $container) -ceq "Edit") {
    return $container
  }
  $edit = Find-DescendantControl $container "Edit"
  if ($edit -ne [IntPtr]::Zero) {
    return $edit
  }
  return $container
}

function Find-AutomationElementsInContainers($Root, [string[]] $ContainerAutomationIds) {
  $elements = [System.Collections.Generic.List[object]]::new()
  foreach ($containerAutomationId in $ContainerAutomationIds) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      $containerAutomationId
    )
    $containers = $Root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $condition
    )
    foreach ($container in $containers) {
      [void] $elements.Add($container)
      $descendants = $container.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      foreach ($element in $descendants) {
        [void] $elements.Add($element)
      }
    }
  }
  return $elements
}

function Find-AutomationNativeControlInContainers(
  $Root,
  [string[]] $ContainerAutomationIds,
  [string[]] $ExpectedClasses
) {
  $elements = @(Find-AutomationElementsInContainers $Root $ContainerAutomationIds)
  foreach ($element in $elements) {
    try {
      if ($ExpectedClasses -cnotcontains $element.Current.ClassName) {
        continue
      }
      $nativeHandle = [IntPtr] $element.Current.NativeWindowHandle
      if ($nativeHandle -eq [IntPtr]::Zero) {
        continue
      }
      $owner = [uint32] 0
      [void] [NexaDialogPickerNative]::GetWindowThreadProcessId($nativeHandle, [ref] $owner)
      if ($owner -eq [uint32] $ProcessId) {
        return $nativeHandle
      }
    } catch {
      continue
    }
  }
  return [IntPtr]::Zero
}

function Find-AutomationPatternCandidatesInContainers(
  $Root,
  [string[]] $ContainerAutomationIds,
  $PatternDefinitions
) {
  $candidates = [System.Collections.Generic.List[object]]::new()
  $elements = @(Find-AutomationElementsInContainers $Root $ContainerAutomationIds)
  foreach ($element in $elements) {
    foreach ($definition in $PatternDefinitions) {
      try {
        $pattern = $null
        if ($element.TryGetCurrentPattern($definition.PatternId, [ref] $pattern)) {
          [void] $candidates.Add([PSCustomObject] @{
            Kind = $definition.Kind
            Pattern = $pattern
          })
        }
      } catch {
        continue
      }
    }
  }
  return $candidates
}

function Find-FileNameAutomationNativeControl([IntPtr] $Dialog) {
  if (-not $script:automationAvailable) {
    return [IntPtr]::Zero
  }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Dialog)
  if ($null -eq $root) {
    return [IntPtr]::Zero
  }
  return Find-AutomationNativeControlInContainers $root @("FileNameControlHost") @(
    "Edit",
    "ComboBox",
    "ComboBoxEx32"
  )
}

function Find-FileNameAutomationPatterns([IntPtr] $Dialog) {
  if (-not $script:automationAvailable) {
    return @()
  }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Dialog)
  if ($null -eq $root) {
    return @()
  }
  $definitions = @(
    [PSCustomObject] @{
      Kind = "Value"
      PatternId = [System.Windows.Automation.ValuePattern]::Pattern
    },
    [PSCustomObject] @{
      Kind = "Legacy"
      PatternId = [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern
    }
  )
  return Find-AutomationPatternCandidatesInContainers $root @("FileNameControlHost") $definitions
}

function Find-ButtonAutomationNativeControl([IntPtr] $Dialog, [int] $ControlId) {
  if (-not $script:automationAvailable) {
    return [IntPtr]::Zero
  }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Dialog)
  if ($null -eq $root) {
    return [IntPtr]::Zero
  }
  return Find-AutomationNativeControlInContainers $root @("$ControlId") @("Button")
}

function Find-ButtonAutomationPatterns([IntPtr] $Dialog, [int] $ControlId) {
  if (-not $script:automationAvailable) {
    return @()
  }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Dialog)
  if ($null -eq $root) {
    return @()
  }
  $definitions = @(
    [PSCustomObject] @{
      Kind = "Invoke"
      PatternId = [System.Windows.Automation.InvokePattern]::Pattern
    },
    [PSCustomObject] @{
      Kind = "Legacy"
      PatternId = [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern
    }
  )
  return Find-AutomationPatternCandidatesInContainers $root @("$ControlId") $definitions
}

function Get-DialogAutomationSummary([IntPtr] $Dialog) {
  if (-not $script:automationAvailable) {
    return "UIAutomation=unavailable"
  }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Dialog)
    $matches = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $summary = [System.Collections.Generic.List[string]]::new()
    foreach ($element in $matches) {
      if ($summary.Count -ge 48) {
        break
      }
      try {
        $automationId = $element.Current.AutomationId
        $controlType = $element.Current.ControlType.ProgrammaticName
        if (-not [string]::IsNullOrWhiteSpace($automationId)) {
          $summary.Add("$automationId/$controlType")
        }
      } catch {
        continue
      }
    }
    return ($summary -join ",")
  } catch {
    return "UIAutomation=error:$($_.Exception.GetType().Name)"
  }
}

$dialog = [IntPtr]::Zero
while ($dialog -eq [IntPtr]::Zero -and $stopwatch.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
  if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
    throw "picker owner process $ProcessId exited before the dialog appeared"
  }
  $dialog = Find-DialogWindow
  if ($dialog -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
if ($dialog -eq [IntPtr]::Zero) {
  throw "timed out waiting for real rfd picker titled $Title"
}

$activationDeadline = [Math]::Min(
  $TimeoutMilliseconds - $stopwatch.ElapsedMilliseconds,
  1000
)
$activationWatch = [System.Diagnostics.Stopwatch]::StartNew()
while (
  [NexaDialogPickerNative]::GetForegroundWindow() -ne $dialog -and
  $activationWatch.ElapsedMilliseconds -lt $activationDeadline
) {
  [void] [NexaDialogPickerNative]::SetForegroundWindow($dialog)
  if ([NexaDialogPickerNative]::GetForegroundWindow() -ne $dialog) {
    Start-Sleep -Milliseconds 50
  }
}
if ([NexaDialogPickerNative]::GetForegroundWindow() -ne $dialog) {
  throw "real rfd picker could not become the foreground window"
}

if ($Action -eq "accept") {
  if ([string]::IsNullOrWhiteSpace($SelectionPath)) {
    throw "accept requires a selection path"
  }
  $parent = Split-Path -Parent $SelectionPath
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "selection parent directory does not exist: $parent"
  }
  $fileNameControl = Find-FileNameControl $dialog
  if ($fileNameControl -eq [IntPtr]::Zero) {
    $fileNameControl = Find-FileNameAutomationNativeControl $dialog
  }
  if ($fileNameControl -ne [IntPtr]::Zero) {
    $setTextTimeout = Get-RemainingMessageTimeout "setting the selection path"
    $setTextResult = [IntPtr]::Zero
    $setTextStatus = [NexaDialogPickerNative]::SendMessageTimeoutString(
      $fileNameControl,
      0x000C,
      [IntPtr]::Zero,
      $SelectionPath,
      0x0002,
      $setTextTimeout,
      [ref] $setTextResult
    )
    if ($setTextStatus -eq [IntPtr]::Zero) {
      throw "real rfd picker file-name control did not accept WM_SETTEXT within the timeout"
    }
    $fileNameText = [System.Text.StringBuilder]::new([Math]::Max($SelectionPath.Length + 1, 1024))
    $getTextTimeout = Get-RemainingMessageTimeout "reading back the selection path"
    $getTextResult = [IntPtr]::Zero
    $getTextStatus = [NexaDialogPickerNative]::SendMessageTimeoutBuilder(
      $fileNameControl,
      0x000D,
      [IntPtr] $fileNameText.Capacity,
      $fileNameText,
      0x0002,
      $getTextTimeout,
      [ref] $getTextResult
    )
    if ($getTextStatus -eq [IntPtr]::Zero) {
      throw "real rfd picker file-name control did not answer WM_GETTEXT within the timeout"
    }
    if ($fileNameText.ToString() -cne $SelectionPath) {
      throw "real rfd picker did not retain the requested selection path"
    }
  } else {
    $fileNameAutomations = @(Find-FileNameAutomationPatterns $dialog)
    if ($fileNameAutomations.Count -eq 0) {
      $summary = Get-DialogAutomationSummary $dialog
      throw "real rfd picker did not expose the standard file-name control ($summary)"
    }
    $selectionApplied = $false
    foreach ($fileNameAutomation in $fileNameAutomations) {
      try {
        if (
          $fileNameAutomation.Kind -ceq "Value" -and
          $fileNameAutomation.Pattern.Current.IsReadOnly
        ) {
          continue
        }
        $fileNameAutomation.Pattern.SetValue($SelectionPath)
        if ($fileNameAutomation.Pattern.Current.Value -ceq $SelectionPath) {
          $selectionApplied = $true
          break
        }
      } catch {
        continue
      }
    }
    if (-not $selectionApplied) {
      throw "real rfd picker UI Automation control did not retain the requested selection path"
    }
  }
  $button = Find-DialogControl $dialog 1 "Button"
} else {
  $button = Find-DialogControl $dialog 2 "Button"
}
$buttonId = if ($Action -eq "accept") { 1 } else { 2 }
if ($button -eq [IntPtr]::Zero) {
  $button = Find-ButtonAutomationNativeControl $dialog $buttonId
}
$buttonAutomations = @()
if ($button -eq [IntPtr]::Zero) {
  $buttonAutomations = @(Find-ButtonAutomationPatterns $dialog $buttonId)
}
if ($button -eq [IntPtr]::Zero -and $buttonAutomations.Count -eq 0) {
  throw "real rfd picker did not expose the expected $Action button"
}
$clickTimeout = Get-RemainingMessageTimeout "clicking the $Action button"
if ($button -ne [IntPtr]::Zero) {
  $messageResult = [IntPtr]::Zero
  $sendResult = [NexaDialogPickerNative]::SendMessageTimeoutPointer(
    $button,
    0x00F5,
    [IntPtr]::Zero,
    [IntPtr]::Zero,
    0x0002,
    $clickTimeout,
    [ref] $messageResult
  )
  if ($sendResult -eq [IntPtr]::Zero) {
    throw "real rfd picker $Action button did not accept BM_CLICK within the timeout"
  }
} else {
  $invoked = $false
  foreach ($buttonAutomation in $buttonAutomations) {
    try {
      if ($buttonAutomation.Kind -ceq "Invoke") {
        $buttonAutomation.Pattern.Invoke()
      } else {
        $buttonAutomation.Pattern.DoDefaultAction()
      }
      $invoked = $true
      break
    } catch {
      continue
    }
  }
  if (-not $invoked) {
    throw "real rfd picker UI Automation candidates rejected the $Action action"
  }
}

$remainingMilliseconds = $TimeoutMilliseconds - $stopwatch.ElapsedMilliseconds
if ($remainingMilliseconds -le 0) {
  throw "real rfd picker action exhausted the timeout budget"
}
$closeDeadline = [Math]::Min($remainingMilliseconds, 5000)
$closeWatch = [System.Diagnostics.Stopwatch]::StartNew()
while ($closeWatch.ElapsedMilliseconds -lt $closeDeadline) {
  if ((Find-DialogWindow) -eq [IntPtr]::Zero) {
    Write-Output "drove real rfd picker $Title"
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
throw "real rfd picker did not close after the $Action action"
