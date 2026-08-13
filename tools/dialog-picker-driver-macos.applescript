on normalizePath(inputPath)
  set normalizedPath to inputPath as text
  repeat while normalizedPath ends with "/" and normalizedPath is not "/"
    set normalizedPath to text 1 thru -2 of normalizedPath
  end repeat
  return normalizedPath
end normalizePath

on parentPathFor(inputPath)
  set normalizedPath to my normalizePath(inputPath)
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to "/"
  set components to text items of normalizedPath
  if (count of components) < 2 then
    set AppleScript's text item delimiters to oldDelimiters
    error "selection path must be absolute: " & inputPath
  end if
  set parentComponents to items 1 thru -2 of components
  set parentPath to parentComponents as text
  set AppleScript's text item delimiters to oldDelimiters
  if parentPath is "" then set parentPath to "/"
  return parentPath
end parentPathFor

on baseNameFor(inputPath)
  set normalizedPath to my normalizePath(inputPath)
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to "/"
  set components to text items of normalizedPath
  set selectedBaseName to (item -1 of components) as text
  set AppleScript's text item delimiters to oldDelimiters
  return selectedBaseName
end baseNameFor

on ensureRegularFile(inputPath)
  tell application "System Events"
    if not (exists disk item inputPath) then error "open selection file does not exist: " & inputPath
    set fileKind to kind of disk item inputPath as text
  end tell
  if fileKind is "folder" or fileKind is "Folder" then error "open selection path is not a file: " & inputPath
end ensureRegularFile

on focusOwner(targetPid, timeoutSeconds)
  tell application "System Events"
    with timeout of timeoutSeconds seconds
      if UI elements enabled is false then error "macOS Accessibility permission unavailable; cannot drive the real rfd picker"
      if not (exists (first application process whose unix id is targetPid)) then error "real rfd picker owner process is unavailable: " & targetPid
      set targetProcess to first application process whose unix id is targetPid
      set frontmost of targetProcess to true
      if not (exists front window of targetProcess) then error "real rfd picker owner process has no front window: " & targetPid
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
    my ensureRegularFile(selectionPath)
    set navigationTarget to my parentPathFor(selectionPath)
    set selectionName to my baseNameFor(selectionPath)
  else if actionName is "accept" then
    set navigationTarget to my parentPathFor(selectionPath)
  end if

  my focusOwner(targetPid, timeoutSeconds)
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
    my focusOwner(targetPid, timeoutSeconds)
    tell application "System Events"
      with timeout of timeoutSeconds seconds
        keystroke "a" using {command down}
        keystroke navigationTarget
        key code 36
      end timeout
    end tell
    delay 0.6
    my focusOwner(targetPid, timeoutSeconds)
    if actionName is "open" then
      tell application "System Events"
        with timeout of timeoutSeconds seconds
          keystroke (selectionName as text)
        end timeout
      end tell
      delay 0.4
      my focusOwner(targetPid, timeoutSeconds)
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
