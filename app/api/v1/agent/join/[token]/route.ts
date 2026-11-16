import { findJoinToken, joinScript, refusalScript } from "../../../../../../server/node-join";
import { writeOperationalLog } from "../../../../../../server/operational-logs";
import { recordAuthFailure } from "../../../../../../server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const script = (text: string) => new Response(text, { headers: { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-store" } });

// Chat apps (Lark/Feishu, WeChat, Slack, Telegram) and browsers open a pasted link to build a preview. Only a
// command-line download gets the install script, so a preview neither issues an Agent token nor starts an install.
const SHELL_DOWNLOADER = /^(curl|wget)\//i;

/** `curl -fsSL <agent domain>/api/v1/agent/join/<token> | sh`: the install command shown in Console. */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const userAgent = request.headers.get("user-agent") ?? "";
  if (!SHELL_DOWNLOADER.test(userAgent)) {
    void writeOperationalLog({ action: "node.join.preview_ignored", component: "bootstrap", level: "info", message: `Install command link opened outside a terminal (${userAgent.slice(0, 120) || "no user agent"}); not used.` });
    return new Response("Run this install command in a terminal on the node: curl -fsSL <this link> | sh\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const nodeId = await findJoinToken(token);
  if (!nodeId) {
    recordAuthFailure(request, "join-token");
    void writeOperationalLog({ action: "node.join.refused", component: "bootstrap", level: "warning", message: "Install command refused: token unknown, expired, or the node already came online with it." });
    return script(refusalScript("This install command has expired, or the node already came online with it. Copy a new one from Console (Nodes → the node → Install command)."));
  }
  try {
    void writeOperationalLog({ nodeId, action: "node.join.downloaded", component: "bootstrap", level: "info", message: `Install command downloaded (${userAgent.slice(0, 60)}).` });
    return script(await joinScript(nodeId));
  } catch (error) {
    return script(refusalScript(`The Controller could not prepare the install: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/** A HEAD (link checkers, some proxies) never starts an install. */
export function HEAD() {
  return new Response(null, { headers: { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-store" } });
}
