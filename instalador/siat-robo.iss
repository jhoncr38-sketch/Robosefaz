; Instalador do SIAT Robô (Inno Setup 6).
; Não compile à mão: use gerar-instalador.bat, que prepara os arquivos e
; passa StageDir, PythonExe, AppVersion, OutputDir, SupabaseUrl e PanelUrl.

#define AppName "SIAT Robô"
#define TaskName "SIAT Automacao - Robo"

[Setup]
AppId={{8C1F6D2A-5B7E-4E7B-9C1B-2F4A6D8E3B10}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=SIAT Automação
DefaultDirName=C:\SIAT-Robo
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
UsePreviousAppDir=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=Instalar-SIAT-Robo-{#AppVersion}
SetupIconFile={#StageDir}\instalador\robo.ico
UninstallDisplayIcon={app}\instalador\robo.ico
UninstallDisplayName={#AppName}
WizardStyle=modern
WizardSizePercent=110
Compression=lzma2/max
SolidCompression=yes
CloseApplications=no
RestartApplications=no

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Messages]
ptbr.WelcomeLabel2=Este assistente vai instalar o [name] neste computador.%n%nO robô entra no SIAT com o certificado de cada cliente, agenda as exportações de NFC-e e NF-e e baixa os arquivos sozinho, em segundo plano.%n%nAntes de continuar, instale os certificados A1 (.pfx) dos clientes neste usuário do Windows.
ptbr.FinishedLabel=O [name] foi instalado e já está ligado.%n%nProcure o ícone do robô ao lado do relógio (se não aparecer, clique na setinha ^ e arraste-o para a barra). Ele inicia sozinho sempre que você entrar no Windows.

[Tasks]
Name: "semsuspensao"; Description: "Impedir que o computador entre em suspensão quando estiver na tomada (recomendado)"
Name: "atalhopainel"; Description: "Criar atalho do painel na Área de Trabalho"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#PythonExe}"; DestDir: "{tmp}"; DestName: "python-instalador.exe"; Flags: deleteafterinstall
; usado antes da cópia dos arquivos para parar um robô já instalado
Source: "{#StageDir}\instalador\desinstalar.ps1"; Flags: dontcopy

[Dirs]
Name: "{app}\storage\downloads"; Flags: uninsneveruninstall

[Icons]
Name: "{group}\SIAT Robô (ícone ao lado do relógio)"; Filename: "{app}\worker\.venv\Scripts\pythonw.exe"; Parameters: "-m app.tray"; WorkingDir: "{app}\worker"; IconFilename: "{app}\instalador\robo.ico"
Name: "{group}\Painel SIAT"; Filename: "{#PanelUrl}"; IconFilename: "{app}\instalador\robo.ico"
Name: "{group}\Pasta das notas"; Filename: "{app}\storage\downloads"
Name: "{group}\Ligar robô"; Filename: "{app}\iniciar-robo.bat"; IconFilename: "{app}\instalador\robo.ico"
Name: "{group}\Parar robô"; Filename: "{app}\parar-robo.bat"; IconFilename: "{app}\instalador\robo.ico"
Name: "{group}\Status e verificação"; Filename: "{app}\status-robo.bat"; IconFilename: "{app}\instalador\robo.ico"
Name: "{group}\Desinstalar SIAT Robô"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Painel SIAT"; Filename: "{#PanelUrl}"; IconFilename: "{app}\instalador\robo.ico"; Tasks: atalhopainel

[Run]
Filename: "{#PanelUrl}"; Description: "Abrir o painel"; Flags: postinstall shellexec skipifsilent nowait
Filename: "{app}\storage\logs\instalacao.log"; Description: "Ver o relatório da instalação"; Flags: postinstall shellexec skipifsilent nowait unchecked

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\instalador\desinstalar.ps1"" -RemoverTarefa"; Flags: runhidden waituntilterminated; RunOnceId: "PararRobo"

[UninstallDelete]
; as notas (storage\downloads) ficam; o resto gerado pelo robô sai
Type: filesandordirs; Name: "{app}\worker"
Type: filesandordirs; Name: "{app}\storage\logs"
Type: filesandordirs; Name: "{app}\storage\browser_profiles"
Type: filesandordirs; Name: "{app}\storage\screenshots"
Type: filesandordirs; Name: "{app}\storage\errors"
Type: filesandordirs; Name: "{app}\storage\secrets"
Type: files; Name: "{app}\storage\*.json"
Type: files; Name: "{app}\storage\*.flag"
Type: files; Name: "{app}\.env"

[Code]
var
  KeyPage: TInputQueryWizardPage;
  InstallResult: Integer;

function EnvExists(): Boolean;
begin
  Result := FileExists(AddBackslash(WizardDirValue) + '.env');
end;

procedure InitializeWizard;
begin
  KeyPage := CreateInputQueryPage(wpSelectDir,
    'Conexão com o painel',
    'Dados do Supabase usados pelo robô',
    'Cole a URL do projeto e a Secret key (Supabase > Project Settings > API Keys).' + #13#10 +
    'A chave fica guardada somente neste computador.');
  KeyPage.Add('URL do projeto:', False);
  KeyPage.Add('Secret key (começa com sb_secret_):', True);
  KeyPage.Values[0] := '{#SupabaseUrl}';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  { atualização: a conexão já está configurada }
  Result := (PageID = KeyPage.ID) and EnvExists();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Url, Key: String;
begin
  Result := True;
  if CurPageID = KeyPage.ID then
  begin
    Url := Trim(KeyPage.Values[0]);
    Key := Trim(KeyPage.Values[1]);
    if (Pos('https://', Url) <> 1) or (Pos('.supabase.co', Url) = 0) then
    begin
      MsgBox('Informe a URL do projeto no formato https://xxxx.supabase.co', mbError, MB_OK);
      Result := False;
    end
    else if (Pos('sb_secret_', Key) <> 1) and (Pos('eyJ', Key) <> 1) then
    begin
      MsgBox('Isso não parece uma Secret key do Supabase (ela começa com sb_secret_).', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Rc: Integer;
begin
  { para um robô já instalado (em qualquer pasta) antes de trocar os arquivos }
  ExtractTemporaryFile('desinstalar.ps1');
  Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
    ExpandConstant('{tmp}\desinstalar.ps1') + '" -Raiz "' + WizardDirValue + '"',
    '', SW_HIDE, ewWaitUntilTerminated, Rc);
  Result := '';
end;

procedure RunSetupScript();
var
  Params, Conn: String;
  Lines: TArrayOfString;
begin
  Params := '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
    ExpandConstant('{app}\instalador\instalar.ps1') + '" -Silencioso -Iniciar' +
    ' -PythonInstalador "' + ExpandConstant('{tmp}\python-instalador.exe') + '"' +
    ' -Log "' + ExpandConstant('{app}\storage\logs\instalacao.log') + '"';
  if WizardIsTaskSelected('semsuspensao') then
    Params := Params + ' -SemSuspensao';
  if not EnvExists() then
  begin
    { a chave vai por arquivo temporário (apagado pelo script), nunca pela linha de comando }
    Conn := ExpandConstant('{tmp}\conexao.txt');
    SetArrayLength(Lines, 2);
    Lines[0] := Trim(KeyPage.Values[0]);
    Lines[1] := Trim(KeyPage.Values[1]);
    SaveStringsToUTF8File(Conn, Lines, False);
    Params := Params + ' -Conexao "' + Conn + '"';
  end;
  ForceDirectories(ExpandConstant('{app}\storage\logs'));
  WizardForm.StatusLabel.Caption := 'Preparando o robô: Python, bibliotecas e verificação dos certificados...';
  WizardForm.FilenameLabel.Caption := 'Isso pode levar alguns minutos na primeira instalação.';
  WizardForm.ProgressGauge.Style := npbstMarquee;
  if not Exec('powershell.exe', Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, InstallResult) then
    InstallResult := -1;
  WizardForm.ProgressGauge.Style := npbstNormal;
  DeleteFile(ExpandConstant('{tmp}\conexao.txt'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Log: String;
begin
  if CurStep = ssPostInstall then
  begin
    RunSetupScript();
    Log := ExpandConstant('{app}\storage\logs\instalacao.log');
    if InstallResult = 2 then
      MsgBox('O robô foi instalado, mas a verificação encontrou problemas (por exemplo, certificado de algum cliente não instalado neste Windows).' + #13#10#13#10 +
        'Veja o relatório no final da instalação ou no menu Iniciar > SIAT Robô > Status e verificação.', mbInformation, MB_OK)
    else if InstallResult <> 0 then
      MsgBox('Não foi possível concluir a preparação do robô (código ' + IntToStr(InstallResult) + ').' + #13#10#13#10 +
        'Detalhes em: ' + Log + #13#10 + 'Corrija o problema e execute o instalador novamente.', mbError, MB_OK);
  end;
end;
