import { handleBlitzExperimentalRequest } from "../../../../lib/lightning/blitz-experimental.ts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const result = await handleBlitzExperimentalRequest(body, {
    baseUrl: process.env.BLITZ_OBSERVER_API_BASE_URL,
    token: process.env.BLITZ_OBSERVER_API_TOKEN,
  });
  return Response.json(result.body, { status: result.httpStatus, headers: { "Cache-Control": "no-store, max-age=0" } });
}
