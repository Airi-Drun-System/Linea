; «Установка и удаление программ»: издателя VegasDev electron-builder берёт из author, а ссылку на проект сам не пишет
!macro customInstall
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "URLInfoAbout" "https://github.com/Airi-Drun-System/Linea"
!macroend
