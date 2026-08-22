/**
 * IGRIS CLI HTTP client — the ONLY way the CLI touches IGRIS. It never imports the DB
 * or any service; it speaks to the running app's canonical API so validation, permission,
 * approval, and state authority all stay server-side (one path, same as the UI).
 *
 * `fetchImpl` is injectable so command logic is unit-testable without a live server or
 * subprocess. A network failure surfaces as `ServerUnavailableError` → CLI exit code 3.
 */
export type ApiResponse<T = unknown> = { status: number; ok: boolean; data: T };

export class ServerUnavailableError extends Error {
  constructor(public readonly baseUrl: string, cause?: unknown) {
    super(`IGRIS server is not reachable at ${baseUrl}`);
    this.name = 'ServerUnavailableError';
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export class IgrisClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ServerUnavailableError(this.baseUrl, err);
    }
    // Parse JSON when possible; fall back to raw text so errors are never swallowed.
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = { error: (await res.text().catch(() => '')).slice(0, 300) || `HTTP ${res.status}` };
    }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, data: data as T };
  }

  get<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, body ?? {});
  }
  del<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path, body);
  }
}
