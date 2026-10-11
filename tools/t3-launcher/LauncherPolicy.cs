using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace T3Launcher;

public readonly record struct LauncherOptions(bool LanEnabled, bool NoBrowser);

public static class LauncherPolicy
{
    public static IReadOnlyList<string> NodeCandidates(
        string repoRoot,
        string localAppData,
        string? pathValue)
    {
        var candidates = new List<string>
        {
            Path.Combine(repoRoot, "tools", "node", "node.exe"),
            Path.Combine(localAppData, "hermes", "node", "node.exe"),
        };
        if (!string.IsNullOrWhiteSpace(pathValue))
        {
            candidates.AddRange(pathValue
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(directory => Path.Combine(directory.Trim('"'), "node.exe")));
        }
        return candidates.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    public static string? FindCompatibleNode(string repoRoot, string serverDir)
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string? pathValue = Environment.GetEnvironmentVariable("PATH");
        return NodeCandidates(repoRoot, localAppData, pathValue)
            .FirstOrDefault(candidate => File.Exists(candidate) && CanOpenBetterSqlite(candidate, serverDir));
    }

    public static void PrependExecutableDirectory(ProcessStartInfo start, string executablePath)
    {
        string directory = Path.GetDirectoryName(executablePath)
            ?? throw new ArgumentException("Executable path has no directory", nameof(executablePath));
        string currentPath = start.Environment["PATH"] ?? string.Empty;
        start.Environment["PATH"] = string.IsNullOrEmpty(currentPath)
            ? directory
            : directory + Path.PathSeparator + currentPath;
    }

    private static bool CanOpenBetterSqlite(string nodeExecutable, string serverDir)
    {
        try
        {
            var start = new ProcessStartInfo
            {
                FileName = nodeExecutable,
                WorkingDirectory = serverDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.ArgumentList.Add("-e");
            start.ArgumentList.Add("const Database=require('better-sqlite3');new Database(':memory:').close()");
            using var process = Process.Start(start);
            if (process == null) { return false; }
            if (!process.WaitForExit(5000))
            {
                StopProcessTree(process);
                return false;
            }
            return process.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    public static LauncherOptions ParseOptions(IEnumerable<string> args)
    {
        var values = args.ToHashSet(StringComparer.OrdinalIgnoreCase);
        return new LauncherOptions(
            LanEnabled: values.Contains("--lan"),
            NoBrowser: values.Contains("--no-browser"));
    }

    public static void ApplyServerEnvironment(
        ProcessStartInfo start,
        bool lanEnabled,
        bool autoAllowMobileConnection = true)
    {
        start.Environment["T3_OPEN_BROWSER"] = "0";
        start.Environment["T3_ENABLE_LAN"] = lanEnabled ? "true" : "false";
        start.Environment["T3_HOST"] = lanEnabled ? "0.0.0.0" : "127.0.0.1";
        // Phone access is a setting now, and it defaults on: a plain launch advertises this
        // desktop's private address so a phone can pair without any flag.
        if (autoAllowMobileConnection)
        {
            ApplyPairingHost(start);
        }
    }

    /// <summary>
    /// Where the server keeps its own settings, which the System page writes and the launcher
    /// reads before the server exists. Mirrors the server's own resolution: a relative
    /// T3_DATA_DIR belongs to the server directory, and the default is its `.data`.
    /// </summary>
    public static string SystemSettingsPath(string serverDir, string? dataDir)
    {
        string root = string.IsNullOrWhiteSpace(dataDir)
            ? Path.Combine(serverDir, ".data")
            : (Path.IsPathRooted(dataDir) ? dataDir : Path.Combine(serverDir, dataDir));
        return Path.Combine(root, "t3-settings.json");
    }

    /// <summary>
    /// Whether this desktop should advertise itself for phone pairing. A missing, unreadable or
    /// partial file means the default, which is on — an installation that never opened the
    /// System page behaves exactly as it did before the setting existed.
    /// </summary>
    public static bool AutoAllowMobileConnection(string settingsPath)
    {
        try
        {
            if (!File.Exists(settingsPath))
            {
                return true;
            }
            using System.Text.Json.JsonDocument document =
                System.Text.Json.JsonDocument.Parse(File.ReadAllText(settingsPath));
            if (document.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object
                && document.RootElement.TryGetProperty("autoAllowMobileConnection", out System.Text.Json.JsonElement value)
                && value.ValueKind == System.Text.Json.JsonValueKind.False)
            {
                return false;
            }
            return true;
        }
        catch
        {
            return true;
        }
    }

    /// <summary>
    /// The encrypted pairing listener only exists when the server is told which
    /// private address the phone will dial. Leaving that to an operator's
    /// environment variable meant a plain launch came up without it and
    /// Settings - Connect to APP answered "Encrypted pairing is not enabled
    /// here" — even in a packaged release. A value already present wins, so a
    /// machine with several interfaces can still pin the address.
    /// </summary>
    public static void ApplyPairingHost(ProcessStartInfo start)
    {
        // The indexer throws for a missing key, so the check has to be a lookup.
        if (start.Environment.TryGetValue("T3_PAIRED_HOST", out string? existing)
            && !string.IsNullOrWhiteSpace(existing))
        {
            return;
        }

        string? pairedHost = FindPrivateIpv4Addresses().FirstOrDefault()?.ToString();
        if (pairedHost is not null)
        {
            start.Environment["T3_PAIRED_HOST"] = pairedHost;
        }
    }

    public static IReadOnlyList<IPAddress> FindPrivateIpv4Addresses()
    {
        try
        {
            return NetworkInterface.GetAllNetworkInterfaces()
                .Where(adapter => adapter.OperationalStatus == OperationalStatus.Up)
                .Where(adapter => adapter.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                .SelectMany(adapter => adapter.GetIPProperties().UnicastAddresses)
                .Select(address => address.Address)
                .Where(IsPrivateIpv4)
                .Distinct()
                .OrderBy(address => address.ToString(), StringComparer.Ordinal)
                .ToArray();
        }
        catch
        {
            return Array.Empty<IPAddress>();
        }
    }

    public static IReadOnlyList<string> MobileUrls(IEnumerable<IPAddress> addresses, int port)
    {
        return addresses
            .Where(IsPrivateIpv4)
            .Select(address => $"http://{address}:{port}")
            .Distinct(StringComparer.Ordinal)
            .OrderBy(url => url, StringComparer.Ordinal)
            .ToArray();
    }

    public static bool IsPrivateIpv4(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork)
        {
            return false;
        }

        byte[] bytes = address.GetAddressBytes();
        return bytes[0] == 10
            || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31)
            || (bytes[0] == 192 && bytes[1] == 168);
    }

    public static void StopProcessTree(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5000);
            }
        }
        catch
        {
            // The process tree may already be gone.
        }
    }
}
