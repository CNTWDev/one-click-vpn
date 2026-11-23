import { releaseRoute } from "../handler";
import { recordRegression } from "../../../../../../server/regression-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CI (release token) reports a real-device regression run: { version, trigger, runUrl, cases: [{ platform, case, ok, detail }], skipped }. */
export async function POST(request: Request) {
  return releaseRoute(request, (_actor, body) => recordRegression(body));
}
