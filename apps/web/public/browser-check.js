/* This recovery screen must parse even when the app bundle cannot. Keep ES5. */
(function () {
  var version = /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent);
  var old = version && Number(version[1]) < 90;
  var storageMissing = typeof indexedDB === 'undefined';
  if (!old && !storageMissing) return;
  document.documentElement.setAttribute('data-t3-unsupported-browser', '1');
  var chinese = /^zh/i.test(navigator.language || '');
  var reason = chinese
    ? '请更新 Android System WebView 或系统浏览器，并允许本地存储，然后重新打开 T3。'
    : 'Update Android System WebView or your system browser and allow local storage, then reopen T3.';
  var screen = document.createElement('section');
  screen.id = 't3-browser-recovery';
  screen.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:10000;overflow:auto;background:#fff;color:#172033;padding:24px;font:16px/1.6 sans-serif';
  var title = document.createElement('h1');
  title.textContent = chinese ? '浏览器内核需要更新' : 'Browser update required';
  var message = document.createElement('p');
  message.textContent = reason;
  var report = document.createElement('textarea');
  report.readOnly = true;
  report.setAttribute('aria-label', chinese ? '本机诊断' : 'Device diagnostics');
  report.style.cssText = 'box-sizing:border-box;width:100%;height:200px;font:13px/1.5 monospace';
  report.value = 'T3 browser recovery\n' + new Date().toISOString()
    + '\n' + navigator.userAgent + '\nviewport: ' + innerWidth + 'x' + innerHeight
    + '\nrequired engine: Chromium/WebView 90+\nIndexedDB: ' + !storageMissing;
  var copy = document.createElement('button');
  copy.textContent = chinese ? '复制本机诊断' : 'Copy device diagnostics';
  copy.style.cssText = 'margin-top:16px;padding:12px 16px;font:inherit';
  copy.onclick = function () {
    function select() { report.focus(); report.select(); document.execCommand('copy'); }
    var bridge = window.Capacitor;
    if (bridge && bridge.nativePromise) {
      bridge.nativePromise('T3PairedTransport', 'copyText', { text: report.value }).then(function () {}, select);
    } else select();
  };
  screen.appendChild(title);
  screen.appendChild(message);
  screen.appendChild(report);
  screen.appendChild(copy);
  document.body.appendChild(screen);
  var boot = document.getElementById('t3-boot');
  if (boot) boot.style.display = 'none';
}());
