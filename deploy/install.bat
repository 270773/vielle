@echo off
rem Installation de LabelQC sur le serveur (Windows). Prerequis : Python 3.11 ou plus recent (python.org, "Add to PATH").
cd /d "%~dp0.."
python --version || (echo Python introuvable & exit /b 1)
python -m venv venv || exit /b 1
call venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt || exit /b 1
if not exist config.env copy config.env.example config.env
if not exist data\modeles mkdir data\modeles
if not exist data\scans_entrants mkdir data\scans_entrants
echo.
echo Installation terminee. 1) Editer config.env (dossier reseau des modeles, dossier d'entree du scanner)
echo                       2) Lancer deploy\start.bat  - le mot de passe du compte admin s'affiche au premier demarrage.
