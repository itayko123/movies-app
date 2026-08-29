import { useEffect, useState } from 'react';
import {
  I18nManager,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Pressable,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { z } from 'zod';

import { LinearGradient } from 'expo-linear-gradient';
import { AppText } from '@/components/AppText';
import { PosterWall } from '@/components/PosterWall';
import { useWallPosters } from '@/hooks/useWallPosters';
import { C, R, SPACE } from '@/theme/tokens';
import { GlassView } from '@/components/GlassView';
import {
  AppleSignInButton,
  isAppleSignInAvailable,
  isGoogleSignInAvailable,
  readOAuthError,
  signInWithApple as authSignInWithApple,
  signInWithGoogle as authSignInWithGoogle,
} from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { describeRedirect } from '@/lib/authRedirect';
import { hapticSelection, hapticSuccess, hapticWarning } from '@/lib/haptics';
import { useT, type TranslationKey } from '@/i18n';
import { useAppStore } from '@/state/store';

const EmailSchema = z.string().trim().email();

/** Supabase's own OTP resend window. Matching it avoids a guaranteed 429. */
const RESEND_COOLDOWN_SECONDS = 60;

/** Link types Supabase issues for passwordless email sign-in. */
const LINK_TYPES = ['magiclink', 'signup', 'email', 'invite', 'recovery'] as const;
type LinkType = (typeof LINK_TYPES)[number];

/**
 * Pulls the verifiable token out of a pasted magic link.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Whether the email carries a six-digit code or a link is decided by the
 * project's Magic Link TEMPLATE, which lives in the dashboard — no client code
 * can force one or the other. Until that template includes `{{ .Token }}`,
 * every email is a link, and a link is exactly what breaks in local dev: it
 * routes through the project's Site URL, which is not the machine and port the
 * dev server happens to be on, so the user lands somewhere useless while the
 * app sits waiting.
 *
 * Verifying the link's token directly sidesteps the redirect entirely. The user
 * pastes what they were sent and it works, on any port, today.
 *
 * The `type` matters and is read from the URL rather than assumed: a brand new
 * account gets `signup`, an existing one `magiclink`, and verifying with the
 * wrong type fails.
 */
function parseEmailLink(raw: string): { token_hash: string; type: LinkType } | null {
  const text = raw.trim();
  if (!text) return null;

  const asType = (value: string | null): LinkType =>
    (LINK_TYPES as readonly string[]).includes(value ?? '') ? (value as LinkType) : 'email';

  try {
    const url = new URL(text);
    const token = url.searchParams.get('token') ?? url.searchParams.get('token_hash');
    if (token) return { token_hash: token, type: asType(url.searchParams.get('type')) };
  } catch {
    // Not a URL — fall through and treat it as a bare token hash.
  }

  // A pasted token on its own. Long enough not to collide with a 6-digit code.
  if (/^[A-Za-z0-9._-]{20,}$/.test(text)) return { token_hash: text, type: 'email' };
  return null;
}

/**
 * Turns a Supabase auth error into something a user can act on.
 *
 * Every failure used to render the same "Sign-in failed" string, which made
 * the three cases that actually happen — wrong code, expired code, and asking
 * for a new code too soon — indistinguishable, and the last one look like a
 * bug rather than a wait.
 */
interface AuthMessage {
  key: TranslationKey;
  params?: Record<string, string | number>;
  /** Rate limits get a louder treatment — they are a wait, not a mistake. */
  severe?: boolean;
  /** Seconds to lock the resend button for, when the server tells us. */
  cooldown?: number;
}

function authErrorMessage(error: { message?: string; status?: number } | null): AuthMessage {
  const raw = error?.message ?? '';
  const message = raw.toLowerCase();

  if (error?.status === 429 || message.includes('rate limit') || message.includes('too many')) {
    /**
     * Supabase sends two different 429s and conflating them gives bad advice.
     *
     *   "For security purposes, you can only request this after 51 seconds"
     *       → the per-request throttle. Under a minute; just wait.
     *   "email rate limit exceeded"
     *       → the PROJECT's hourly email cap, which on the built-in SMTP is
     *         only a couple of messages an hour. Waiting a minute achieves
     *         nothing, so the honest advice is to wait an hour or test with a
     *         different address.
     */
    const seconds = Number(raw.match(/after (\d+) second/i)?.[1] ?? 0);
    if (seconds > 0) {
      return { key: 'auth.rateLimitedShort', params: { seconds }, cooldown: seconds };
    }
    return { key: 'auth.rateLimited', severe: true, cooldown: RESEND_COOLDOWN_SECONDS };
  }

  if (message.includes('expired')) return { key: 'auth.codeExpired' };
  if (message.includes('invalid') || message.includes('token')) return { key: 'auth.codeInvalid' };
  return { key: 'auth.error' };
}

/**
 * App Store compliance: a B2C app offering third-party login must offer
 * Sign in with Apple (Guideline 4.8). Google Sign-In and email OTP complete
 * the set; all three resolve to the same Supabase identity.
 */
export default function AuthScreen() {
  const t = useT();
  const insets = useSafeAreaInsets();
  const locale = useAppStore((s) => s.locale);

  const [appleAvailable, setAppleAvailable] = useState(false);
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSevere, setErrorSevere] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  /** Second entry route for when the email arrives as a link, not a code. */
  const [link, setLink] = useState('');
  const [showLinkEntry, setShowLinkEntry] = useState(false);
  // The reference login shows only the two social buttons; email is a
  // secondary route revealed on demand rather than a form in the user's face.
  const [showEmail, setShowEmail] = useState(false);
  const wallPosters = useWallPosters();

  useEffect(() => {
    void isAppleSignInAvailable().then(setAppleAvailable);
  }, []);

  // A provider failure comes back as a URL parameter on the redirect, not as a
  // rejected promise — unread, it looks like the button simply did nothing.
  useEffect(() => {
    const oauthError = readOAuthError();
    if (oauthError) setError(oauthError);
  }, []);

  // Resend countdown. Interval rather than a frame loop: this ticks once a
  // second for a minute and must keep running while the tab is unfocused.
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((n) => Math.max(n - 1, 0)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  /** Renders a Supabase auth error, honouring any cooldown it reports. */
  const showAuthError = (err: { message?: string; status?: number } | null) => {
    const info = authErrorMessage(err);
    hapticWarning();
    setError(t(info.key, info.params));
    setErrorSevere(info.severe === true);
    if (info.cooldown) setCooldown(info.cooldown);
  };

  const signInWithApple = async () => {
    setError(null);
    try {
      const outcome = await authSignInWithApple();
      if (outcome === 'success') hapticSuccess();
    } catch {
      hapticWarning();
      setError(t('auth.error'));
    }
  };

  const signInWithGoogle = async () => {
    setError(null);
    setErrorSevere(false);
    setBusy(true);
    try {
      const outcome = await authSignInWithGoogle();
      // 'unavailable' means the provider is switched off on the Supabase
      // project. Saying so beats the old behaviour, where the browser had
      // already left for a raw JSON error page the app never saw.
      if (outcome === 'unavailable') {
        hapticWarning();
        setError(t('auth.googleUnavailable'));
      } else if (outcome === 'success') {
        hapticSuccess();
      }
    } catch (err) {
      hapticWarning();
      setError(
        err instanceof Error && err.message ? err.message : t('auth.error'),
      );
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async () => {
    const parsed = EmailSchema.safeParse(email);
    if (!parsed.success) {
      setError(t('auth.invalidEmail'));
      return;
    }
    setBusy(true);
    setError(null);
    setErrorSevere(false);
    hapticSelection();

    /**
     * `emailRedirectTo` is derived, never hard-coded.
     *
     * It only affects the LINK half of the email — the six-digit token from
     * {{ .Token }} is unaffected — but on a phone the link half is the half
     * that breaks. Without this, the link targets the project's Site URL,
     * which is a web address the device cannot open as the app, so the user
     * taps it and lands in Safari looking at nothing useful.
     *
     * authRedirectUri() resolves to cineswipe:// on a build and the exp://
     * tunnel URL in Expo Go, so the same code works in both.
     */
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: parsed.data,
      options: {
        shouldCreateUser: true,
        data: { locale },
        emailRedirectTo: describeRedirect('email OTP'),
      },
    });
    setBusy(false);

    if (otpError) {
      showAuthError(otpError);
      return;
    }

    setStep('code');
    setCode('');
    setCooldown(RESEND_COOLDOWN_SECONDS);
  };

  const verifyCode = async (submitted?: string) => {
    const token = (submitted ?? code).replace(/\D/g, '');
    if (token.length !== 6 || busy) return;

    setBusy(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: EmailSchema.parse(email),
      token,
      type: 'email',
    });
    setBusy(false);

    if (verifyError) {
      showAuthError(verifyError);
      setCode('');
      return;
    }
    // The session lands via onAuthStateChange in _layout, which routes away.
    hapticSuccess();
  };

  /**
   * Digits only, and submit itself on the sixth.
   *
   * Codes get pasted as often as typed, and mail clients happily wrap them in
   * spaces — stripping non-digits means "123 456" works. Auto-submitting
   * removes the one step where nothing else could possibly be intended.
   */
  const onCodeChange = (next: string) => {
    const digits = next.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    if (digits.length === 6) void verifyCode(digits);
  };

  /**
   * Verifies a pasted magic link (or bare token hash).
   *
   * Uses token_hash rather than the six-digit token, because that is what the
   * link actually carries — and it works no matter what the email template is
   * set to, so email sign-in is usable before the dashboard is touched.
   */
  const verifyLink = async () => {
    const parsed = parseEmailLink(link);
    if (!parsed || busy) {
      setError(t('auth.linkInvalid'));
      return;
    }
    setBusy(true);
    setError(null);

    const { error: verifyError } = await supabase.auth.verifyOtp({
      token_hash: parsed.token_hash,
      type: parsed.type,
    });
    setBusy(false);

    if (verifyError) {
      showAuthError(verifyError);
      return;
    }
    hapticSuccess();
  };

  const inputStyle = {
    includeFontPadding: false,
    textAlignVertical: 'center' as const,
    textAlign: (I18nManager.isRTL ? 'right' : 'left') as 'left' | 'right',
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-app"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Auto-scrolling wall of posters. Renders and animates at 0ms on
          designed tiles; real art fades in as it resolves. */}
      <PosterWall posters={wallPosters} />

      {/* Heavy readability scrim. The reference fades to solid black across
          the bottom half so the copy sits on ink, not on artwork. */}
      <LinearGradient
        colors={['rgba(0,0,0,0.35)', 'rgba(0,0,0,0.82)', '#000000', '#000000']}
        locations={[0, 0.42, 0.66, 1]}
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
        pointerEvents="none"
      />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'flex-end',
          paddingHorizontal: SPACE.xxl,
          paddingTop: insets.top + SPACE.section,
          paddingBottom: insets.bottom + SPACE.xxl,
          gap: SPACE.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Brand — anchored bottom-start like the reference, not centred. */}
        <View style={{ gap: SPACE.sm }}>
          <AppText variant="hero" className="text-txt text-start">
            {t('auth.welcome')}
          </AppText>
          <AppText variant="body" className="text-start">
            {t('auth.tagline')}
          </AppText>
        </View>

        <View className="gap-3">
          {/* Sign in with Apple — required for App Store review. */}
          {appleAvailable && <AppleSignInButton onPress={() => void signInWithApple()} />}

          {isGoogleSignInAvailable() && (
            <Pressable
              onPress={() => void signInWithGoogle()}
              accessibilityRole="button"
              className="bg-white flex-row items-center justify-center gap-2.5"
              style={{ height: 54, borderRadius: R.card }}
            >
              <Ionicons name="logo-google" size={20} color="#0B0B0E" />
              <AppText variant="bodyStrong" className="text-txt-onlight">
                {t('auth.google')}
              </AppText>
            </Pressable>
          )}

          {/* Secondary route, reference-style: a quiet link rather than a
              form. Revealing it keeps every existing OTP handler intact. */}
          {!showEmail && (
            <Pressable
              onPress={() => setShowEmail(true)}
              accessibilityRole="button"
              className="items-center"
              style={{ paddingVertical: SPACE.md, marginTop: SPACE.xs }}
            >
              <AppText variant="bodyStrong" style={{ color: C.textSecondary }}>
                {t('auth.emailInstead')}
              </AppText>
            </Pressable>
          )}

          {showEmail && (
          <>
          <View className="flex-row items-center gap-3 my-1">
            <View className="flex-1 h-px bg-divider" />
            <AppText variant="caption">{t('auth.or')}</AppText>
            <View className="flex-1 h-px bg-divider" />
          </View>

          {/* Email OTP */}
          {step === 'email' ? (
            <View className="gap-3">
              <GlassView className="rounded-2xl px-5">
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder={t('auth.emailPlaceholder')}
                  placeholderTextColor="rgba(250,250,250,0.35)"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  className="text-txt font-sans text-[15px] py-4"
                  style={inputStyle}
                />
              </GlassView>
              <Pressable
                onPress={() => void sendCode()}
                disabled={busy}
                accessibilityRole="button"
                className="bg-brand rounded-2xl h-[52px] items-center justify-center"
                style={{ opacity: busy ? 0.6 : 1 }}
              >
                <AppText variant="bodyStrong" className="text-txt-onlight">
                  {t('auth.sendCode')}
                </AppText>
              </Pressable>
            </View>
          ) : (
            <View className="gap-3">
              {/* Naming the address is what catches a typo — otherwise a code
                  sent to the wrong inbox just looks like it never arrived. */}
              <AppText variant="caption" className="text-center">
                {t('auth.codeSentTo', { email: email.trim() })}
              </AppText>
              <GlassView className="rounded-2xl px-5">
                <TextInput
                  value={code}
                  onChangeText={onCodeChange}
                  placeholder={t('auth.codePlaceholder')}
                  placeholderTextColor="rgba(250,250,250,0.35)"
                  keyboardType="number-pad"
                  inputMode="numeric"
                  maxLength={6}
                  autoFocus
                  // Lets iOS and Android offer the code straight from the SMS/
                  // mail notification instead of making the user switch apps.
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  accessibilityLabel={t('auth.codePlaceholder')}
                  className="text-txt font-sans text-[18px] py-4 tracking-[8px]"
                  style={[inputStyle, { textAlign: 'center' }]}
                />
              </GlassView>
              <Pressable
                onPress={() => void verifyCode()}
                disabled={busy || code.length < 6}
                accessibilityRole="button"
                className="bg-brand rounded-2xl h-[52px] items-center justify-center"
                style={{ opacity: busy || code.length < 6 ? 0.6 : 1 }}
              >
                <AppText variant="bodyStrong" className="text-txt-onlight">
                  {busy ? t('common.loading') : t('auth.verify')}
                </AppText>
              </Pressable>

              {/* Escape hatch for a project whose Magic Link template has not
                  been switched to {{ .Token }} yet: the email carries a link
                  rather than a code, and locally that link goes nowhere
                  useful. Pasting it here verifies the same token directly. */}
              {showLinkEntry ? (
                <View className="gap-2">
                  <AppText variant="caption" className="text-center">
                    {t('auth.pasteLinkHint')}
                  </AppText>
                  <GlassView className="rounded-2xl px-5">
                    <TextInput
                      value={link}
                      onChangeText={setLink}
                      placeholder={t('auth.pasteLinkPlaceholder')}
                      placeholderTextColor="rgba(250,250,250,0.35)"
                      autoCapitalize="none"
                      autoCorrect={false}
                      multiline
                      accessibilityLabel={t('auth.pasteLinkPlaceholder')}
                      className="text-txt font-sans text-[13px] py-3"
                      style={inputStyle}
                    />
                  </GlassView>
                  <Pressable
                    onPress={() => void verifyLink()}
                    disabled={busy || link.trim().length === 0}
                    accessibilityRole="button"
                    className="bg-brand rounded-2xl h-[48px] items-center justify-center"
                    style={{ opacity: busy || link.trim().length === 0 ? 0.6 : 1 }}
                  >
                    <AppText variant="bodyStrong" className="text-txt-onlight">
                      {t('auth.verifyLink')}
                    </AppText>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={() => setShowLinkEntry(true)}
                  accessibilityRole="button"
                  className="items-center py-1"
                >
                  <AppText variant="caption" className="underline">
                    {t('auth.gotLinkInstead')}
                  </AppText>
                </Pressable>
              )}

              <Pressable
                onPress={() => void sendCode()}
                disabled={busy || cooldown > 0}
                accessibilityRole="button"
                className="items-center py-1"
              >
                <AppText variant="caption" className={cooldown > 0 ? '' : 'underline'}>
                  {cooldown > 0 ? t('auth.resendIn', { seconds: cooldown }) : t('auth.resend')}
                </AppText>
              </Pressable>

              <Pressable
                onPress={() => {
                  setStep('email');
                  setCode('');
                  setError(null);
                }}
                accessibilityRole="button"
                className="items-center py-2"
              >
                <AppText variant="caption" className="underline">
                  {t('auth.changeEmail')}
                </AppText>
              </Pressable>
            </View>
          )}
          </>
          )}

          {/* A rate limit is a wait, not a typo — it gets a banner rather than
              a line of red text, because the difference decides whether the
              user retries immediately (and extends the lockout) or stops. */}
          {error && (
            <View
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              className="flex-row items-start gap-2 rounded-2xl px-4 py-3"
              style={{
                backgroundColor: errorSevere ? 'rgba(250,204,21,0.12)' : 'rgba(232,80,63,0.10)',
              }}
            >
              <Ionicons
                name={errorSevere ? 'hourglass-outline' : 'alert-circle-outline'}
                size={16}
                color={errorSevere ? '#FBBF24' : '#E8503F'}
                style={{ marginTop: 1 }}
              />
              <AppText
                variant="caption"
                className="flex-1"
                style={{ color: errorSevere ? '#FBBF24' : '#E8503F' }}
              >
                {error}
              </AppText>
            </View>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
