export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.detail ?? `Request failed (${response.status})`, response.status, data.code);
  return data as T;
}

export const adminApi = <T>(path: string, init?: RequestInit) => apiJson<T>(`/api/admin/${path}`, init);
export const mapApi = <T>(path: string, init?: RequestInit) => apiJson<T>(`/api/maps/${path}`, init);

/** Adds the newsroom a journalist is working from, which scopes community-level APIs to that newsroom. */
export function withPublication(path: string, publicationId?: string | null) {
  if (!publicationId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}publication=${encodeURIComponent(publicationId)}`;
}
