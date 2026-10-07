/** A scripted HTTP response, or a network-level failure. */
export type FakeResponse =
  | { readonly status?: number; readonly body: string; readonly contentType?: string }
  | { readonly networkError: Error };

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  /** Body parsed as JSON. */
  json(): any;
}

export interface FakeFetch {
  readonly fetch: typeof fetch;
  readonly requests: RecordedRequest[];
}

/**
 * Scripted replacement for the global fetch. Responses are consumed in order,
 * or computed from the request when a function is given. No network involved.
 */
export function createFakeFetch(
  script: readonly FakeResponse[] | ((request: RecordedRequest, index: number) => FakeResponse),
): FakeFetch {
  const requests: RecordedRequest[] = [];

  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const request: RecordedRequest = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? 'GET',
      headers,
      body,
      json: () => JSON.parse(body ?? 'null'),
    };
    const index = requests.length;
    requests.push(request);

    const response = typeof script === 'function' ? script(request, index) : script[index];
    if (response === undefined) {
      throw new Error(`FakeFetch: no scripted response for request #${index + 1} (${request.url})`);
    }
    if ('networkError' in response) {
      throw response.networkError;
    }
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: { 'content-type': response.contentType ?? 'application/json' },
    });
  };

  return { fetch: fakeFetch as typeof fetch, requests };
}
