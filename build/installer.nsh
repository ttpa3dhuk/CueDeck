; Wait for the operator to close CueDeck; the default check force-kills it.
LangString cueDeckCloseBeforeInstall 1033 "Close CueDeck before continuing. Save your project, close CueDeck, then click Retry."
LangString cueDeckCloseBeforeInstall 1049 "Закройте CueDeck перед продолжением. Сохраните проект, закройте CueDeck, затем нажмите «Повторить»."

!macro customCheckAppRunning
  cuedeck_wait_for_exit:
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ${If} $R0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(cueDeckCloseBeforeInstall)" /SD IDCANCEL IDRETRY cuedeck_wait_for_exit
      Quit
    ${EndIf}
!macroend
