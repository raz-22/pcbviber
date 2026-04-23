import type { PartSearchResult, PartAvailabilitySummary } from "@altium-mcp/shared";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.detail ? ` (${JSON.stringify(j.detail)})` : j.error ?? "";
    } catch {
      detail = await res.text();
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? ": " + detail : ""}`);
  }
  return (await res.json()) as T;
}

export const api = {
  searchParts: (query: string, limit = 10) =>
    get<PartSearchResult[]>(
      `/api/parts/search?query=${encodeURIComponent(query)}&limit=${limit}`
    ),

  checkAvailability: (mpn: string) =>
    get<PartAvailabilitySummary | { notFound: true; mpn: string }>(
      `/api/parts/availability?mpn=${encodeURIComponent(mpn)}`
    ),

  health: () => get<{ ok: boolean; version: string }>("/api/health"),
};
