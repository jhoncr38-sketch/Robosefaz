import "server-only";

import { getAccessToken } from "@/lib/auth";

// URL da API FastAPI (somente servidor). O token do usuário é repassado para
// que a API valide sessão e papel no Supabase.
export const WORKER_API_URL = (process.env.WORKER_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

export class WorkerApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new WorkerApiError("Sessão expirada.", 401);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(`${WORKER_API_URL}${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    throw new WorkerApiError(
      `API do worker indisponível em ${WORKER_API_URL}. Verifique se o uvicorn está em execução.`,
      503,
    );
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      // resposta sem JSON
    }
    throw new WorkerApiError(detail, res.status);
  }
  return res;
}

export async function workerJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await workerFetch(path, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function workerHealth(): Promise<{ status: string; browser: boolean; database: boolean } | null> {
  try {
    const res = await fetch(`${WORKER_API_URL}/health`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
