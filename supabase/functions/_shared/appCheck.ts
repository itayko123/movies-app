import { createRemoteJWKSet, jwtVerify } from 'npm:jose@5.9.6';

// Firebase App Check public keys (Play Integrity on Android, DeviceCheck on iOS).
const APP_CHECK_JWKS = createRemoteJWKSet(
  new URL('https://firebaseappcheck.googleapis.com/v1/jwks'),
);

export type AppCheckResult = { ok: true } | { ok: false; error: string };

/**
 * Verifies the X-Firebase-AppCheck token so only the compiled, attested app
 * can trigger paid AI work. Set APP_CHECK_ENFORCED=false only for local dev.
 */
export async function verifyAppCheck(req: Request): Promise<AppCheckResult> {
  const enforced =
    (Deno.env.get('APP_CHECK_ENFORCED') ?? 'true').toLowerCase() !== 'false';
  if (!enforced) return { ok: true };

  const projectNumber = Deno.env.get('FIREBASE_PROJECT_NUMBER');
  if (!projectNumber) {
    console.error('FIREBASE_PROJECT_NUMBER is not set while App Check is enforced');
    return { ok: false, error: 'app_check_misconfigured' };
  }

  const token = req.headers.get('X-Firebase-AppCheck');
  if (!token) return { ok: false, error: 'app_check_token_missing' };

  try {
    const { payload, protectedHeader } = await jwtVerify(token, APP_CHECK_JWKS, {
      issuer: `https://firebaseappcheck.googleapis.com/${projectNumber}`,
      audience: `projects/${projectNumber}`,
    });
    if (protectedHeader.alg !== 'RS256' || typeof payload.sub !== 'string') {
      return { ok: false, error: 'app_check_invalid' };
    }
    return { ok: true };
  } catch (_err) {
    return { ok: false, error: 'app_check_invalid' };
  }
}
