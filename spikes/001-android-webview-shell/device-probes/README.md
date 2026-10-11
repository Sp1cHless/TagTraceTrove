# 真机探针（adb + WebView DevTools Protocol）

安装/重启 App 后**必须重新转发**：套接字名带 pid（`listener.lock` 那套无关，这里指 WebView 的调试口）。

```bash
ADB=<android-sdk>/platform-tools/adb.exe
PID=$("$ADB" shell pidof com.speechless666.t3.spike | tr -d '\r')
"$ADB" forward --remove-all
"$ADB" forward tcp:9222 localabstract:webview_devtools_remote_$PID
```

* `cdp.mjs pages | eval '<表达式>'` —— 通用通道：列页面、在页面里求值（`awaitPromise`）。
* `entry-open.mjs` —— 量一次「点进 entry → 出详情 → 返回」的耗时，按 `data-testid`（`entry-detail` / `entry-information-board` / `entry-ratings` / `active-gallery-title`）报告每段毫秒数。
* `rate.mjs [轮数]` —— 每 30 秒采样一次离线媒体缓存条目数，打印「张/分钟」。

App 切到后台（或通知栏拉下）时调试口会停止应答、`evaluate` 永久挂起 —— 先 `adb shell am start -n com.speechless666.t3.spike/.MainActivity` 再重试，不要据此判断「App 卡死」。
