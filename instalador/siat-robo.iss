; Instalador do JR Sistema Robô (Inno Setup 6).
; Não compile à mão: use gerar-instalador.bat, que prepara os arquivos e
; passa StageDir, PythonExe, AppVersion, OutputDir e PanelUrl.

#define AppName "JR Sistema Robô"
#define GroupName "JR Sistema"
#define TaskName "SIAT Automacao - Robo"

[Setup]
AppId={{8C1F6D2A-5B7E-4E7B-9C1B-2F4A6D8E3B10}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=JR Sistema
DefaultDirName=C:\SIAT-Robo
DefaultGroupName={#GroupName}
DisableProgramGroupPage=yes
UsePreviousAppDir=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=Instalar-SIAT-Robo-{#AppVersion}
SetupIconFile={#StageDir}\instalador\robo.ico
UninstallDisplayIcon={app}\instalador\robo.ico
WizardImageFile={#StageDir}\instalador\wizard-grande.bmp
WizardSmallImageFile={#StageDir}\instalador\wizard-pequena.bmp
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

[InstallDelete]
; atalhos com o nome antigo (antes da marca JR Sistema, até a 1.1.2)
Type: filesandordirs; Name: "{commonprograms}\SIAT Robô"
Type: files; Name: "{commondesktop}\Painel SIAT.url"
Type: files; Name: "{commondesktop}\Painel SIAT.lnk"

[Dirs]
Name: "{app}\storage\downloads"; Flags: uninsneveruninstall

[Icons]
Name: "{group}\Robô (ícone ao lado do relógio)"; Filename: "{app}\worker\.venv\Scripts\pythonw.exe"; Parameters: "-m app.tray"; WorkingDir: "{app}\worker"; IconFilename: "{app}\instalador\robo.ico"
Name: "{group}\Painel JR Sistema"; Filename: "{#PanelUrl}"; IconFilename: "{app}\instalador\robo.ico"
Name: "{group}\Pasta das notas"; Filename: "{app}\storage\downloads"
Name: "{group}\Ligar robô"; Filename: "{app}\iniciar-robo.bat"; IconFilename: "{app}\instalador\robo.ico"
Name: "{group}\Parar robô"; Filename: "{app}\parar-robo.bat"; IconFilename: "{app}\instalador\robo.ico"
Name: "{group}\Status e verificação"; Filename: "{app}\status-robo.bat"; IconFilename: "{app}\instalador\robo.ico"
Name: "{group}\Ativar este computador"; Filename: "{app}\ativar-robo.bat"; IconFilename: "{app}\instalador\robo.ico"
Name: "{group}\Desinstalar o robô"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Painel JR Sistema"; Filename: "{#PanelUrl}"; IconFilename: "{app}\instalador\robo.ico"; Tasks: atalhopainel

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
    'Ativar este computador',
    'Código de ativação do escritório',
    'No painel ({#PanelUrl}), abra Computadores > Adicionar computador e digite abaixo o código ' +
    'de 8 caracteres. Ele vale por 30 minutos e só pode ser usado uma vez.' + #13#10#13#10 +
    'Com o código, este computador passa a acessar somente os dados do seu escritório.');
  KeyPage.Add('Código de ativação (ex.: ABCD-EFGH):', False);
end;

function CleanCode(Value: String): String;
var
  I: Integer;
  C: Char;
begin
  Result := '';
  for I := 1 to Length(Value) do
  begin
    C := Value[I];
    if ((C >= '0') and (C <= '9')) or ((C >= 'A') and (C <= 'Z')) or ((C >= 'a') and (C <= 'z')) then
      Result := Result + Uppercase(C);
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  { atualização: a conexão já está configurada }
  Result := (PageID = KeyPage.ID) and EnvExists();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = KeyPage.ID) and (Length(CleanCode(KeyPage.Values[0])) <> 8) then
  begin
    MsgBox('O código de ativação tem 8 caracteres (ex.: ABCD-EFGH). Gere um no painel, em Computadores.',
      mbError, MB_OK);
    Result := False;
  end;
end;

function FromUpdater(): Boolean;
begin
  { /FROMUPDATER=1: chamado pela atualização automática (a tarefa do robô está esperando) }
  Result := ExpandConstant('{param:FROMUPDATER|0}') = '1';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Rc: Integer;
  Extra: String;
begin
  { para um robô já instalado (em qualquer pasta) antes de trocar os arquivos }
  Extra := '';
  if FromUpdater() then
    Extra := ' -ManterTarefa';
  ExtractTemporaryFile('desinstalar.ps1');
  Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
    ExpandConstant('{tmp}\desinstalar.ps1') + '" -Raiz "' + WizardDirValue + '"' + Extra,
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
    ' -Log "' + ExpandConstant('{app}\storage\logs\instalacao.log') + '"' +
    ' -Painel "{#PanelUrl}"';
  if WizardIsTaskSelected('semsuspensao') then
    Params := Params + ' -SemSuspensao';
  if not EnvExists() then
  begin
    { o código vai por arquivo temporário (apagado pelo script), nunca pela linha de comando }
    Conn := ExpandConstant('{tmp}\conexao.txt');
    SetArrayLength(Lines, 1);
    Lines[0] := CleanCode(KeyPage.Values[0]);
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
        'Veja o relatório no final da instalação ou no menu Iniciar > JR Sistema > Status e verificação.', mbInformation, MB_OK)
    else if InstallResult <> 0 then
      MsgBox('Não foi possível concluir a preparação do robô (código ' + IntToStr(InstallResult) + ').' + #13#10#13#10 +
        'Detalhes em: ' + Log + #13#10 + 'Corrija o problema e execute o instalador novamente.', mbError, MB_OK);
  end;
end;
