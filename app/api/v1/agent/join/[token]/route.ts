import { consumeJoinToken, joinScript, refusalScript } from "../../../../../../server/node-join";
import { recordAuthFailure } from "../../../../../../server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const script = (text: string) => new Response(text, { headers: { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-store" } });

/** `curl -fsSL <agent domain>/api/v1/agent/join/<token> | sh`: the one-time install command shown in Console. */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const nodeId = await consumeJoinToken(token);
  if (!nodeId) {
    recordAuthFailure(request, "join-token");
    return script(refusalScript("This install command has expired or was already used. Copy a new one from Console (Nodes → the node → Install command)."));
  }
  try {
    return script(await joinScript(nodeId));
  } catch (error) {
    return script(refusalScript(`The Controller could not prepare the install: ${error instanceof Error ? error.message : String(error)}`));
  }
}
