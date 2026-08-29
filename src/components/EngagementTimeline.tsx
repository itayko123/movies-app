import { useState } from 'react';
import { I18nManager, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  LinearGradient as SvgGradient,
  Path,
  Stop,
} from 'react-native-svg';
import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { useT } from '@/i18n';
import type { EngagementPoint } from '@/types/media';

const GRAPH_HEIGHT = 120;
const V_PAD = 12;

interface TimelineGeometry {
  linePath: string;
  areaPath: string;
  peakX: number;
  peakY: number;
}

function buildGeometry(
  points: EngagementPoint[],
  peak: EngagementPoint,
  width: number,
): TimelineGeometry {
  const usable = GRAPH_HEIGHT - V_PAD * 2;
  const step = points.length > 1 ? width / (points.length - 1) : 0;

  const coords = points.map((point, index) => ({
    x: points.length > 1 ? index * step : width / 2,
    y: GRAPH_HEIGHT - V_PAD - point.score * usable,
    isPeak: point.id === peak.id,
  }));

  // Smooth the curve with quadratic midpoint interpolation.
  const first = coords[0];
  if (!first) return { linePath: '', areaPath: '', peakX: 0, peakY: 0 };
  let d = `M ${first.x} ${first.y}`;
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    if (!prev || !curr) continue;
    const midX = (prev.x + curr.x) / 2;
    d += ` Q ${prev.x} ${prev.y} ${midX} ${(prev.y + curr.y) / 2}`;
    d += ` T ${curr.x} ${curr.y}`;
  }

  const last = coords[coords.length - 1];
  const peakCoord = coords.find((c) => c.isPeak) ?? first;

  return {
    linePath: d,
    areaPath: `${d} L ${last ? last.x : width} ${GRAPH_HEIGHT} L ${first.x} ${GRAPH_HEIGHT} Z`,
    peakX: peakCoord.x,
    peakY: peakCoord.y,
  };
}

export interface EngagementTimelineProps {
  points: EngagementPoint[];
  peak: EngagementPoint;
  accentColor: string;
}

/**
 * "When It Gets Good" — plot-engagement curve across episodes with the spike
 * marker. The whole graph mirrors under RTL (time flows right→left in
 * Hebrew), which is why positioning uses logical start/end only.
 */
export function EngagementTimeline({ points, peak, accentColor }: EngagementTimelineProps) {
  const t = useT();
  const [width, setWidth] = useState(0);

  const geometry = width > 0 ? buildGeometry(points, peak, width) : null;

  return (
    <GlassView className="rounded-3xl p-4">
      <AppText variant="subtitle">{t('detail.whenItGetsGood')}</AppText>
      <AppText variant="caption" className="mt-1">
        {t('detail.whenItGetsGoodHint')}
      </AppText>

      <View
        className="mt-4"
        style={{ height: GRAPH_HEIGHT }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {geometry && (
          <Svg
            width={width}
            height={GRAPH_HEIGHT}
            // Mirror the time axis for RTL readers.
            style={{ transform: [{ scaleX: I18nManager.isRTL ? -1 : 1 }] }}
          >
            <Defs>
              <SvgGradient id="engagementFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={accentColor} stopOpacity={0.45} />
                <Stop offset="1" stopColor={accentColor} stopOpacity={0.02} />
              </SvgGradient>
            </Defs>
            <Path d={geometry.areaPath} fill="url(#engagementFill)" />
            <Path
              d={geometry.linePath}
              stroke={accentColor}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <Circle
              cx={geometry.peakX}
              cy={geometry.peakY}
              r={7}
              fill={accentColor}
              stroke="#000000"
              strokeWidth={2.5}
            />
          </Svg>
        )}
      </View>

      <View className="mt-3 flex-row items-center gap-2">
        <View className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: accentColor }} />
        <AppText variant="bodyStrong" className="flex-1">
          {t('detail.takesOff', {
            season: peak.season,
            episode: peak.episode,
            minute: peak.minute,
          })}
        </AppText>
      </View>
    </GlassView>
  );
}
