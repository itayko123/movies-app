import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line, Polygon, Text as SvgText } from 'react-native-svg';

import { AppText } from '@/components/AppText';

export interface RadarAxis {
  label: string;
  /** Raw weight. Scaled against the largest value internally. */
  value: number;
}

interface TasteRadarProps {
  axes: RadarAxis[];
  size?: number;
  /** Already-translated caption. Kept out of the component so it stays presentational. */
  caption?: string;
}

/** Rings drawn behind the shape, as fractions of the radius. */
const RINGS = [0.25, 0.5, 0.75, 1];

/**
 * Polar/radar plot of the strongest genre weights.
 *
 * Why a radar rather than more bars: bars already exist below it and answer
 * "how strong is each genre". A radar answers a different question — what SHAPE
 * your taste has. A spiky chart means a specialist, an even polygon means a
 * generalist, and that is legible at a glance in a way a sorted bar list is not.
 *
 * Values are normalised against the largest axis, so the shape describes
 * relative balance rather than absolute magnitude (the underlying weights are
 * decayed and clamped, so their absolute size is not meaningful to a user).
 */
export function TasteRadar({ axes, size = 240, caption }: TasteRadarProps) {
  const center = size / 2;
  // Leaves room for the labels ringing the plot.
  const radius = center - 34;

  const points = useMemo(() => {
    const max = Math.max(...axes.map((a) => Math.abs(a.value)), 0.001);
    return axes.map((axis, index) => {
      // Start at 12 o'clock and go clockwise.
      const angle = (Math.PI * 2 * index) / axes.length - Math.PI / 2;
      // Floor at 12% so a near-zero axis still renders as a visible vertex
      // rather than collapsing the polygon into the centre.
      const ratio = Math.max(Math.abs(axis.value) / max, 0.12);
      return {
        axis,
        angle,
        x: center + Math.cos(angle) * radius * ratio,
        y: center + Math.sin(angle) * radius * ratio,
        edgeX: center + Math.cos(angle) * radius,
        edgeY: center + Math.sin(angle) * radius,
        labelX: center + Math.cos(angle) * (radius + 20),
        labelY: center + Math.sin(angle) * (radius + 20),
      };
    });
  }, [axes, center, radius]);

  // A polygon needs at least 3 vertices; below that the caller shows bars only.
  if (axes.length < 3) return null;

  return (
    <View className="items-center">
      <Svg width={size} height={size}>
        {RINGS.map((ring) => (
          <Circle
            key={ring}
            cx={center}
            cy={center}
            r={radius * ring}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={1}
            fill="none"
          />
        ))}

        {points.map((point) => (
          <Line
            key={`axis-${point.axis.label}`}
            x1={center}
            y1={center}
            x2={point.edgeX}
            y2={point.edgeY}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={1}
          />
        ))}

        <Polygon
          points={points.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="rgba(0,184,217,0.28)"
          stroke="#00B8D9"
          strokeWidth={2}
          strokeLinejoin="round"
        />

        {points.map((point) => (
          <Circle
            key={`vertex-${point.axis.label}`}
            cx={point.x}
            cy={point.y}
            r={3.5}
            fill="#00B8D9"
          />
        ))}

        {points.map((point) => (
          <SvgText
            key={`label-${point.axis.label}`}
            x={point.labelX}
            y={point.labelY + 4}
            fontSize={10}
            fill="#94A3B8"
            textAnchor={
              // Keep labels from overhanging the edges of the plot.
              Math.abs(point.labelX - center) < 6
                ? 'middle'
                : point.labelX > center
                  ? 'start'
                  : 'end'
            }
          >
            {point.axis.label.length > 12
              ? `${point.axis.label.slice(0, 11)}…`
              : point.axis.label}
          </SvgText>
        ))}
      </Svg>

      {caption && (
        <AppText variant="caption" className="text-center mt-1">
          {caption}
        </AppText>
      )}
    </View>
  );
}
