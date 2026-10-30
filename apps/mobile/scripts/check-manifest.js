// Checks the Android manifest that `expo prebuild` generates. Run in CI: `node scripts/check-manifest.js`.
// D-073: SCHEDULE_EXACT_ALARM only; USE_EXACT_ALARM must never be declared (Play restricts it to alarm and calendar apps).
// D-074: no direct battery-exemption request. Also no microphone: nothing in this app records audio.
//
// This looks at the manifest prebuild generates, where a blocked permission appears as tools:node="remove". The final merged
// manifest (with every library's own) is only produced by Gradle; check it on the first real build.
const { existsSync, readFileSync } = require('node:fs');

function declared(xml) {
  const found = new Map();
  for (const m of xml.matchAll(/<uses-permission\b([^>]*)\/?>/g)) {
    const name = /android:name="([^"]+)"/.exec(m[1])?.[1];
    if (name) found.set(name, /tools:node="remove"/.test(m[1]) ? 'removed' : 'declared');
  }
  return found;
}

function checkManifest(xml) {
  const perms = declared(xml);
  const problems = [];
  const p = (n) => perms.get(`android.permission.${n}`);
  if (p('SCHEDULE_EXACT_ALARM') !== 'declared') problems.push('SCHEDULE_EXACT_ALARM must be declared (D-073)');
  for (const forbidden of ['USE_EXACT_ALARM', 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', 'RECORD_AUDIO', 'SYSTEM_ALERT_WINDOW']) {
    if (p(forbidden) === 'declared') problems.push(`${forbidden} must not be declared`);
  }
  return problems;
}

module.exports = { checkManifest };

if (require.main === module) {
  const file = process.argv[2] ?? 'android/app/src/main/AndroidManifest.xml';
  if (!existsSync(file)) {
    console.error(`No manifest at ${file}. Run: npx expo prebuild --platform android --no-install`);
    process.exit(2);
  }
  const problems = checkManifest(readFileSync(file, 'utf8'));
  if (problems.length) {
    console.error(problems.map((x) => `- ${x}`).join('\n'));
    process.exit(1);
  }
  console.log('Android manifest permissions OK');
}
