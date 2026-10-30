import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';

// English only at launch (D-003). Every string a person reads lives in en.json; screens never hold literals.
// Keys are flat ("auth.signIn.title"), so the nesting separator is switched off.
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  keySeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false,
});

export type MessageKey = keyof typeof en;
export const t = (key: MessageKey, params?: Record<string, string | number>): string => i18n.t(key, params);
export default i18n;
