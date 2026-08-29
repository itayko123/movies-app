import { forwardRef } from 'react';
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

export type TextVariant =
  | 'hero'
  | 'title'
  | 'subtitle'
  | 'body'
  | 'bodyStrong'
  | 'caption'
  | 'label';

const VARIANT_CLASS: Record<TextVariant, string> = {
  // Headers use Rubik ExtraBold/Bold rather than Secular One: the reference
  // app's headers are visibly heavy, and Secular One ships a single 400 weight
  // so it cannot get heavier. Rubik has a real 800 and equally good Hebrew
  // coverage, and its tighter tracking at large sizes reads more premium.
  hero: 'font-sans-black text-[38px] leading-[46px] tracking-tight text-txt',
  title: 'font-sans-black text-[25px] leading-[32px] tracking-tight text-txt',
  subtitle: 'font-sans-bold text-[18px] leading-[25px] text-txt',
  // Rubik — body copy and UI.
  body: 'font-sans text-[15px] leading-[23px] text-txt-secondary',
  bodyStrong: 'font-sans-semibold text-[15px] leading-[22px] text-txt',
  caption: 'font-sans text-[12.5px] leading-[17px] text-txt-tertiary',
  label: 'font-sans-semibold text-[13px] leading-[18px] tracking-wide text-txt',
};

/**
 * The ONLY text primitive in the app.
 *
 * Android clips the ascenders of large Secular One glyphs (Hebrew letters such
 * as ל and final forms are the first to go) because the platform reserves
 * font padding based on the system font's metrics. `includeFontPadding: false`
 * plus `textAlignVertical: 'center'` removes that reserved box and keeps the
 * glyphs optically centred — hence every Text in the app goes through here.
 */
export interface AppTextProps extends RNTextProps {
  variant?: TextVariant;
  className?: string;
}

const ANDROID_FONT_FIX: TextStyle = {
  includeFontPadding: false,
  textAlignVertical: 'center',
};

export const AppText = forwardRef<RNText, AppTextProps>(function AppText(
  { variant = 'body', className, style, ...rest },
  ref,
) {
  return (
    <RNText
      ref={ref}
      className={`${VARIANT_CLASS[variant]}${className ? ` ${className}` : ''}`}
      // `text-start` alone can't cover nested/absolute cases; RN mirrors
      // 'auto' correctly under I18nManager for both scripts.
      style={[ANDROID_FONT_FIX, { writingDirection: 'auto' }, style]}
      {...rest}
    />
  );
});
