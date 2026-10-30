// A stand-in for expo-router in screen tests: navigation is recorded, redirects render as text.
import { useEffect, type ReactNode } from 'react';
import { Text } from 'react-native';

export const router = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };
export const params: { id?: string } = {};

export const useRouter = () => router;
export const useLocalSearchParams = () => params;
export const useFocusEffect = (cb: () => void | (() => void)) => useEffect(cb, [cb]);
export const Redirect = ({ href }: { href: string }) => <Text testID="redirect">{href}</Text>;
export const Link = ({ children }: { children: ReactNode }) => <>{children}</>;
export const Stack = () => null;
