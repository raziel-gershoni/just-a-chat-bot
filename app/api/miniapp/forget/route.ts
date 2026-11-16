import { handleForget } from "@/src/miniapp/routes";
import { serverDeps } from "@/src/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleForget(req, serverDeps().miniapp);
}
