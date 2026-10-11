using System.Diagnostics;
using System.Net;
using T3Launcher;

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

var defaults = LauncherPolicy.ParseOptions(Array.Empty<string>());
Assert(!defaults.LanEnabled && !defaults.NoBrowser, "default launch must remain localhost with browser enabled");

var lan = LauncherPolicy.ParseOptions(["--lan", "--no-browser"]);
Assert(lan.LanEnabled && lan.NoBrowser, "explicit launcher flags were not parsed");

var localStart = new ProcessStartInfo();
LauncherPolicy.ApplyServerEnvironment(localStart, lanEnabled: false);
Assert(localStart.Environment["T3_HOST"] == "127.0.0.1", "local mode must bind loopback");
Assert(localStart.Environment["T3_ENABLE_LAN"] == "false", "local mode must explicitly disable LAN permission");

var lanStart = new ProcessStartInfo();
LauncherPolicy.ApplyServerEnvironment(lanStart, lanEnabled: true);
Assert(lanStart.Environment["T3_HOST"] == "0.0.0.0", "LAN mode must bind all interfaces");
Assert(lanStart.Environment["T3_ENABLE_LAN"] == "true", "LAN mode must explicitly grant LAN permission");
Assert(lanStart.Environment["T3_OPEN_BROWSER"] == "0", "server must not open a second browser");

var pairedLocal = new ProcessStartInfo();
LauncherPolicy.ApplyServerEnvironment(pairedLocal, lanEnabled: false);
var privateAddresses = LauncherPolicy.FindPrivateIpv4Addresses();
if (privateAddresses.Count > 0)
{
    Assert(
        pairedLocal.Environment["T3_PAIRED_HOST"] == privateAddresses[0].ToString(),
        "a plain launch must advertise a private address so encrypted pairing starts");
}
else
{
    Assert(
        string.IsNullOrWhiteSpace(pairedLocal.Environment["T3_PAIRED_HOST"]),
        "without a private address the launcher must not invent a pairing host");
}

var pinned = new ProcessStartInfo();
pinned.Environment["T3_PAIRED_HOST"] = "10.9.9.9";
LauncherPolicy.ApplyServerEnvironment(pinned, lanEnabled: true);
Assert(
    pinned.Environment["T3_PAIRED_HOST"] == "10.9.9.9",
    "an explicitly configured pairing host must win over the detected address");

// Phone access is a setting, and it defaults on: with the file absent the plain launch above
// already proved the advertisement, and a stored "off" must stop it.
string settingsDir = Path.Combine(Path.GetTempPath(), "t3-launcher-contracts-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(settingsDir);
string settingsPath = LauncherPolicy.SystemSettingsPath(settingsDir, dataDir: null);
Assert(Path.GetFileName(settingsPath) == "t3-settings.json", "settings file name changed");
Assert(Path.GetFileName(Path.GetDirectoryName(settingsPath)!) == ".data", "settings must live in the server's data directory");
Directory.CreateDirectory(Path.GetDirectoryName(settingsPath)!);
Assert(LauncherPolicy.AutoAllowMobileConnection(settingsPath), "a missing settings file must default to phone access on");

File.WriteAllText(settingsPath, "{\"autoAllowMobileConnection\":false}");
Assert(!LauncherPolicy.AutoAllowMobileConnection(settingsPath), "a stored off must disable phone access");
var disabled = new ProcessStartInfo();
LauncherPolicy.ApplyServerEnvironment(disabled, lanEnabled: false, autoAllowMobileConnection: false);
// A missing key throws on the indexer, so the check has to be a lookup.
Assert(
    !disabled.Environment.TryGetValue("T3_PAIRED_HOST", out string? advertised) || string.IsNullOrWhiteSpace(advertised),
    "phone access off must not advertise a pairing host");
Assert(disabled.Environment["T3_HOST"] == "127.0.0.1", "phone access off must keep the desktop on loopback");

File.WriteAllText(settingsPath, "{\"autoAllowMobileConnection\":true}");
Assert(LauncherPolicy.AutoAllowMobileConnection(settingsPath), "a stored on must enable phone access");
File.WriteAllText(settingsPath, "{ not json");
Assert(LauncherPolicy.AutoAllowMobileConnection(settingsPath), "an unreadable settings file must fall back to phone access on");
Directory.Delete(settingsDir, recursive: true);

string fakeRoot = Path.Combine("C:\\", "repo");
string fakeLocalAppData = Path.Combine("C:\\", "Users", "test", "AppData", "Local");
var nodeCandidates = LauncherPolicy.NodeCandidates(
    fakeRoot,
    fakeLocalAppData,
    string.Join(Path.PathSeparator, Path.Combine("C:\\", "Program Files", "nodejs")));
Assert(
    nodeCandidates.Take(3).SequenceEqual([
        Path.Combine(fakeRoot, "tools", "node", "node.exe"),
        Path.Combine(fakeLocalAppData, "hermes", "node", "node.exe"),
        Path.Combine("C:\\", "Program Files", "nodejs", "node.exe"),
    ]),
    "launcher must prefer project/Hermes Node before the system PATH runtime");

var nodeStart = new ProcessStartInfo();
nodeStart.Environment["PATH"] = Path.Combine("C:\\", "Program Files", "nodejs");
LauncherPolicy.PrependExecutableDirectory(
    nodeStart,
    Path.Combine(fakeLocalAppData, "hermes", "node", "node.exe"));
Assert(
    nodeStart.Environment["PATH"]!.StartsWith(
        Path.Combine(fakeLocalAppData, "hermes", "node") + Path.PathSeparator,
        StringComparison.OrdinalIgnoreCase),
    "selected compatible Node must take precedence for tsx.cmd and npm.cmd");

var addresses = LauncherPolicy.MobileUrls(
    [IPAddress.Parse("192.168.1.20"), IPAddress.Parse("8.8.8.8"), IPAddress.Parse("10.0.0.4"), IPAddress.Parse("192.168.1.20")],
    8765);
Assert(addresses.SequenceEqual(["http://10.0.0.4:8765", "http://192.168.1.20:8765"]), "mobile URLs must contain distinct private IPv4 addresses only");

using var child = Process.Start(new ProcessStartInfo
{
    FileName = "cmd.exe",
    Arguments = "/c ping -t 127.0.0.1 >nul",
    UseShellExecute = false,
    CreateNoWindow = true,
}) ?? throw new InvalidOperationException("failed to start lifecycle fixture");
Thread.Sleep(150);
LauncherPolicy.StopProcessTree(child);
Assert(child.HasExited, "launcher Exit must terminate the owned server process tree");

Console.WriteLine("T3 launcher LAN contracts passed");
