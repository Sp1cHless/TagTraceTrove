import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../src/api/client.js';

describe('createApiClient', () => {
  it('builds an encoded HTTP request without knowing database structure', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      Response.json({ entries: [] }, { status: 200 }),
    );
    const client = createApiClient({
      baseUrl: 'http://127.0.0.1:8765/api/',
      fetchImplementation,
    });

    const response = await client.request<{ entries: unknown[] }>('collections/7/search', {
      method: 'POST',
      query: { q: 'school life', archived: false },
      body: { include: ['tag:1'] },
    });

    expect(response).toEqual({ entries: [] });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/collections/7/search?q=school+life&archived=false',
      expect.objectContaining({
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ include: ['tag:1'] }),
      }),
    );
  });

  it('preserves HTTP status and server error payloads', async () => {
    const client = createApiClient({
      baseUrl: 'http://127.0.0.1:8765/api/',
      fetchImplementation: async () =>
        Response.json({
          error: { code: 'VALIDATION_ERROR', message: 'Invalid filter' },
        }, { status: 400 }),
    });

    const request = client.request('collections/7/search');

    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Invalid filter',
      status: 400,
      payload: { error: { code: 'VALIDATION_ERROR', message: 'Invalid filter' } },
    });
  });
});