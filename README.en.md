<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/readme/banner-light.svg">
    <img alt="T³ — TagTraceTrove · Tag · Trace · Trove" src="assets/readme/banner-light.svg" width="1000">
  </picture>
</p>

<p align="center">
  <a href="README.md">简体中文</a> &nbsp;|&nbsp; <strong>English</strong>
</p>

> Have you ever lost your entire collection when a website shut down, without even remembering what you lost?
>
> Do you find a website's built-in bookmarks too basic to organize different works in detail?
>
> Have you struggled to add precise tags and reviews to works you've seen, even resorting to a separate text file to record your thoughts?
>
> Have you tried building your own library in a personal database tool like Notion, only to give up because organizing and importing everything felt too cumbersome?

I've faced these exact same problems. That's how **T³ (TagTraceTrove)** came to be.

**T³ is a local-first personal collection index for recording, organizing, and finding works and creators you care about.**

You can collect comics, videos, illustrations, and other works in your own library, saving covers, preview images, authors, tags, ratings, notes, and source links for each one.
Filter by tags and ratings when you want a particular kind of work, or open an author's page to browse their works.

- **Organize collections your way.** T³ gives you flexible tags, collections, ratings, and filters. Anything you've already bookmarked on a website is worth bringing into T³ for more detailed organization.
- **Import directly from links.** A built-in generic adapter can learn the information layout of most websites and import the content you want.
- **Use it on your computer and phone.** T³ has an Android app connected to the desktop library—of course it does; if I can't browse in bed, what's the point? The app supports offline editing and automatically uploads your changes when it reconnects to the desktop.

At this point, T³ does almost everything I wanted it to. I hope it can do what you want, too.

---

## ✨ Features

### 🏷️ Define your own tags and combine filters to find works

Different types of work can have different tag categories: organize comics by series, characters, and themes, or videos by type and language. Add categories for anything else you care about, such as art style or atmosphere.
Group related categories into sections and arrange the tag layout on work pages yourself.

Combine tags, authors, and rating conditions to narrow down your collection. For example, find a particular author's series, then show only works with a "Story" rating above 3 stars.
To find something by name, use global search for works, authors, or tags.

### ⭐ Rate several aspects and record what you liked

Name your own rating categories, each supporting 0.5–5 stars in half-star steps. Rate "Art," "Story," and "Personal enjoyment" separately, then use notes to record your thoughts in more detail.
Each type of work has its own rating categories, so you can compare and filter using your own criteria.

You can also rate authors themselves and their body of work overall. When individual works haven't been rated yet, sorting can use the author's overall work rating to bring more promising items to the front.

### 📁 Organize works into multiple collections

Create collections such as "Worth revisiting," a particular theme, or "Recommendations for friends." The same work can belong to several collections.
Work collections support one level of subfolders. Authors can go into dedicated author collections, making it easy to keep track of creators you follow.

You can also add a tag to all works in a collection at once, which is useful for organizing a batch of imported bookmarks.

### 🌐 Import works from links and bring in existing bookmarks in batches

The built-in **SiteProbe** can extract titles, covers, previews, authors, tags, and source links from supported pages.
Use existing site rules directly, or create an adapter for a new site by following the rule builder's browser-based steps to identify work information. The resulting adapter can be reused for future imports.
Author pages, bookmarks, and work lists supported by a listing adapter can also be read in batches.

Before importing, preview the works, adjust tag categories, confirm authors, and optionally rate each author's works overall. Repeat imports recognize works already in your library. If a batch is too large to review in one sitting, save it as a temporary collection and review it later.

### 👤 Keep author information and works together

An author's page brings together their linked works, along with the author's own tags, ratings, and notes. Organize their works into folders by series, and link collaborative works to multiple authors.
If the same author uses different names on different websites, set up an alias group to bring those names and works together under one author profile.

### 🖼️ Browse covers and previews, and find what you wanted to see

Each type of work has its own gallery. Cover cards make collections easy to browse, and opening a card shows saved preview images and details. Source links take you back to the original page.
"View later" saves works and authors for another time, while "Recently viewed" helps you find works whose source links you've recently opened. Sort by views or likes, or shuffle your collection to rediscover something.

### 📱 Organize from bed, with offline editing that syncs automatically

The Android app connects to the same library as your computer. Once you've saved an offline copy and cached the images you need, you can browse, search, filter, and view cached images even when the computer is off or your phone is away from your home network.

While offline, you can edit work information, add tags, rate works, organize collections, and create new works with images.
When the app reconnects to the desktop, it automatically uploads your offline edits and refreshes the copy on your phone.

### 🔒 Keep work information locally and back up the whole library

Work information, authors, tags, reviews, and saved covers and preview images live on your computer. Even if the original website closes, your saved information remains available, so you can remember exactly what you collected.
A work can have multiple source links, and you can add more when you find another source.

The app lets you back up and restore the library together with its images. Release updates also back up your personal data before upgrading.

### 🌗 Adjust the interface to your preferences

Choose between light and dark themes, six color palettes, and Simplified Chinese / English interfaces. The SFW / NSFW toggle controls whether sensitive content is shown, and galleries and collections can have their own sensitive-content settings.

## 🚀 Getting started

### Download a release

Choose a release from the [Releases page](https://github.com/Sp1cHless/TagTraceTrove/releases):

| File | Purpose |
| --- | --- |
| `T3-version-windows-x64.zip` | Desktop app for Windows 10/11 x64, with runtimes included |
| `T3-version.apk` | Android app for Android 7.0 and later |
| `SHA256SUMS.txt` | SHA256 checksums for verifying downloaded files |

On phones running other operating systems, access T³ through a web browser.

The desktop interface runs in a modern browser such as Chrome, Edge, or Firefox. To connect your phone for the first time, both the phone and the computer running T³ need to be on the same local network.

### Windows: installation and everyday use

1. Download the Windows ZIP and extract it to a location where you plan to keep your library, such as `D:\Apps\`. The folder inside the archive is named **TagTraceTrove**. Move it out of any enclosing folder whose name includes the version number.
2. Open `TagTraceTrove` and double-click **T3.exe** or **Install.cmd**. The installer installs the app in that directory, creates a desktop shortcut, and opens the app.
3. For everyday use, double-click the **T3** shortcut.

The release package includes the runtimes needed to install and run the app. T³ stays in the system tray after starting; the main library's default address is `http://127.0.0.1:8765`.
Closing the browser leaves T³ running. To stop it, right-click its tray icon and exit.

Starting with 1.0.5, the installation lives in the `TagTraceTrove` directory you choose. Keep the whole directory; program files and personal data are stored separately inside it:

```text
TagTraceTrove/
  Start.cmd                 Everyday startup entry
  Uninstall.cmd             Uninstall entry
  installation.json         Current version and installation information
  versions/                 Program files and runtimes for each version
  data/                     Library, images, templates, settings, pairing, site rules, etc.
  backups/pre-update-*/     Full personal-data backups made before updates
```

### Android: installation, pairing, and offline use

1. Download the release **T3-version.apk**, open it on your phone, and follow Android's prompts to allow installation.
2. Start T³ on your computer and connect both devices to the same trusted local network.
3. On the computer, open **Settings → Connect to APP** and create a pairing QR code. Scan it in the phone app, or use the copy-and-paste pairing option provided by the panel.
4. Once paired, you can use your library on the phone. Open **Advanced functions → Offline library**, download your first offline copy, and choose the images you want to cache.

After the offline copy has finished downloading, you can browse and edit while your computer is off or temporarily unreachable.
When you reconnect to the running desktop app, offline edits upload automatically and the saved copy is refreshed.
If the pairing panel says phone connections are disabled, enable them in the desktop's System settings first. Pairing instructions are also available in the in-app manual.

## 🔄 Updating a release

### Windows

1. Connect your phone to the old desktop version and wait until there is no pending work to sync.
2. Exit the T³ instance you want to update through its system tray menu.
3. Download the new Windows ZIP and extract it into the parent of your existing installation directory, merging the archive's **TagTraceTrove** folder with the existing one. Choose to replace program files when prompted about matching filenames. Keep the existing folder in place; do not delete it first.
4. Run **Install.cmd** in the existing `TagTraceTrove` directory. The installer verifies the new files, backs up the entire `data` directory, installs the program into `versions/new-version`, switches the startup entry, and opens the app.

The release archive contains neither your `data` directory nor your `installation.json`, so merging the extracted files preserves them. The update also preserves your instance name, ports, pairing information, and desktop shortcut. Backups are saved under `backups/pre-update-*`.

If you prefer to extract the new package separately, open a terminal in **the new package's TagTraceTrove directory** and run the following command, replacing the path with your existing installation location:

```powershell
.\Install.cmd -InstallRoot "D:\Apps\TagTraceTrove"
```

This updates the existing installation at the specified path. Running the installer directly in a different new directory creates a separate installation there.

### Android

Connect to the desktop and wait until there is no pending work to sync, then download the new release APK, open it, and choose to update the existing app.
A normal update preserves pairing, the offline copy, and personal data. Automatic syncing continues when you reconnect to the desktop.

If you use an early test APK, its signing key may differ from the release key. Follow the test-build migration steps in the [release installation guide](docs/release-installation.md#普通用户android) first.
For everyday release updates, install over the existing app to retain the data on your phone.

## 💾 Backups and uninstalling

Manual backup and restore controls are under **Advanced functions → System**. You can also exit T³ from the tray and copy the entire installation directory to a backup location, retaining the library, site rules, pairing information, and update backups.
The installation may contain website login sessions, so store it somewhere you trust. Browser display preferences are stored locally in the browser.

On Windows, exit T³ and run **Uninstall.cmd** in that installation directory. By default, it removes installed program versions and the desktop shortcut while retaining personal data and update backups. Reinstalling lets you continue using the retained data.
For complete data removal, restoring the state before an update, or using a separate demo library, see [release, installation, update, and uninstall instructions](docs/release-installation.md).

On Android, uninstall through the phone's system settings. Uninstalling or clearing app data deletes the phone's offline copy and unsynced edits, so finish syncing first. The desktop library is retained.

## 📚 Documentation

The app includes Chinese and English manuals, available through its manual entry. The main library's default [English manual](http://127.0.0.1:8765/manual/en.html) is available while the desktop app is running.

- [Release, installation, update, and uninstall instructions](docs/release-installation.md): complete instructions for release packages (in Chinese).
- [Current features and acceptance records](docs/status.md): implemented and verified state.
- [Roadmap](docs/roadmap.md): planned features.
- [Architecture](docs/architecture.md): detailed design of works, authors, tags, ratings, and collections.

## 📄 License

Personal project. See the repository for details.
