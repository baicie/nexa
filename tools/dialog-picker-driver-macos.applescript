on focusOwner(targetPid, expectedTitle, timeoutSeconds)
  tell application "System Events"
    with timeout of timeoutSeconds seconds
      if UI elements enabled is false then error "macOS Accessibility permission unavailable; cannot drive the real rfd picker"
      if not (exists (first application process whose unix id is targetPid)) then error "real rfd picker owner process is unavailable: " & targetPid
      set targetProcess to first application process whose unix id is targetPid
      set frontmost of targetProcess to true
      set frontWindowTitle to ""
      try
        set frontWindowTitle to name of front window of targetProcess as text
      end try
      if frontWindowTitle is not "" and frontWindowTitle is not expectedTitle then error "real rfd picker front window title did not match: " & expectedTitle
    end timeout
  end tell
end focusOwner

on run argv
  if (count of argv) < 4 then error "usage: driver <pid> <accept|open|cancel> <title> <timeout-ms> [selection-path]"
  set targetPid to item 1 of argv as integer
  set actionName to item 2 of argv
  set expectedTitle to item 3 of argv
  set timeoutMilliseconds to item 4 of argv as integer
  set selectionPath to ""
  if (count of argv) > 4 then set selectionPath to item 5 of argv
  if actionName is not "accept" and actionName is not "open" and actionName is not "cancel" then error "unsupported picker action: " & actionName
  if actionName is not "cancel" and selectionPath is "" then error actionName & " requires a selection path"
  if timeoutMilliseconds < 1 then error "timeout must be positive"

  set timeoutSeconds to (timeoutMilliseconds div 1000) + 1
  if timeoutSeconds > 5 then set timeoutSeconds to 5

  set navigationTarget to ""
  set selectionName to ""
  if actionName is "open" then
    do shell script "/usr/bin/test -f " & quoted form of selectionPath
    set navigationTarget to do shell script "/usr/bin/dirname " & quoted form of selectionPath
    set selectionName to do shell script "/usr/bin/basename " & quoted form of selectionPath
  else if actionName is "accept" then
    set navigationTarget to do shell script "/usr/bin/dirname " & quoted form of selectionPath
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
    if actionName is "open" then
      tell application "System Events"
        with timeout of timeoutSeconds seconds
          keystroke selectionName
        end timeout
      end tell
      delay 0.4
      my focusOwner(targetPid, expectedTitle, timeoutSeconds)
    end if
    tell application "System Events"
      with timeout of timeoutSeconds seconds
        key code 36
      end timeout
    end tell
  end if

  delay 0.6
  return "drove one bounded real rfd picker attempt for " & expectedTitle
end run
