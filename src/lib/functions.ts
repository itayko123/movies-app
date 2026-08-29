import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { getAppCheckToken } from '@/lib/appCheck';

export class EdgeFunctionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(code);
    this.name = 'EdgeFunctionError';
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/**
 * Invokes a Supabase Edge Function with the App Check attestation header.
 * Throws EdgeFunctionError with a stable `code` for UI-level handling
 * (rate_limited, app_check_*, not_authenticated, …).
 */
export async function invokeFunction<TResponse>(
  name: 'mood-search' | 'duo-match' | 'embed-media' | 'llm-proxy',
  body: Record<string, unknown>,
): Promise<TResponse> {
  const appCheckToken = await getAppCheckToken();

  const { data, error } = await supabase.functions.invoke<TResponse>(name, {
    body,
    headers: appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {},
  });

  if (error) {
    if (error instanceof FunctionsHttpError) {
      const status = error.context.status;
      let code = 'internal_error';
      let retryAfter: number | null = null;
      try {
        const payload = (await error.context.json()) as {
          error?: string;
          retry_after_seconds?: number;
        };
        if (payload.error) code = payload.error;
        if (typeof payload.retry_after_seconds === 'number') {
          retryAfter = payload.retry_after_seconds;
        }
      } catch {
        // Non-JSON error body — keep the generic code.
      }
      throw new EdgeFunctionError(code, status, retryAfter);
    }
    throw new EdgeFunctionError('network_error', 0);
  }

  if (data == null) {
    throw new EdgeFunctionError('empty_response', 0);
  }
  return data;
}
