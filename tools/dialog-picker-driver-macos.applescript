on focusOwner(targetPid, expectedTitle, timeoutSeconds)
  tell application "System Events"
    with timeout of timeoutSeconds seconds
      if UI elements enabled is false then error "macOS Accessibility permission unavailable; cannot drive the real rfd picker"
      if not (exists (first application process whose unix id is targetPid)) then error "real rfd picker owner process is unavailable: " & targetPid
      set targetProcess to first application process whose unix id is targetPid
      set frontmost of targetProcess to true
      try
        set frontWindowTitle to name of front window of targetProcess as text
        if frontWindowTitle is not "" and frontWindowTitle is not expectedTitle then error "real rfd picker front window title did not match: " & expectedTitle
      end try
    end timeout
  end tell
end focusOwner

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

  set timeoutSeconds to (timeoutMilliseconds div 1000) + 1
  if timeoutSeconds > 5 then set timeoutSeconds to 5

  set navigationTarget to ""
  if actionName is "accept" then
    set navigationTarget to selectionPath
    try
      do shell script "/usr/bin/test -e " & quoted form of selectionPath
    on error
      set navigationTarget to do shell script "/usr/bin/dirname " & quoted form of selectionPath
    end try
  end if

  my focusOwner(targetPid, expectedTitle, timeoutSeconds)
  delay 0.6
  if actionName is "cancel" then
    tell application "System Events"
      with timeout of timeoutSeconds seconds
        key code 53
      end timeout
    end tell
  else
    tell application "System Events"
      with timeout of timeoutSeconds seconds
        keystroke "g" using {command down, shift down}
      end timeout
    end tell
    delay 0.6
    my focusOwner(targetPid, expectedTitle, timeoutSeconds)
    tell application "System Events"
      with timeout of timeoutSeconds seconds
        keystroke "a" using {command down}
        keystroke navigationTarget
        key code 36
      end timeout
    end tell
    delay 0.6
    my focusOwner(targetPid, expectedTitle, timeoutSeconds)
    tell application "System Events"
      with timeout of timeoutSeconds seconds
        key code 36
      end timeout
    end tell
  end if

  delay 0.6
  return "drove one bounded real rfd picker attempt for " & expectedTitle
end run
