import { NextResponse } from "next/server";
import { requestAdmin } from "../../../../../../../server/request-auth";
import { readJson } from "../../../../../../../server/http";
import { accountDevices, updateNativeAccess } from "../../../../../../../server/native-admin";
import { NativeError } from "../../../../../../../server/native-proof";
export const runtime="nodejs";
async function handle(request:Request,context:{params:Promise<{id:string}>}) {
  if (process.env.VEILBIRD_NATIVE_ACCESS_ENABLED!=="1") return NextResponse.json({error:"原生设备授权尚未启用"},{status:503});
  const admin=await requestAdmin(request);
  if (!admin) return NextResponse.json({error:"Administrator authentication required"},{status:403});
  try {
    const {id}=await context.params;
    const result=request.method==="GET"?await accountDevices(id):await updateNativeAccess(id,admin.id,await readJson(request));
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  } catch(error) {
    return NextResponse.json({error:error instanceof NativeError?error.code:"操作失败，请稍后重试"},{status:error instanceof NativeError?error.status:503});
  }
}
export const GET=handle;
export const POST=handle;
