import { useCallback, useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { checkProfanity } from '@/lib/profanity';
import { hapticSelection, hapticSuccess, hapticWarning } from '@/lib/haptics';
import { useT } from '@/i18n';
import { useAppStore, type Review } from '@/state/store';
import { C } from '@/theme/tokens';

const MAX_LENGTH = 500;
const MIN_LENGTH = 4;

function Stars({
  value,
  onChange,
  size = 26,
}: {
  value: number;
  onChange?: (next: number) => void;
  size?: number;
}) {
  const t = useT();
  return (
    <View className="flex-row gap-1">
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= value;
        const icon = filled ? 'star' : 'star-outline';
        if (!onChange) {
          return <Ionicons key={star} name={icon} size={size} color="#FBBF24" />;
        }
        return (
          <PressableScale
            key={star}
            onPress={() => {
              hapticSelection();
              onChange(star);
            }}
            haptic="none"
            activeScale={0.85}
            accessibilityRole="button"
            accessibilityLabel={t('reviews.starLabel', { count: star })}
            accessibilityState={{ selected: filled }}
            style={{ padding: 2 }}
          >
            <Ionicons name={icon} size={size} color="#FBBF24" />
          </PressableScale>
        );
      })}
    </View>
  );
}

function ReviewRow({ review, onDelete }: { review: Review; onDelete: () => void }) {
  return (
    <GlassView className="rounded-3xl p-4 gap-2">
      <View className="flex-row items-center justify-between">
        <Stars value={review.rating} size={15} />
        <View className="flex-row items-center gap-3">
          <AppText variant="caption" className="text-txt-tertiary">
            {new Date(review.at).toLocaleDateString()}
          </AppText>
          <PressableScale
            onPress={() => {
              hapticWarning();
              onDelete();
            }}
            haptic="none"
            activeScale={0.9}
            accessibilityRole="button"
            accessibilityLabel="delete review"
            style={{ padding: 2 }}
          >
            <Ionicons name="trash-outline" size={15} color="#64748B" />
          </PressableScale>
        </View>
      </View>
      <AppText variant="body" className="text-txt">
        {review.body}
      </AppText>
    </GlassView>
  );
}

/**
 * User reviews for one title.
 *
 * Reviews are stored LOCALLY (see store.reviews). There is no reviews table
 * yet, so these are the user's own notes rather than a public feed — which is
 * stated in the UI rather than implied, because a review box that looks public
 * and is not would be a lie about where someone's words are going.
 *
 * The profanity gate runs on every keystroke so the submit button reflects the
 * current text, and again on submit. It is a UX guardrail only: the same check
 * MUST exist server-side before these are ever shared (see src/lib/profanity.ts).
 */
export function ReviewSection({ mediaKey }: { mediaKey: string }) {
  const t = useT();
  const reviews = useAppStore((s) => s.reviews[mediaKey]);
  const addReview = useAppStore((s) => s.addReview);
  const removeReview = useAppStore((s) => s.removeReview);

  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [showError, setShowError] = useState(false);

  const profanity = useMemo(() => checkProfanity(body), [body]);
  const tooShort = body.trim().length < MIN_LENGTH;
  const canSubmit = rating > 0 && !tooShort && profanity.clean;

  const submit = useCallback(() => {
    // Re-checked here rather than trusting the disabled state: the button can
    // be reached by assistive tech, and the text could change between renders.
    const check = checkProfanity(body);
    if (rating === 0 || body.trim().length < MIN_LENGTH || !check.clean) {
      setShowError(true);
      hapticWarning();
      return;
    }
    addReview(mediaKey, rating, body);
    hapticSuccess();
    setBody('');
    setRating(0);
    setShowError(false);
  }, [addReview, body, mediaKey, rating]);

  const list = reviews ?? [];

  return (
    <View className="gap-3">
      <View className="gap-1">
        <AppText variant="subtitle">{t('reviews.title')}</AppText>
        <AppText variant="caption">{t('reviews.privateNote')}</AppText>
      </View>

      <GlassView className="rounded-3xl p-4 gap-3">
        <View className="flex-row items-center justify-between">
          <AppText variant="caption">{t('reviews.yourRating')}</AppText>
          <Stars value={rating} onChange={setRating} />
        </View>

        <TextInput
          value={body}
          onChangeText={(text) => {
            setBody(text.slice(0, MAX_LENGTH));
            if (showError) setShowError(false);
          }}
          placeholder={t('reviews.placeholder')}
          placeholderTextColor="#52525B"
          multiline
          numberOfLines={4}
          maxLength={MAX_LENGTH}
          accessibilityLabel={t('reviews.title')}
          style={{
            backgroundColor: '#000000',
            borderRadius: 14,
            // The border is the live signal: it turns red the moment the text
            // would be rejected, so nobody types 300 words then gets blocked.
            color: '#FAFAFA',
            padding: 14,
            minHeight: 96,
            textAlignVertical: 'top',
          }}
        />

        <View className="flex-row items-center justify-between">
          <AppText variant="caption" className="text-txt-tertiary">
            {body.length}/{MAX_LENGTH}
          </AppText>

          {!profanity.clean ? (
            <View className="flex-row items-center gap-1.5 flex-1 ms-3">
              <Ionicons name="alert-circle" size={14} color="#E8503F" />
              <AppText variant="caption" numberOfLines={2} className="flex-1 text-nope">
                {t('reviews.profanityBlocked')}
              </AppText>
            </View>
          ) : showError ? (
            <AppText variant="caption" className="flex-1 ms-3 text-nope">
              {rating === 0 ? t('reviews.needRating') : t('reviews.needText')}
            </AppText>
          ) : null}
        </View>

        <PressableScale
          onPress={submit}
          disabled={!canSubmit}
          haptic="none"
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit }}
          style={{
            backgroundColor: canSubmit ? '#00B8D9' : '#1A2233',
            borderRadius: 999,
            paddingVertical: 13,
            alignItems: 'center',
          }}
        >
          {/* Only the ENABLED branch sits on accent; disabled is dim ink on
              C.surfaceRaised, where the tertiary grey is already correct. */}
          <AppText
            variant="bodyStrong"
            style={{ color: canSubmit ? C.onAccent : C.textTertiary }}
          >
            {t('reviews.submit')}
          </AppText>
        </PressableScale>
      </GlassView>

      {list.length === 0 ? (
        <AppText variant="caption" className="text-txt-tertiary">
          {t('reviews.empty')}
        </AppText>
      ) : (
        list.map((review) => (
          <ReviewRow
            key={review.id}
            review={review}
            onDelete={() => removeReview(mediaKey, review.id)}
          />
        ))
      )}
    </View>
  );
}
