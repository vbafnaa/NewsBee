export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail ?? `Request failed (${response.status})`);
  return data as T;
}

export const adminApi = <T>(path: string, init?: RequestInit) => apiJson<T>(`/api/admin/${path}`, init);
export const mapApi = <T>(path: string, init?: RequestInit) => apiJson<T>(`/api/maps/${path}`, init);
