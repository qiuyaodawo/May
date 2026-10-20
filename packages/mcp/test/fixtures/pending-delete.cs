using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class PendingDelete
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint attributes, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref uint flags, uint size);

    public static void Hold(string path)
    {
        using (var file = CreateFileW(path, 0x10180, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero))
        {
            if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            // 使用 Windows POSIX 删除标记，保持删除句柄打开。
            uint flags = 0x13;
            if (!SetFileInformationByHandle(file, 21, ref flags, 4)) throw new Win32Exception(Marshal.GetLastWin32Error());
            Console.WriteLine("delete-pending");
            Console.Out.Flush();
            Console.ReadLine();
        }
    }
}
