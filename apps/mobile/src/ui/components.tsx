import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, size, space } from './theme';

// Presentational pieces only. They hold no wording: every string arrives as a prop, already translated.

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const body = <View style={styles.content}>{children}</View>;
  return <SafeAreaView style={styles.screen}>{scroll ? <ScrollView keyboardShouldPersistTaps="handled">{body}</ScrollView> : body}</SafeAreaView>;
}

export const Title = ({ children }: { children: ReactNode }) => (
  <Text accessibilityRole="header" style={styles.title}>
    {children}
  </Text>
);
export const Heading = ({ children }: { children: ReactNode }) => (
  <Text accessibilityRole="header" style={styles.heading}>
    {children}
  </Text>
);
export const Body = ({ children, muted }: { children: ReactNode; muted?: boolean }) => <Text style={[styles.body, muted && { color: color.muted }]}>{children}</Text>;

export function Button({ label, onPress, variant = 'primary', disabled, busy, testID }: { label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean; testID?: string }) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.button, styles[variant], off && styles.disabled, pressed && { opacity: 0.85 }]}
    >
      {busy ? <ActivityIndicator color={variant === 'secondary' ? color.primary : color.onPrimary} /> : <Text style={[styles.buttonText, variant === 'secondary' && { color: color.primary }]}>{label}</Text>}
    </Pressable>
  );
}

export function Field({ label, error, ...input }: { label: string; error?: string | null } & TextInputProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={color.muted} style={[styles.input, !!error && { borderColor: color.danger }]} {...input} />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function Banner({ text, tone = 'warn' }: { text: string; tone?: 'warn' | 'danger' | 'ok' }) {
  return (
    <View accessibilityRole="alert" style={[styles.banner, { borderColor: color[tone] }]}>
      <Text style={[styles.body, { color: color[tone] }]}>{text}</Text>
    </View>
  );
}

export function Check({ label, value, onChange, error }: { label: string; value: boolean; onChange: (v: boolean) => void; error?: string | null }) {
  return (
    <View style={styles.field}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: value }} accessibilityLabel={label} onPress={() => onChange(!value)} style={styles.checkRow}>
        <Switch value={value} onValueChange={onChange} accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden />
        <Text style={[styles.body, { flex: 1 }]}>{label}</Text>
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

// A card can be one tappable control: the whole thing is the button, so it is read out once.
export function Card({ children, onPress, label, testID }: { children: ReactNode; onPress?: () => void; label?: string; testID?: string }) {
  if (!onPress) return <View style={styles.card}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} testID={testID} style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}>
      {children}
    </Pressable>
  );
}
export const Spacer = ({ h = space.m }: { h?: number }) => <View style={{ height: h }} />;
export const Loading = ({ label }: { label: string }) => (
  <View accessibilityLabel={label} style={styles.center}>
    <ActivityIndicator size="large" color={color.primary} />
  </View>
);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.l, gap: space.m },
  title: { fontSize: size.title, fontWeight: '700', color: color.text },
  heading: { fontSize: size.heading, fontWeight: '600', color: color.text },
  body: { fontSize: size.body, color: color.text, lineHeight: size.body * 1.4 },
  button: { minHeight: size.touch, borderRadius: 12, paddingHorizontal: space.l, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: color.primary },
  secondary: { backgroundColor: color.bg, borderWidth: 2, borderColor: color.primary },
  danger: { backgroundColor: color.danger },
  disabled: { opacity: 0.5 },
  buttonText: { fontSize: size.button, fontWeight: '600', color: color.onPrimary },
  field: { gap: space.xs },
  label: { fontSize: size.small, fontWeight: '600', color: color.muted },
  input: { minHeight: size.touch, borderWidth: 2, borderColor: color.border, borderRadius: 12, paddingHorizontal: space.m, fontSize: size.body, color: color.text },
  error: { fontSize: size.small, color: color.danger },
  banner: { borderWidth: 2, borderRadius: 12, padding: space.m, backgroundColor: color.surface },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: size.touch },
  card: { backgroundColor: color.surface, borderRadius: 16, padding: space.m, gap: space.s },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
});
