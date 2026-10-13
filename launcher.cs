// typescript-language-server.exe: a real Windows PE launcher.
//
// WHY THIS EXISTS
// Grok and Claude Code spawn language servers with libuv's uv_spawn and no shell. On
// Windows uv_spawn calls SearchPathW and appends only ".exe" when the command has no
// dot. npm installs Node CLIs as an extensionless sh script plus .cmd and .ps1, and
// never as a .exe, so a bare-name spawn cannot resolve. Even if it resolved the .cmd,
// Node 18 and later refuse to spawn .cmd or .bat without a shell, so that path is
// blocked too.
//
// This launcher is a genuine .exe, so the no-shell spawn resolves it. It execs
// `node <cli.mjs>` and hands the parent's stdio to node through INHERITED handles.
// That inheritance is load-bearing: a launcher that opens its own pipes and
// byte-pumps between them fails silently, because libuv will not carry LSP JSON-RPC
// over anonymous pipes. The server would start, read stdin, and never answer.
//
// It resolves cli.mjs relative to its own location, so it tracks the installed
// package version automatically and survives an npm update.
//
// BUILD (bundled .NET csc, no dependencies, about 7 KB output)
//   csc /target:exe /nologo /optimize+ /out:typescript-language-server.exe launcher.cs
//
// INSTALL
//   copy the .exe next to the npm package, that is <APPDATA>/npm/ on Windows
//
// Only needed on Windows. On Linux and macOS npm installs a real executable shim, so
// the bare name resolves and this file is not used.

using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

class LspLauncher
{
    const int STD_INPUT_HANDLE  = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE  = -12;
    const uint STARTF_USESTDHANDLES  = 0x00000100;
    const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    const uint INFINITE              = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars,
                   dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int n);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(
        IntPtr srcProc, IntPtr src, IntPtr dstProc,
        out IntPtr dst, uint access, bool inherit, uint options);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(
        string appName, string cmdLine, IntPtr procAttr, IntPtr threadAttr,
        bool inheritHandles, uint creationFlags, IntPtr env, string cwd,
        ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr h, uint ms);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr h, out uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    // Quote an argument only when it needs it, escaping per CommandLineToArgvW rules
    // so a path containing spaces or quotes survives intact.
    static string Quote(string s)
    {
        if (s.Length == 0) return "\"\"";
        if (s.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return s;

        var b = new StringBuilder();
        b.Append('"');
        int backslashes = 0;
        foreach (char c in s)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"')
            {
                b.Append('\\', backslashes * 2 + 1);
                backslashes = 0;
                b.Append('"');
            }
            else
            {
                b.Append('\\', backslashes);
                backslashes = 0;
                b.Append(c);
            }
        }
        b.Append('\\', backslashes * 2);
        b.Append('"');
        return b.ToString();
    }

    // Mark a stdio handle inheritable so the child uses the parent's stream.
    // Reports whether it created a duplicate, because only duplicates may be
    // closed: closing the original would shut the parent's own stdio.
    static IntPtr Inheritable(IntPtr h, out bool duplicated)
    {
        duplicated = false;
        if (h == IntPtr.Zero || h == new IntPtr(-1)) return h;
        IntPtr dup;
        if (DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(),
                            out dup, 0, true, DUPLICATE_SAME_ACCESS))
        {
            duplicated = true;
            return dup;
        }
        return h;
    }

    // Search PATH for an executable, returning its absolute path or null. This is
    // what lets the launcher honour the active Node from a version manager instead
    // of assuming the standard install location.
    static string FindOnPath(string name)
    {
        string pathEnv = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(pathEnv)) return null;
        foreach (string dir in pathEnv.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            string candidate;
            try { candidate = Path.Combine(dir.Trim(), name); }
            catch { continue; }
            try { if (File.Exists(candidate)) return Path.GetFullPath(candidate); }
            catch { /* unreadable entry, keep scanning */ }
        }
        return null;
    }

    static int Main(string[] args)
    {
        string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        if (string.IsNullOrEmpty(exeDir)) exeDir = Directory.GetCurrentDirectory();

        // Resolved relative to this .exe, so it follows the installed package.
        string cli = Path.Combine(
            exeDir, "node_modules", "typescript-language-server", "lib", "cli.mjs");

        // Order: a node.exe beside this launcher first, then the active Node from
        // PATH (which honours fnm, nvm and other version managers), then the standard
        // install location. There is no bare-name fallback: if none of these exists,
        // fail with a readable message rather than hoping CreateProcess guesses right.
        string nodePath = null;

        string localNode = Path.Combine(exeDir, "node.exe");
        if (File.Exists(localNode))
        {
            nodePath = localNode;
        }

        if (nodePath == null)
        {
            nodePath = FindOnPath("node.exe");
        }

        if (nodePath == null)
        {
            const string standardNode = @"C:\Program Files\nodejs\node.exe";
            if (File.Exists(standardNode)) nodePath = standardNode;
        }

        if (nodePath == null)
        {
            Console.Error.WriteLine(
                "launcher: no node.exe found beside the launcher, on PATH, or at " +
                @"C:\Program Files\nodejs\node.exe");
            return 1;
        }

        var cmd = new StringBuilder();
        cmd.Append(Quote(nodePath)).Append(' ').Append(Quote(cli));
        foreach (string a in args)
        {
            cmd.Append(' ');
            cmd.Append(Quote(a));
        }

        if (!File.Exists(cli))
        {
            Console.Error.WriteLine("launcher: cli.mjs not found at " + cli);
            return 1;
        }

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        bool dupIn, dupOut, dupErr;
        si.hStdInput  = Inheritable(GetStdHandle(STD_INPUT_HANDLE), out dupIn);
        si.hStdOutput = Inheritable(GetStdHandle(STD_OUTPUT_HANDLE), out dupOut);
        si.hStdError  = Inheritable(GetStdHandle(STD_ERROR_HANDLE), out dupErr);

        PROCESS_INFORMATION pi;
        // nodePath is always absolute here, so appName pins the exact binary and
        // there is no second round of PATH guessing inside CreateProcess.
        if (!CreateProcess(nodePath, cmd.ToString(), IntPtr.Zero, IntPtr.Zero,
                           true, 0, IntPtr.Zero, null, ref si, out pi))
        {
            Console.Error.WriteLine(
                "launcher: CreateProcess failed, err=" + Marshal.GetLastWin32Error());
            return 1;
        }

        // The child now holds its own duplicates. Close only the handles we
        // created; the originals belong to this process and must stay open.
        if (dupIn) CloseHandle(si.hStdInput);
        if (dupOut) CloseHandle(si.hStdOutput);
        if (dupErr) CloseHandle(si.hStdError);
        CloseHandle(pi.hThread);

        WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hProcess);
        return unchecked((int)code);
    }
}
