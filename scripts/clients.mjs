#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root=fileURLToPath(new URL("../",import.meta.url));
const env={...process.env};
const localDotnet=path.join(root,"clients/.dependencies/dotnet");
const dotnet=existsSync(path.join(localDotnet,"dotnet"))?path.join(localDotnet,"dotnet"):"dotnet";
if(dotnet!=="dotnet")env.DOTNET_ROOT=localDotnet;
if(process.platform==="darwin") {
  const jdk="/Applications/Android Studio.app/Contents/jbr/Contents/Home";
  if(!env.JAVA_HOME&&existsSync(jdk))env.JAVA_HOME=jdk;
  const sdk=path.join(process.env.HOME||"","Library/Android/sdk");
  if(!env.ANDROID_HOME&&existsSync(sdk))env.ANDROID_HOME=sdk;
}
function run(command,args,{required=true,quiet=false}={}) {
  const result=spawnSync(command,args,{cwd:root,env,stdio:quiet?"pipe":"inherit",encoding:"utf8"});
  if(required&&(result.error||result.status!==0))throw new Error(`${command} ${args.join(" ")} failed`);
  return result;
}
const action=process.argv[2]||"doctor",platform=process.argv[3]||"all";
try {
  if(action==="doctor") {
    const checks=[['Node',process.execPath,['--version']],['Java',env.JAVA_HOME?path.join(env.JAVA_HOME,'bin/java'):'java',['-version']],['.NET',dotnet,['--version']]];
    if(process.platform==="darwin")checks.push(['Xcode','xcodebuild',['-version']],['XcodeGen','xcodegen',['--version']],['Go','go',['version']]);
    for(const [name,command,args] of checks) {const result=run(command,args,{required:false,quiet:true});console.log(`${name}: ${result.status===0?'OK':'MISSING'}`);}
    console.log(`Android SDK: ${env.ANDROID_HOME&&existsSync(env.ANDROID_HOME)?'OK':'MISSING'}`);
    if(process.platform==="darwin") {const result=run('security',['find-identity','-v','-p','codesigning'],{required:false,quiet:true});console.log(`Apple signing: ${/\b[1-9]\d* valid identities found/.test(result.stdout||'')?'IDENTITY FOUND (profile/entitlements still need verification)':'NOT CONFIGURED'}`);}
    console.log('Development checks only. Production release additionally requires Windows tunnel integration, platform signing and real-device VPN acceptance.');
  } else if(action==="build") {
    if(!['all','android','apple','windows'].includes(platform))throw new Error('Unknown platform');
    run(process.platform==='win32'?'npm.cmd':'npm',['run','build']);
    if(platform==='all'||platform==='android')run(process.platform==='win32'?'clients/android/gradlew.bat':'bash',process.platform==='win32'?['-p','clients/android',':app:assembleDebug']:['clients/android/gradlew','-p','clients/android',':app:assembleDebug']);
    if(platform==='all'||platform==='apple') {
      if(process.platform!=='darwin')throw new Error('Apple builds require macOS + Xcode');
      run('bash',['clients/apple/scripts/build.sh','ios']);run('bash',['clients/apple/scripts/build.sh','macos']);
    }
    if(platform==='all'||platform==='windows')for(const runtime of ['win-x64','win-arm64'])run(dotnet,['publish','clients/windows/Northstar/Northstar.csproj','-c','Release','-r',runtime,'--self-contained','true','-o',`clients/windows/artifacts/${runtime}`]);
    console.log('Development build complete. Nothing was uploaded, published or deployed. Do not add these artifacts to the public download catalog.');
  } else throw new Error('Usage: node scripts/clients.mjs doctor | build [all|android|apple|windows]');
} catch(error) {console.error(error.message);process.exitCode=1;}
