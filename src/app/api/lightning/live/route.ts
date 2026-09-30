import { handleLiveLightningRequest } from "@/lib/lightning/handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); }
  catch { body = null; }

  const result = await handleLiveLightningRequest(body, {
    clientId: process.env.XWEATHER_CLIENT_ID,
    clientSecret: process.env.XWEATHER_CLIENT_SECRET,
  });

  return Response.json(result.body, {
    status: result.httpStatus,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
