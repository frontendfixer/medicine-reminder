// Phase 0 reminder spike. Throwaway app: see ../README.md.
import { existsSync } from 'node:fs';
import type { ExpoConfig } from 'expo/config';

// FCM credentials for Android push (D-075 data-push test). Not committed.
const googleServicesFile = existsSync('./google-services.json') ? './google-services.json' : undefined;

const config: ExpoConfig = {
  name: 'Reminder Spike',
  slug: 'med-reminder-spike',
  version: '0.0.1',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  ios: {
    bundleIdentifier: process.env.SPIKE_IOS_BUNDLE_ID ?? 'com.medreminder.spike',
    supportsTablet: false,
    entitlements: {
      // Time Sensitive Notifications capability (D-027). Key not yet confirmed against
      // Apple's reference page; verify in the first build's provisioning profile.
      'com.apple.developer.usernotifications.time-sensitive': true,
    },
  },
  android: {
    package: process.env.SPIKE_ANDROID_PACKAGE ?? 'com.medreminder.spike',
    googleServicesFile,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    // D-073: SCHEDULE_EXACT_ALARM only. D-074: no direct battery-exemption request.
    permissions: ['android.permission.SCHEDULE_EXACT_ALARM'],
    blockedPermissions: [
      'android.permission.USE_EXACT_ALARM',
      'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    ],
  },
  plugins: [
    'expo-dev-client',
    'expo-sqlite',
    'expo-asset',
    'expo-background-task',
    [
      'expo-notifications',
      {
        sounds: ['./assets/sounds/dose_alarm.wav'],
        enableBackgroundRemoteNotifications: true,
      },
    ],
  ],
  extra: {
    eas: { projectId: process.env.EAS_PROJECT_ID },
    stubUrl: process.env.SPIKE_STUB_URL ?? '',
  },
};

export default config;
