import { NextResponse } from "next/server";
import { currentUser } from "../../../server/auth";
import { jsonError, readJson } from "../../../server/http";
import { realityDefaults, saveRealityDefaults } from "../../../server/reality-defaults";

export const runtime = "nodejs";
export async function GET() {
  if (!(await currentUser())) return jsonError("Authentication required", 401);
  return NextResponse.json(await realityDefaults());
}
export async function PUT(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    if (body.mode !== "auto" && typeof body.serverName !== "string") return jsonError("请填写目标域名");
    return NextResponse.json(await saveRealityDefaults({ mode: body.mode === "auto" ? "auto" : "custom", serverName: body.serverName }, user.id));
  } catch (error) { return jsonError(error instanceof Error ? error.message : "无法保存默认目标", 400); }
}
