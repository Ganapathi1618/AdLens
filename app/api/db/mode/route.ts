// The data mode as JSON. The pages get it from the root layout via
// DataModeProvider; this endpoint exists for scripts and for checking a
// deployment's state without opening the UI.

import { NextResponse } from "next/server";
import { getDataMode } from "@/lib/dataMode";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET() {
  return NextResponse.json(await getDataMode(), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
