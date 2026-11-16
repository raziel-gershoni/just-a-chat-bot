import { handleGetSettings, handlePutSettings } from "@/src/miniapp/routes";
import { serverDeps } from "@/src/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleGetSettings(req, serverDeps().miniapp);
}

export async function PUT(req: Request): Promise<Response> {
  return handlePutSettings(req, serverDeps().miniapp);
}
