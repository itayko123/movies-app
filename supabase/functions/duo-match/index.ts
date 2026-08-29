// Duo-Match: verifies membership via the caller's JWT and runs the
// `duo_match` RPC, which intersects both taste vectors and stores the top-3
// mutual picks. Clients receive them via Realtime (postgres_changes on
// duo_picks) as well as in this response.

import { z } from 'npm:zod@3.24.1';
import { handleOptions, jsonResponse } from '../_shared/cors.ts';
import { verifyAppCheck } from '../_shared/appCheck.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { adminClient, userClient } from '../_shared/clients.ts';

const BodySchema = z.object({
  session_id: z.string().uuid(),
});

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  try {
    const attestation = await verifyAppCheck(req);
    if (!attestation.ok) return jsonResponse({ error: attestation.error }, 403);

    const supabase = userClient(req);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) return jsonResponse({ error: 'not_authenticated' }, 401);

    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: 'invalid_body' }, 400);

    const limit = await checkRateLimit(adminClient(), user.id, 'duo-match', 20, 3600);
    if (!limit.allowed) {
      return jsonResponse(
        { error: 'rate_limited', retry_after_seconds: limit.retry_after_seconds },
        429,
      );
    }

    // User-scoped call: duo_match raises 42501 unless the caller is a member.
    const { data: picks, error } = await supabase.rpc('duo_match', {
      p_session_id: parsed.data.session_id,
    });

    if (error) {
      const status = error.message.includes('not_a_member')
        ? 403
        : error.message.includes('duo_session_not_ready') ||
            error.message.includes('taste_profile_incomplete')
          ? 409
          : 500;
      return jsonResponse({ error: error.message }, status);
    }

    return jsonResponse({ picks: picks ?? [] });
  } catch (err) {
    console.error('duo-match failed:', err);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
});
