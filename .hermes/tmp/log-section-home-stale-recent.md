### 修：Home 的"最近浏览"在冷启动时显示几天前的那几条（2026-10-05）

用户：**「每次重新打开 T³ 网页端时，home 上显示的 recent view 一直都是前几天的几条……只有刚打开的时候
是这样，如果点击其他页面再回到 home，就正常显示 recent 了。怀疑几天前的那一次 home 状态被莫名锁定了」**

查清楚了，机制不是"状态被锁定"，而是**离线快照在冷启动时代答了一次**：

```text
  main.ts：startupReady = api.preferOfflineSnapshot!()
  offline-api.ts:1170
      const generation = await store.readMeta(ACTIVE_GENERATION_KEY);
      if (!Number.isSafeInteger(generation) || generation <= 0) return false;
      setMode('offline');          ← 冷启动**故意**先切到本地快照（免得页面空白）
  withFallback（1313）：mode === 'offline' → 直接离线作答，不再问服务端
  offline-library.queryEntryPage（329）实现了 recentOnly：
      usageOf(entry.id).lastViewedAt —— 用的是**快照自己的**使用记录，也就是上次同步时的
  连接恢复（connection-recovery）探测成功后 mode 回到 online
  ——但 Home 只在 onMounted 读一次，**没人告诉它要再读**
  → 离开再回来 = 重新挂载 = 这一次读走的是服务端 ✓ 正是用户描述的现象
```

**根因是"一次读取的界面在模式切换时没有重读"**，而不是快照坏了。壳层（GalleryApp）本来就有这个
机制 —— 一个 `offlineState.mode` 的 watcher，探测成功后会重读**可见的**表面：

```ts
watch(() => props.offlineState?.mode, ...)   // GalleryApp.vue:2379
  if (activeType.value !== null) refreshes.push(loadGalleryEntries());
  if (activeEntry.value !== null) refreshes.push(reloadActiveEntry());
  // ← Home 不在这张名单里，所以它一直显示快照那一刻的数据
```

修法（最小且沿用既有模式）：`HomePage.vue` 用 `defineExpose({ reload: load })` 暴露它那一次读取
（AuthorPage / CollectionsPage 已经这么做了），壳层的 watcher 加一行 —— ref 在 Home 不是当前页时是
null，所以别处零成本。

守卫：`gallery-app.test::re-reads Home when the app comes back online, instead of keeping the snapshot
it opened with`（offline → online 的 props 变化后断言 Home 又读了一次、并且显示的是新数据）。
去掉那一行 → `expected 1 to be greater than 1`（只读了一次）✓

门：T³ 单测 1110；集成 **610/610**；web vue-tsc 0；产物已重建。

**留给离线那一侧的观察（没有改）**：`preferOfflineSnapshot` 的语义是"先给本地副本"，但它把 mode 钉在
offline 直到探测成功；这段时间里**所有**读都走快照。这次只修了 Home 这一个表面 —— 其他页面是打开时
现读的，所以看不出来；但如果还有别的"挂载时读一次"的表面，同一个毛病会在它们身上复现。
