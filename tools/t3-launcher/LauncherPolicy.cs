using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace T3Launcher;

public readonly record struct LauncherOptions(bool LanEnabled, bool NoBrowser);

public static class LauncherPolicy
{
    public static LauncherOptions ParseOptions(IEnumerable<string> args)
    {
        var values = args.ToHashSet(StringComparer.OrdinalIgnoreCase);
        return new LauncherOptions(
            LanEnabled: values.Contains("--lan"),
            NoBrowser: values.Contains("--no-browser"));
    }

    public static void ApplyServerEnvironment(ProcessStartInfo start, bool lanEnabled)
    {
        start.Environment["T3_OPEN_BROWSER"] = "0";
        start.Environment["T3_ENABLE_LAN"] = lanEnabled ? "true" : "false";
        start.Environment["T3_HOST"] = lanEnabled ? "0.0.0.0" : "127.0.0.1";
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
