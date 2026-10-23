@echo off
rem Installe LabelQC comme service Windows (necessite NSSM : https://nssm.cc) - a lancer en administrateur.
set ROOT=%~dp0..
nssm install LabelQC-API "%ROOT%\venv\Scripts\python.exe"
nssm set LabelQC-API AppParameters "-m server"
nssm set LabelQC-API AppDirectory "%ROOT%"
nssm set LabelQC-API Start SERVICE_AUTO_START
nssm set LabelQC-API AppStdout "%ROOT%\data\labelqc.log"
nssm set LabelQC-API AppStderr "%ROOT%\data\labelqc.log"
net start LabelQC-API
