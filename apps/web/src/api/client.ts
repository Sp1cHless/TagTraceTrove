import { apiErrorResponseSchema } from '@t3/shared';

export type ApiQueryValue = string | number | boolean | null | undefined;

export interface ApiRequestOptions {
  method?: string;
  query?: Record<string, ApiQueryValue>;
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  baseUrl: string;
  fetchImplementation?: typeof fetch;
}

export interface ApiClient {
  request<T>(path: string, options?: ApiRequestOptions): Promise<T>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown) {
    const parsedError = apiErrorResponseSchema.safeParse(payload);
    const legacyMessage = typeof payload === 'object'
      && payload !== null
      && 'message' in payload
      && typeof payload.message === 'string'
      ? payload.message
      : null;
    const message = parsedError.success
      ? parsedError.data.error.message
      : legacyMessage ?? `HTTP request failed with status ${status}`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

function buildRequestUrl(
  baseUrl: string,
  path: string,
  query: Record<string, ApiQueryValue>,
): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(path.replace(/^\/+/, ''), normalizedBaseUrl);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImplementation = options.fetchImplementation ?? fetch;

  return {
    async request<T>(path: string, requestOptions: ApiRequestOptions = {}): Promise<T> {
      const hasBody = requestOptions.body !== undefined;
      const hasFormData = requestOptions.formData !== undefined;
      if (hasBody && hasFormData) {
        throw new Error('An API request cannot contain both JSON and multipart bodies');
      }
      const response = await fetchImplementation(
        buildRequestUrl(options.baseUrl, path, requestOptions.query ?? {}),
        {
          method: requestOptions.method ?? 'GET',
          headers: {
            Accept: 'application/json',
            ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(hasBody ? { body: JSON.stringify(requestOptions.body) } : {}),
          ...(hasFormData ? { body: requestOptions.formData } : {}),
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );

      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new ApiError(response.status, payload);
      }

      return payload as T;
    },
  };
}