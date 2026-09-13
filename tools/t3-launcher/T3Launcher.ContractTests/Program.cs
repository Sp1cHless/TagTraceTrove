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
