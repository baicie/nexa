on elementMatches(anElement, expectedTitle)
  try
    if (name of anElement as text) is expectedTitle then return true
  end try
  try
    if (value of anElement as text) is expectedTitle then return true
  end try
  try
    if (description of anElement as text) is expectedTitle then return true
  end try
  return false
end elementMatches

on locateDialog(targetPid, expectedTitle)
  tell application "System Events"
    if not (exists (first application process whose unix id is targetPid)) then return missing value
    set targetProcess to first application process whose unix id is targetPid
    repeat with candidateWindow in windows of targetProcess
      if my elementMatches(candidateWindow, expectedTitle) then return candidateWindow
      try
        repeat with candidateElement in entire contents of candidateWindow
          if my elementMatches(candidateElement, expectedTitle) then return candidateWindow
        end repeat
      end try
    end repeat
  end tell
  return missing value
end locateDialog

on processExists(targetPid)
  tell application "System Events"
    return exists (first application process whose unix id is targetPid)
  end tell
end processExists

on waitForGoToFolderSheet(targetPid, expectedTitle, deadline)
  repeat
    if (current date) > deadline then error "timed out waiting for the Go to Folder sheet in " & expectedTitle
    set dialogWindow to my locateDialog(targetPid, expectedTitle)
    if dialogWindow is missing value then error "real rfd picker closed before the Go to Folder sheet appeared: " & expectedTitle
    tell application "System Events"
      try
        if (count of sheets of dialogWindow) > 0 then return
      end try
    end tell
    delay 0.1
  end repeat
end waitForGoToFolderSheet

on waitForGoToFolderSheetToClose(targetPid, expectedTitle, deadline)
  repeat
    if (current date) > deadline then error "timed out waiting for the Go to Folder sheet to close in " & expectedTitle
    set dialogWindow to my locateDialog(targetPid, expectedTitle)
    if dialogWindow is missing value then return false
    set sheetIsOpen to false
    tell application "System Events"
      try
        set sheetIsOpen to (count of sheets of dialogWindow) > 0
      end try
    end tell
    if sheetIsOpen is false then return true
    delay 0.1
  end repeat
end waitForGoToFolderSheetToClose

on waitForDialogToClose(targetPid, expectedTitle, deadline)
  repeat
    if (current date) > deadline then error "real rfd picker did not close after the requested action: " & expectedTitle
    if my processExists(targetPid) is false then error "picker owner process exited before the dialog closed: " & targetPid
    if my locateDialog(targetPid, expectedTitle) is missing value then return
    delay 0.1
  end repeat
end waitForDialogToClose

on run argv
  if (count of argv) < 4 then error "usage: driver <pid> <accept|cancel> <title> <timeout-ms> [selection-path]"
  set targetPid to item 1 of argv as integer
  set actionName to item 2 of argv
  set expectedTitle to item 3 of argv
  set timeoutMilliseconds to item 4 of argv as integer
  set selectionPath to ""
  if (count of argv) > 4 then set selectionPath to item 5 of argv
  if actionName is not "accept" and actionName is not "cancel" then error "unsupported picker action: " & actionName
  if actionName is "accept" and selectionPath is "" then error "accept requires a selection path"
  if timeoutMilliseconds < 1 then error "timeout must be positive"

  tell application "System Events"
    if UI elements enabled is false then error "macOS Accessibility permission unavailable; cannot drive the real rfd picker"
  end tell

  set deadline to (current date) + (timeoutMilliseconds / 1000)
  set dialogWindow to missing value
  repeat while dialogWindow is missing value
    if (current date) > deadline then error "timed out waiting for real rfd picker titled " & expectedTitle
    set dialogWindow to my locateDialog(targetPid, expectedTitle)
    if dialogWindow is missing value then delay 0.1
  end repeat

  set navigationTarget to ""
  if actionName is "accept" then
    set navigationTarget to selectionPath
    try
      do shell script "/usr/bin/test -e " & quoted form of selectionPath
    on error
      set navigationTarget to do shell script "/usr/bin/dirname " & quoted form of selectionPath
    end try
  end if
  tell application "System Events"
    set targetProcess to first application process whose unix id is targetPid
    set frontmost of targetProcess to true
    if actionName is "cancel" then
      key code 53
    else
      keystroke "g" using {command down, shift down}
    end if
  end tell

  if actionName is "accept" then
    my waitForGoToFolderSheet(targetPid, expectedTitle, deadline)
    tell application "System Events"
      set targetProcess to first application process whose unix id is targetPid
      set frontmost of targetProcess to true
      keystroke navigationTarget
      key code 36
    end tell
    set dialogStillOpen to my waitForGoToFolderSheetToClose(targetPid, expectedTitle, deadline)
    if dialogStillOpen then
      tell application "System Events"
        set targetProcess to first application process whose unix id is targetPid
        set frontmost of targetProcess to true
        key code 36
      end tell
    end if
  end if

  my waitForDialogToClose(targetPid, expectedTitle, deadline)

  return "drove real rfd picker " & expectedTitle
end run
