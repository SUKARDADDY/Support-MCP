; Hooks for the Tauri NSIS installer (bundle.windows.nsis.installerHooks in tauri.conf.json).
; The installer template inserts NSIS_HOOK_POSTUNINSTALL at the end of the uninstall section.
;
; The template's own "Delete app data" check box only exists in the uninstaller's window. A
; silent uninstall (uninstall.exe /S, as winget, Intune and scripts run it) has no window, so
; the box is never read and the app's data stays: %APPDATA%\dev.support-mcp.technician holds
; app.json (the sealed sign-in), %LOCALAPPDATA%\dev.support-mcp.technician holds the web view
; cache and a staged update. Remove both in that case.
;
; Two things keep this away from an update, which must keep the sign-in:
;   * $UpdateMode is 1 when the installer or uninstaller was started with /UPDATE, which is
;     how the app's updater starts the new installer (update.rs, INSTALLER_ARGS).
;   * ${Silent} is true only when this uninstaller was started with /S. The old uninstaller
;     that a new installer runs for a reinstall is started without /S, so it never matches.
; An interactive uninstall is left to the template: the box is unchecked by default and the
; person ticks it to delete the data.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} ${Silent}
  ${AndIf} $UpdateMode <> 1
    ; Per-user folders, whatever context the template left set.
    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}
!macroend
