import { redirect } from "next/navigation";

// Connect moved into the settings tabs — keep old links working.
export default async function ConnectRedirect({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  redirect(`/dashboard/sites/${siteId}/settings?tab=connect`);
}
