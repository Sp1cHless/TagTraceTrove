import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const main = new URL('../../../spikes/001-android-webview-shell/android/app/src/main/', import.meta.url);
const manifest = readFileSync(fileURLToPath(new URL('AndroidManifest.xml', main)), 'utf8');

describe('Android offline-library backup boundary', () => {
  it('does not let automatic OS cloud backup export WebView private library data', () => {
    expect(manifest).toMatch(/android:allowBackup="false"/u);
  });
  it('explicitly excludes app-private data from device transfer on Android 12+', () => {
    expect(manifest).toMatch(/android:dataExtractionRules="@xml\/data_extraction_rules"/u);
    const rules = readFileSync(fileURLToPath(new URL('res/xml/data_extraction_rules.xml', main)), 'utf8');
    expect(rules).toMatch(/<device-transfer>[\s\S]*?<exclude domain="root" path="\."\s*\/>[\s\S]*?<\/device-transfer>/u);
  });
});
