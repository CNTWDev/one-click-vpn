import { NextResponse } from "next/server";
import { readJson } from "../../../../../server/http";
import { NativeError } from "../../../../../server/native-proof";
import { writeOperationalLog } from "../../../../../server/operational-logs";
import { clientHeader,recordDiagnostics,recordEnrollmentClient,recordSessionClient,requireSupportedClient } from "../../../../../server/native-clients";
import { parseClientAgent,type ClientPlatform } from "../../../../../shared/client-releases";
import { requestPasswordResetEmail } from "../../../../../server/password-reset";
import { nativeAccount,nativeChallenge,nativeConnect,nativeEnd,nativeLogin,nativeLogout,nativeNodes,nativeSession,nativeStatus } from "../../../../../server/native-access";
export const runtime="nodejs";
export const dynamic="force-dynamic";
async function handle(request:Request) {
  try {
    if(process.env.VEILBIRD_NATIVE_ACCESS_ENABLED==="0") throw new NativeError("CLIENT_ACCESS_NOT_ENABLED",503);
    const path=new URL(request.url).pathname.split("/native/")[1];
    const body=request.method==="POST"?await readJson(request):{};
    let result:unknown;
    if(request.method==="POST"&&path==="login") {
      // Outdated builds are stopped before a password check or device admission, with a download link.
      const agent=["android","ios","macos","windows"].includes(String(body.platform))?await requireSupportedClient(request,body.platform as ClientPlatform):null;
      const login=await nativeLogin(request,body);
      await recordSessionClient(login.accessToken,agent);
      result=login;
    }
    else if(request.method==="POST"&&path==="password-reset") {
      // Needs no session: "forgot password" on the sign-in screen and "change password" on the account page both
      // email the Portal's one-hour link; the answer is the same whether or not the address has an account.
      const sent=await requestPasswordResetEmail(request,body.email,body.language);
      if(sent==="unconfigured") throw new NativeError("PASSWORD_RESET_UNAVAILABLE",503);
      if(sent==="invalid") throw new NativeError("INVALID_EMAIL",400);
      if(sent==="limited") throw new NativeError("RATE_LIMITED",429);
      result={status:"received"};
    }
    else {
      const session=await nativeSession(request);
      if(request.method==="GET"&&path==="account") result=await nativeAccount(session);
      else if(request.method==="GET"&&path==="nodes") result=await nativeNodes();
      else if(request.method==="GET"&&path?.startsWith("status/")) result=await nativeStatus(session,path.slice(7));
      else if(request.method==="POST"&&path==="challenge") result=await nativeChallenge(session,body);
      else if(request.method==="POST"&&path==="connect") {
        const agent=await requireSupportedClient(request,session.platform as ClientPlatform);
        const lease=await nativeConnect(session,body);
        await recordEnrollmentClient(lease.enrollmentId,agent);
        result=lease;
      }
      else if(request.method==="POST"&&(path==="disconnect"||path==="revoke")) result=await nativeEnd(session,path,body);
      else if(request.method==="POST"&&path==="diagnostics") {
        const agent=parseClientAgent(request.headers.get(clientHeader));
        result=await recordDiagnostics(session,agent?.platform===session.platform?agent:null,body);
      }
      else if(request.method==="POST"&&path==="logout") result=await nativeLogout(session);
      else throw new NativeError("NOT_FOUND",404);
    }
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  } catch(error) {
    const known=error instanceof NativeError;
    if(!known) console.error("Native API operation failed", error instanceof Error?error.name:"unknown");
    // Refusals of a connect (and any unexpected failure) go to the runtime log with the attempt's request id.
    const path=new URL(request.url).pathname.split("/native/")[1]||"";
    if(!known||["connect","challenge"].includes(path)||path.startsWith("status/")) void writeOperationalLog({component:"api",level:known?"warning":"error",
      message:`App API ${request.method} ${path.replace(/^status\/.*/,"status")}: ${known?error.code:`unexpected ${error instanceof Error?error.message:String(error)}`}`.slice(0,1000)});
    return NextResponse.json({code:known?error.code:"SERVICE_UNAVAILABLE",...(known?error.details:{})},{status:known?error.status:503,headers:{"Cache-Control":"no-store"}});
  }
}
export const GET=handle;
export const POST=handle;
