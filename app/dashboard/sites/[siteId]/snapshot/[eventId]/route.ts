import { NextResponse } from "next/server";
import { getSessionClient } from "@/lib/supabase-auth";
import { getServiceClient } from "@/lib/supabase";

// On-demand snapshot viewer: the events list stays image-free (fast); clicking
// generates a short-lived signed URL and redirects. RLS gates access.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ siteId: string; eventId: string }> },
) {
  const { eventId } = await params;

  const session = await getSessionClient();
  const { data: event } = await session
    .from("events")
    .select("media")
    .eq("event_id", eventId)
    .maybeSingle();

  const path = (event?.media as { snapshot_path?: string } | null)
    ?.snapshot_path;
  if (!path) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const service = getServiceClient();
  const { data: signed } = await service.storage
    .from("snapshots")
    .createSignedUrl(path, 300);
  if (!signed?.signedUrl) {
    return NextResponse.json({ error: "sign_failed" }, { status: 500 });
  }
  return NextResponse.redirect(signed.signedUrl, 302);
}
