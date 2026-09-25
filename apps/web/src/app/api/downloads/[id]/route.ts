import { NextResponse, type NextRequest } from "next/server";

import { getSession } from "@/lib/auth";
import { WorkerApiError, workerFetch } from "@/lib/worker-api";

// Repassa o arquivo (salvo no disco do worker) ao usuário autenticado.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/downloads/[id]">) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "ID inválido" }, { status: 400 });

  try {
    const res = await workerFetch(`/downloads/${id}/file`);
    const headers = new Headers();
    headers.set("Content-Type", res.headers.get("content-type") ?? "application/zip");
    const disposition = res.headers.get("content-disposition");
    if (disposition) headers.set("Content-Disposition", disposition);
    const length = res.headers.get("content-length");
    if (length) headers.set("Content-Length", length);
    headers.set("Cache-Control", "private, no-store");
    return new NextResponse(res.body, { status: 200, headers });
  } catch (e) {
    const status = e instanceof WorkerApiError ? e.status : 500;
    const message = e instanceof Error ? e.message : "Erro ao baixar arquivo";
    return NextResponse.json({ error: message }, { status });
  }
}
