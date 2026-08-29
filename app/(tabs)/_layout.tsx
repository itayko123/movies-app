import { Platform, StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import { BlurView } from 'expo-blur';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useT } from '@/i18n';
import { hapticSelection } from '@/lib/haptics';
import { BLUR, C } from '@/theme/tokens';

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * Reference tab treatment: icon only, active icon in lime with a small
 * lime dot beneath it. No labels — the dot carries the "you are here".
 */
function TabIcon({
  name,
  color,
  focused,
}: {
  name: IconName;
  color: string;
  focused: boolean;
}) {
  return (
    <View className="items-center justify-center" style={{ gap: 5, paddingTop: 6 }}>
      <Ionicons name={name} size={24} color={color} />
      <View
        style={{
          width: 4,
          height: 4,
          borderRadius: 2,
          backgroundColor: focused ? C.accent : 'transparent',
        }}
      />
    </View>
  );
}

export default function TabsLayout() {
  const t = useT();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarActiveTintColor: C.accent,
        tabBarInactiveTintColor: C.textSecondary,
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: 'transparent',
          elevation: 0,
          height: Platform.OS === 'ios' ? 80 : 64,
          paddingTop: 4,
        },
        // Frosted glass, not a painted bar: heavy blur samples the deck
        // artwork moving underneath, and the translucent navy on top tints it
        // without hiding it. Android caps the blur (expensive + degrades
        // badly there) so its fill carries more of the effect.
        tabBarBackground: () => (
          <View style={StyleSheet.absoluteFill}>
            <BlurView
              intensity={Platform.OS === 'android' ? 32 : BLUR.heavy}
              tint="dark"
              style={StyleSheet.absoluteFill}
            />
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  backgroundColor:
                    Platform.OS === 'ios' ? C.surfaceGlass : C.surfaceGlassStrong,
                },
              ]}
            />
          </View>
        ),
      }}
      screenListeners={{ tabPress: () => hapticSelection() }}
    >
      {/*
        Phase 2 rename. "Discover" moved to the shelf screen, which is what the
        reference calls Discover and what the word actually describes — browsing
        a curated surface. The card stack is an ACTION, so it is now "Swipe".
        The routes are unchanged; only the labels moved.
      */}
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.swipe'),
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name={focused ? 'flame' : 'flame-outline'} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="foryou"
        options={{
          title: t('tabs.discover'),
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? 'compass' : 'compass-outline'}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="mood"
        options={{
          title: t('tabs.mood'),
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? 'sparkles' : 'sparkles-outline'}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="duo"
        options={{
          title: t('tabs.duo'),
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name={focused ? 'people' : 'people-outline'} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="watchlist"
        options={{
          title: t('tabs.watchlist'),
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              name={focused ? 'bookmark' : 'bookmark-outline'}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t('tabs.profile'),
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name={focused ? 'person' : 'person-outline'} color={color} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
