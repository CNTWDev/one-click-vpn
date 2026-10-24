; Veilbird installer (Inno Setup 6). Built by build.ps1 -Installer; installs per machine into Program Files,
; because the WireGuard tunnel service runs this executable as SYSTEM and must not live in a user-writable folder.
; Running a newer installer over an older one upgrades in place (same AppId).
#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Build
  #define Build "0"
#endif
#ifndef Runtime
  #define Runtime "win-x64"
#endif

[Setup]
AppId={{6C5E8F64-2C1B-4C55-9C35-7B1C0E5A9B21}
AppName=Veilbird
AppVersion={#Version}
VersionInfoVersion={#Version}.{#Build}
AppPublisher=Veilbird
DefaultDirName={autopf}\Veilbird
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=admin
#if Runtime == "win-arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif
MinVersion=10.0
SetupIconFile=Veilbird\Assets\Veilbird.ico
UninstallDisplayIcon={app}\Veilbird.exe
OutputDir=artifacts
OutputBaseFilename=Veilbird-{#Version}-{#Build}-{#Runtime}-setup
Compression=lzma2
SolidCompression=yes
CloseApplications=yes
WizardStyle=modern

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Files]
Source: "artifacts\{#Runtime}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{autoprograms}\Veilbird"; Filename: "{app}\Veilbird.exe"
Name: "{autodesktop}\Veilbird"; Filename: "{app}\Veilbird.exe"

[Run]
Filename: "{app}\Veilbird.exe"; Description: "Veilbird"; Flags: nowait postinstall skipifsilent shellexec

[UninstallRun]
; Stops a tunnel left running by the app before its files are removed.
Filename: "{sys}\sc.exe"; Parameters: "stop ""WireGuardTunnel$Veilbird"""; Flags: runhidden; RunOnceId: "StopTunnel"
