using T3Paths;

internal static class CloudPathCheck
{
    public static void Run(string junction, string ordinaryFile)
    {
        for (uint subtype = 0; subtype <= 15; subtype++)
            if (!WindowsPathPolicy.IsCloudTag(0x9000001Au + subtype * 0x1000))
                throw new InvalidOperationException("Cloud subtype rejected: " + subtype);
        foreach (uint tag in new uint[] { 0, 0xA0000003, 0xA000000C, 0x9001001A, 0x9000001C, 0x80000015 })
            if (WindowsPathPolicy.IsCloudTag(tag)) throw new InvalidOperationException("Non-cloud tag accepted: " + tag.ToString("X8"));
        WindowsPathPolicy.AssertNoRedirect(ordinaryFile);
        WindowsPathPolicy.AssertNoRedirect(Path.GetDirectoryName(ordinaryFile)!);
        if (WindowsPathPolicy.GetReparseTag(ordinaryFile) != 0) throw new InvalidOperationException("Ordinary file tag changed.");
        if (WindowsPathPolicy.GetReparseTag(junction) != 0xA0000003) throw new InvalidOperationException("Junction native tag mismatch.");
        bool rejected = false;
        try { WindowsPathPolicy.AssertNoRedirect(junction); }
        catch (IOException error) { rejected = error.Message.Contains("A0000003") && error.Message.Contains(junction); }
        if (!rejected) throw new InvalidOperationException("Launcher did not reject the real junction with diagnostic tag/path.");
        Console.WriteLine("PASS: launcher shares cloud tag policy, native metadata reads and junction rejection. No launcher/service started.");
    }
}
