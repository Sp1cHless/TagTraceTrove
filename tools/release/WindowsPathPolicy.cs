using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace T3Paths
{
    // Shared by Windows PowerShell 5.1 and the launcher. Keep this source C# 5 compatible.
    public static class WindowsPathPolicy
    {
        public static bool IsCloudTag(uint tag)
        {
            // IO_REPARSE_TAG_CLOUD and CLOUD_1 ... CLOUD_F are sync placeholders,
            // not name-surrogate links. Reject every other tag unless explicitly supported.
            return (tag & 0xFFFF0FFFu) == 0x9000001Au;
        }

        public static uint GetReparseTag(string path)
        {
            string full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
            string native = full.StartsWith(@"\\?\", StringComparison.Ordinal) ? full
                : full.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + full.Substring(2)
                : @"\\?\" + full;
            FindData data;
            IntPtr handle = FindFirstFile(native, out data);
            if (handle == new IntPtr(-1))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read Windows path metadata: " + path);
            try { return (data.Attributes & FileAttributes.ReparsePoint) != 0 ? data.ReparseTag : 0; }
            finally { FindClose(handle); }
        }

        public static void AssertNoRedirect(string path)
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0) return;
            uint tag = GetReparseTag(path);
            if (!IsCloudTag(tag))
                throw new IOException("Reparse point is not allowed (tag 0x" + tag.ToString("X8") + "): " + path
                    + ". Extract the ZIP into a normal local folder, for example C:\\T3.");
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct FindData
        {
            public FileAttributes Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint ReparseTag;
            public uint Reserved;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string FileName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string AlternateFileName;
        }

        [DllImport("kernel32.dll", EntryPoint = "FindFirstFileW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr FindFirstFile(string path, out FindData data);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FindClose(IntPtr handle);
    }
}
