// Custom entry. The notification task must be defined when the bundle loads, including in the headless run that answers a
// lock-screen tap with the app killed, so it comes before the router.
import './src/reminders/task';
import 'expo-router/entry';
