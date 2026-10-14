; NSIS hooks included by electron-builder (nsis.include). Launch integration (LI.5, D7):
; lets other apps find the exe. Per-user install (perMachine: false) => SHELL_CONTEXT is the current-user hive.
; The .mixo file association is NOT written here: win.fileAssociations does it declaratively.

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "Path" "$INSTDIR"
  WriteRegStr SHELL_CONTEXT "Software\MIXOMESH" "InstallLocation" "$INSTDIR"
  WriteRegStr SHELL_CONTEXT "Software\MIXOMESH" "Version" "${VERSION}"
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey SHELL_CONTEXT "Software\MIXOMESH"
!macroend
