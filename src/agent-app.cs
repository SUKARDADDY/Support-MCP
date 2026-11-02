// .NET Framework 4 client for Windows 7 and PowerShell 2.0. No installation,
// elevation request, autostart, WebSocket, or third-party runtime. Build with csc v4.
// Screen control (capture, input, UI Automation) runs in the user's own process.
// The customer window is WPF (part of .NET Framework 4); WinForms is used only
// for MessageBox and the DialogResult type of SupportAccess.Confirm.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using Microsoft.Win32.SafeHandles;
using Gdi = System.Drawing;
using Img = System.Drawing.Imaging;
using WF = System.Windows.Forms;
using Shapes = System.Windows.Shapes;

namespace SupportMcp {
    public static class SupportAccess {
        public static bool IsAdministrator() {
            using (var identity = WindowsIdentity.GetCurrent())
                return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        public static string ConsentMessage(bool administrator) {
            string rights = administrator
                ? "This client is running as Administrator. Allow remote support to run commands and read or change files with administrator rights?\n\nSupport can change system settings and files for all users."
                : "Allow remote support to run commands and read or change files as your signed-in user?";
            return rights + "\n\nA small window stays in the corner of your screen while support is connected. Access ends when you close it, click End session, or after 24 hours. Nothing reconnects after reboot unless separately prepared.";
        }
        public static bool Confirm(bool administrator, bool resume, Func<string, WF.DialogResult> prompt) {
            // A prepared reconnect never grants administrator access silently.
            return (resume && !administrator) || prompt(ConsentMessage(administrator)) == WF.DialogResult.Yes;
        }
    }

    public static class Wire {
        public const string Footer = "SUPPORTMCPCFG1";
        public static Dictionary<string, object> Map(params object[] pairs) {
            var d = new Dictionary<string, object>();
            for (int i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1];
            return d;
        }
        public static string Text(Dictionary<string, object> d, string key) {
            object v; return d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : "";
        }
        public static long Number(Dictionary<string, object> d, string key) {
            object v; return d.TryGetValue(key, out v) && v != null ? Convert.ToInt64(v) : 0;
        }
        public static bool Flag(Dictionary<string, object> d, string key) {
            object v; return d.TryGetValue(key, out v) && v is bool && (bool)v;
        }
        public static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = 800000 }; }
        public static Dictionary<string, object> ReadConfig(string file) {
            using (var s = File.OpenRead(file)) {
                byte[] footer = Encoding.ASCII.GetBytes(Footer), tail = new byte[footer.Length + 4];
                if (s.Length < tail.Length) throw new InvalidDataException("Missing session configuration.");
                s.Position = s.Length - tail.Length; s.Read(tail, 0, tail.Length);
                for (int i = 0; i < footer.Length; i++) if (tail[i + 4] != footer[i]) throw new InvalidDataException("Invalid session configuration.");
                int n = BitConverter.ToInt32(tail, 0);
                if (n < 1 || n > 4096 || n > s.Length - tail.Length) throw new InvalidDataException("Invalid session configuration size.");
                byte[] data = new byte[n]; s.Position -= n + tail.Length; s.Read(data, 0, n);
                var cfg = Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(data));
                if (!System.Text.RegularExpressions.Regex.IsMatch(Text(cfg, "sid"), "^[0-9a-f]{64}$") ||
                    !System.Text.RegularExpressions.Regex.IsMatch(Text(cfg, "key"), "^[0-9a-f]{64}$")) throw new InvalidDataException("Invalid session credentials.");
                Uri origin = new Uri(Text(cfg, "origin"));
                if ((origin.Scheme != "https" && !(origin.Scheme == "http" && origin.IsLoopback)) ||
                    origin.AbsolutePath != "/" || origin.UserInfo != "" || origin.Query != "" || origin.Fragment != "")
                    throw new InvalidDataException("Invalid support server.");
                return cfg;
            }
        }
    }

    // The child starts suspended. Assign it to a kill-on-close Job before any
    // customer command can run. Refuse execution if Windows cannot contain it.
    public sealed class CommandJob : IDisposable {
        IntPtr job, process;
        readonly MemoryStream stdout = new MemoryStream(), stderr = new MemoryStream();
        Thread outReader, errReader;
        public bool OutClipped, ErrClipped;
        [StructLayout(LayoutKind.Sequential)] struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
            public int Size; public string Reserved, Desktop, Title;
            public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public int Id, ThreadId; }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
            public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking;
            public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
            public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref ExtendedLimits limits, int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr p, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr t);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr p, uint timeout);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security s, int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref Security s, uint create, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string exe, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
        static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        static void Close(ref IntPtr h) { if (h != IntPtr.Zero && h != new IntPtr(-1)) CloseHandle(h); h = IntPtr.Zero; }
        Thread Drain(IntPtr h, MemoryStream target, bool isOut) {
            var t = new Thread(delegate() {
                try {
                    using (var stream = new FileStream(new SafeFileHandle(h, true), FileAccess.Read)) {
                        byte[] buf = new byte[4096]; int n;
                        while ((n = stream.Read(buf, 0, buf.Length)) != 0) {
                            int take = Math.Min(n, 65536 - (int)target.Length);
                            if (take > 0) target.Write(buf, 0, take);
                            if (take < n) { if (isOut) OutClipped = true; else ErrClipped = true; }
                        }
                    }
                } catch (IOException) { }
            }); t.IsBackground = true; t.Start(); return t;
        }
        public Dictionary<string, object> Run(string scriptPath, string cwd, int timeoutSeconds, WaitHandle stop) {
            IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero, input = IntPtr.Zero;
            ProcessInfo pi = new ProcessInfo();
            try {
                job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
                var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway
                Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)));
                var security = new Security { Size = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
                Check(CreatePipe(out outRead, out outWrite, ref security, 0));
                Check(CreatePipe(out errRead, out errWrite, ref security, 0));
                Check(SetHandleInformation(outRead, 1, 0)); Check(SetHandleInformation(errRead, 1, 0));
                input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero); Check(input != new IntPtr(-1));
                var si = new Startup { Size = Marshal.SizeOf(typeof(Startup)), Flags = 0x101, Input = input, Output = outWrite, Error = errWrite };
                string exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
                string args = "\"" + exe + "\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -File \"" + scriptPath + "\"";
                Check(CreateProcess(exe, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref si, out pi));
                process = pi.Process;
                Check(AssignProcessToJobObject(job, process));
                if (stop.WaitOne(0)) throw new OperationCanceledException();
                outReader = Drain(outRead, stdout, true); outRead = IntPtr.Zero;
                errReader = Drain(errRead, stderr, false); errRead = IntPtr.Zero;
                Close(ref outWrite); Close(ref errWrite); Close(ref input);
                Check(ResumeThread(pi.Thread) != uint.MaxValue);
                var clock = Stopwatch.StartNew(); bool timedOut = false;
                while (WaitForSingleObject(process, 100) != 0) {
                    if (stop.WaitOne(0)) throw new OperationCanceledException();
                    if (clock.ElapsedMilliseconds >= timeoutSeconds * 1000L) { timedOut = true; break; }
                }
                uint exit; Check(GetExitCodeProcess(process, out exit));
                Close(ref job); // also stop descendants after their parent exits
                WaitForSingleObject(process, 5000);
                outReader.Join(5000); errReader.Join(5000);
                return Wire.Map("ok", true, "exit_code", timedOut ? null : (object)unchecked((int)exit), "timed_out", timedOut,
                    "stdout_b64", Convert.ToBase64String(stdout.ToArray()), "stderr_b64", Convert.ToBase64String(stderr.ToArray()),
                    "stdout_truncated", OutClipped, "stderr_truncated", ErrClipped);
            } finally {
                // Assignment can fail on Windows 7 inside an existing Job. The
                // unassigned suspended process must be terminated explicitly.
                if (pi.Process != IntPtr.Zero) TerminateProcess(pi.Process, 1);
                Close(ref job); Close(ref process); Close(ref pi.Thread);
                Close(ref outRead); Close(ref outWrite); Close(ref errRead); Close(ref errWrite); Close(ref input);
                if (outReader != null) outReader.Join(5000); if (errReader != null) errReader.Join(5000);
            }
        }
        public void Dispose() { Close(ref job); Close(ref process); }
    }

    // Pure helpers. Screenshots fit 1280x800 and are never scaled up. Clients send
    // coordinates in screenshot pixels; these map them to physical pixels and back.
    public static class ScreenMath {
        public const int MaxW = 1280, MaxH = 800;
        public static void Fit(int w, int h, out int tw, out int th) {
            double s = Math.Min(1.0, Math.Min((double)MaxW / w, (double)MaxH / h));
            tw = Math.Max(1, (int)Math.Round(w * s)); th = Math.Max(1, (int)Math.Round(h * s));
        }
        // A screenshot pixel to the physical pixel at its center, and a region edge to the nearest physical edge.
        public static int ToPhysical(int v, int imageLen, int physLen) { return Math.Max(0, Math.Min(physLen - 1, (int)((v + 0.5) * physLen / imageLen))); }
        public static int EdgeToPhysical(int v, int imageLen, int physLen) { return Math.Max(0, Math.Min(physLen, (int)Math.Round((double)v * physLen / imageLen))); }
        public static int ToImage(int phys, int imageLen, int physLen) { return Math.Max(0, Math.Min(imageLen - 1, (int)((phys + 0.5) * imageLen / physLen))); }
    }

    // Customer input wins: agent input is refused for 3 s after the last physical event.
    public sealed class PauseClock {
        public const long WindowMs = 3000;
        long last = long.MinValue / 2;
        public static long Now() { return Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency; }
        public void Touch(long now) { Interlocked.Exchange(ref last, now); }
        public bool Paused(long now) { return RemainingMs(now) > 0; }
        public long RemainingMs(long now) { return Math.Max(0, WindowMs - (now - Interlocked.Read(ref last))); }
    }

    // xdotool-style key names (ctrl+s, alt+tab, Return, F5, "ctrl+a Delete") to virtual-key codes.
    public static class KeySpec {
        static readonly Dictionary<string, int> Names = Build();
        static Dictionary<string, int> Build() {
            var d = new Dictionary<string, int>();
            foreach (string pair in ("ctrl=11 control=11 alt=12 shift=10 super=5B win=5B meta=5B cmd=5B return=0D enter=0D tab=09 escape=1B esc=1B space=20 backspace=08 delete=2E del=2E insert=2D home=24 end=23 " +
                "page_up=21 prior=21 pageup=21 page_down=22 next=22 pagedown=22 up=26 down=28 left=25 right=27 minus=BD equal=BB comma=BC period=BE slash=BF backslash=DC semicolon=BA apostrophe=DE grave=C0 bracketleft=DB bracketright=DD capslock=14").Split(' '))
                d[pair.Split('=')[0]] = Convert.ToInt32(pair.Split('=')[1], 16);
            return d;
        }
        public static bool IsModifier(int vk) { return vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B; }
        public static bool IsExtended(int vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B; }
        public static List<int[]> Parse(string keys) {
            var combos = new List<int[]>();
            foreach (string combo in keys.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
                var mods = new List<int>(); var rest = new List<int>();
                foreach (string raw in combo.Split('+')) {
                    string t = raw.ToLowerInvariant(); int vk;
                    if (!Names.TryGetValue(t, out vk)) {
                        var m = System.Text.RegularExpressions.Regex.Match(t, "^f([1-9]|1[0-9]|2[0-4])$");
                        if (m.Success) vk = 0x6F + int.Parse(m.Groups[1].Value);
                        else if (t.Length == 1 && ((t[0] >= 'a' && t[0] <= 'z') || (t[0] >= '0' && t[0] <= '9'))) vk = char.ToUpperInvariant(t[0]);
                        else throw new ArgumentException("Unknown key \"" + raw + "\".");
                    }
                    (IsModifier(vk) ? mods : rest).Add(vk);
                }
                mods.AddRange(rest);
                if (mods.Contains(0x11) && mods.Contains(0x12) && mods.Contains(0x2E)) throw new ArgumentException("Ctrl+Alt+Del cannot be sent as a key; use send_sas.");
                combos.Add(mods.ToArray());
            }
            if (combos.Count == 0) throw new ArgumentException("No keys given.");
            return combos;
        }
    }

    public static class UiLines {
        // [12] Button "OK" (640,412): the ref, the control type, the name and the center in screenshot pixels.
        public static string Line(int n, string type, string name, int x, int y) {
            if (type.StartsWith("ControlType.")) type = type.Substring(12);
            var clean = new StringBuilder();
            foreach (char c in name) clean.Append(char.IsControl(c) ? ' ' : c == '"' ? '\'' : c);
            string text = clean.ToString().Trim(); if (text.Length > 80) text = text.Substring(0, 77) + "...";
            return "[" + n + "] " + type + (text.Length > 0 ? " \"" + text + "\"" : "") + " (" + x + "," + y + ")";
        }
    }

    public static class JpegFit {
        // Steps the quality down until the base64 text is under maxChars.
        public static byte[] Encode(Gdi.Image image, int maxChars, out int quality) {
            Img.ImageCodecInfo codec = null;
            foreach (var c in Img.ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
            for (int q = 80; q >= 10; q -= 10) { // a loop, not an array initializer: the compiler would name a helper class with a random GUID and break the reproducible build
                using (var ms = new MemoryStream()) using (var parameters = new Img.EncoderParameters(1)) {
                    parameters.Param[0] = new Img.EncoderParameter(Img.Encoder.Quality, (long)q);
                    image.Save(ms, codec, parameters);
                    if ((ms.Length + 2) / 3 * 4 < maxChars) { quality = q; return ms.ToArray(); }
                }
            }
            throw new ScreenError("the screenshot is too large to send");
        }
    }

    sealed class ScreenError : Exception { public ScreenError(string message) : base(message) { } }

    static class Win {
        [StructLayout(LayoutKind.Sequential)] public struct Rc { public int L, T, R, B; }
        [StructLayout(LayoutKind.Sequential)] public struct Msg { public IntPtr Window; public uint Message; public IntPtr W, L; public uint Time; public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rc Monitor, Work; public uint Flags; }
        [StructLayout(LayoutKind.Sequential)] public struct MouseIn { public int Dx, Dy; public uint Data, Flags, Time; public IntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] public struct KeyIn { public ushort Vk, Scan; public uint Flags, Time; public IntPtr Extra; }
        // The INPUT union starts at offset 4 on x86, the only platform this app builds for (28 bytes in all).
        [StructLayout(LayoutKind.Explicit)] public struct In { [FieldOffset(0)] public uint Type; [FieldOffset(4)] public MouseIn Mouse; [FieldOffset(4)] public KeyIn Key; }
        public delegate bool MonitorProc(IntPtr monitor, IntPtr dc, ref Rc rect, IntPtr data);
        public delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc proc, IntPtr data);
        [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, In[] inputs, int size);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out Gdi.Point p);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Gdi.Point p);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern int GetMessage(out Msg m, IntPtr window, uint min, uint max);
        [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint thread, uint message, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder name, int length, out int needed);
        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dest, int x, int y, int w, int h, IntPtr source, int sx, int sy, uint op);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] public static extern uint GetCurrentProcessId();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll")] public static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int length, out int returned);
    }

    // Physical input detection: low-level hooks on their own message-loop thread. The
    // injected flag is set on everything SendInput sends, so only the customer's input counts.
    public sealed class InputWatch : IDisposable {
        public readonly PauseClock Clock = new PauseClock();
        public volatile bool Ok;
        readonly Win.HookProc mouse, keys; // fields, so the delegates are not collected
        readonly ManualResetEvent ready = new ManualResetEvent(false);
        Thread thread; uint threadId;
        public InputWatch() {
            mouse = delegate(int code, IntPtr w, IntPtr l) { if (code >= 0 && (Marshal.ReadInt32(l, 12) & 3) == 0) Clock.Touch(PauseClock.Now()); return Win.CallNextHookEx(IntPtr.Zero, code, w, l); };
            keys = delegate(int code, IntPtr w, IntPtr l) { if (code >= 0 && (Marshal.ReadInt32(l, 8) & 0x12) == 0) Clock.Touch(PauseClock.Now()); return Win.CallNextHookEx(IntPtr.Zero, code, w, l); };
        }
        public void Start() {
            thread = new Thread(Loop); thread.IsBackground = true; thread.Start(); ready.WaitOne(5000);
        }
        void Loop() {
            threadId = Win.GetCurrentThreadId();
            IntPtr module = Win.GetModuleHandle(null), m = Win.SetWindowsHookEx(14, mouse, module, 0), k = Win.SetWindowsHookEx(13, keys, module, 0);
            Ok = m != IntPtr.Zero && k != IntPtr.Zero; ready.Set();
            Win.Msg msg; while (Ok && Win.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
            if (m != IntPtr.Zero) Win.UnhookWindowsHookEx(m);
            if (k != IntPtr.Zero) Win.UnhookWindowsHookEx(k);
        }
        public void Dispose() {
            Ok = false; if (thread == null) return;
            Win.PostThreadMessage(threadId, 0x12, IntPtr.Zero, IntPtr.Zero); thread.Join(3000);
        }
    }

    // Capture, input and UI Automation for one screen operation at a time, all in the user's own process.
    public sealed class Screen : IDisposable {
        public const string PauseText = "customer is using the PC; try again in a few seconds";
        public const string NoFull = "full control is not available in this build";
        internal readonly InputWatch Watch = new InputWatch();
        volatile List<AutomationElement> refs = new List<AutomationElement>();
        public void Start() { Watch.Start(); }
        public void Dispose() { Watch.Dispose(); }
        public bool Paused { get { return Watch.Clock.Paused(PauseClock.Now()); } }
        public long PausedForMs { get { return Watch.Clock.RemainingMs(PauseClock.Now()); } }

        // Physical pixels on every display: per-monitor aware for this thread on Windows 10 1607+,
        // system aware for the process before that. The manifest stays as it is, so the WPF
        // corner window keeps its look.
        internal static void Dpi() {
            try { if (Win.SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) Win.SetThreadDpiAwarenessContext(new IntPtr(-3)); }
            catch (EntryPointNotFoundException) { Win.SetProcessDPIAware(); }
        }
        internal static List<Gdi.Rectangle> Monitors() {
            var others = new List<Gdi.Rectangle>(); Gdi.Rectangle? primary = null;
            Win.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, ref Win.Rc rect, IntPtr data) {
                var info = new Win.MonitorInfo { Size = Marshal.SizeOf(typeof(Win.MonitorInfo)) };
                if (!Win.GetMonitorInfo(monitor, ref info)) return true;
                var r = Gdi.Rectangle.FromLTRB(info.Monitor.L, info.Monitor.T, info.Monitor.R, info.Monitor.B);
                if ((info.Flags & 1) != 0) primary = r; else others.Add(r);
                return true;
            }, IntPtr.Zero);
            others.Sort(delegate(Gdi.Rectangle a, Gdi.Rectangle b) { return a.X != b.X ? a.X.CompareTo(b.X) : a.Y.CompareTo(b.Y); });
            if (primary.HasValue) others.Insert(0, primary.Value);
            return others;
        }
        // "default" when the input desktop is reachable; the secure desktop (UAC, lock, sign-in) is not.
        internal static string Desktop() {
            IntPtr d = Win.OpenInputDesktop(0, false, 1);
            if (d == IntPtr.Zero) return "unknown";
            try {
                var name = new StringBuilder(64); int needed;
                return Win.GetUserObjectInformation(d, 2, name, 128, out needed) && name.ToString() == "Default" ? "default" : "unknown";
            } finally { Win.CloseDesktop(d); }
        }
        internal static bool Capturable() {
            try { Dpi(); using (var b = Grab(new Gdi.Rectangle(0, 0, 1, 1))) return Desktop() == "default"; } catch (Exception) { return false; }
        }

        sealed class View {
            public Gdi.Rectangle Phys; public int Index, Count, W, H;
            public int PhysX(int x) { return Phys.X + ScreenMath.ToPhysical(x, W, Phys.Width); }
            public int PhysY(int y) { return Phys.Y + ScreenMath.ToPhysical(y, H, Phys.Height); }
            public void Check(int x, int y) { if (x < 0 || y < 0 || x >= W || y >= H) throw new ScreenError("coordinate " + x + "," + y + " is outside the " + W + "x" + H + " screenshot"); }
        }
        static View GetView(Dictionary<string, object> a) {
            var list = Monitors(); int i = (int)Wire.Number(a, "display");
            if (i < 0 || i >= list.Count) throw new ScreenError("no display " + i + "; this PC has " + list.Count);
            var v = new View { Phys = list[i], Index = i, Count = list.Count }; ScreenMath.Fit(v.Phys.Width, v.Phys.Height, out v.W, out v.H); return v;
        }
        static Gdi.Bitmap Grab(Gdi.Rectangle r) {
            var bmp = new Gdi.Bitmap(r.Width, r.Height, Img.PixelFormat.Format24bppRgb);
            // BitBlt with CAPTUREBLT, because CopyFromScreen cannot ask for layered windows (menus, tooltips).
            IntPtr screen = Win.GetDC(IntPtr.Zero); bool ok = false;
            try {
                using (var g = Gdi.Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); try { ok = Win.BitBlt(dc, 0, 0, r.Width, r.Height, screen, r.X, r.Y, 0x40CC0020); } finally { g.ReleaseHdc(dc); } }
            } finally { Win.ReleaseDC(IntPtr.Zero, screen); }
            if (!ok) { bmp.Dispose(); throw new ScreenError("cannot capture the screen; Windows may be locked"); }
            return bmp;
        }
        // A region in physical pixels, scaled down to fit 1280x800 and encoded under 700,000 base64 characters.
        static Dictionary<string, object> Shot(Gdi.Rectangle region) {
            int w, h, quality; ScreenMath.Fit(region.Width, region.Height, out w, out h);
            using (var full = Grab(region)) {
                var shown = full;
                if (w != region.Width || h != region.Height) {
                    shown = new Gdi.Bitmap(w, h, Img.PixelFormat.Format24bppRgb);
                    using (var g = Gdi.Graphics.FromImage(shown)) {
                        g.InterpolationMode = Gdi.Drawing2D.InterpolationMode.HighQualityBicubic; g.PixelOffsetMode = Gdi.Drawing2D.PixelOffsetMode.HighQuality;
                        g.DrawImage(full, new Gdi.Rectangle(0, 0, w, h), 0, 0, region.Width, region.Height, Gdi.GraphicsUnit.Pixel);
                    }
                }
                try { return Wire.Map("image_b64", Convert.ToBase64String(JpegFit.Encode(shown, 700000, out quality)), "mime", "image/jpeg", "width", w, "height", h); }
                finally { if (shown != full) shown.Dispose(); }
            }
        }

        static bool Owns(IntPtr window) { uint pid; Win.GetWindowThreadProcessId(window, out pid); return pid == Win.GetCurrentProcessId(); }
        // Normal mode cannot drive a window that runs elevated: Windows silently drops the input.
        static void NotElevated(IntPtr window) {
            if (window == IntPtr.Zero || SupportAccess.IsAdministrator()) return;
            uint pid; Win.GetWindowThreadProcessId(window, out pid);
            IntPtr process = Win.OpenProcess(0x1000, false, pid), token = IntPtr.Zero;
            if (process == IntPtr.Zero) return;
            try {
                int elevated = 0, size;
                bool opened = Win.OpenProcessToken(process, 8, out token); int error = Marshal.GetLastWin32Error();
                if ((opened && Win.GetTokenInformation(token, 20, out elevated, 4, out size) && elevated != 0) || (!opened && error == 5))
                    throw new ScreenError("that window runs as administrator; this app cannot control it");
            } finally { if (token != IntPtr.Zero) Win.CloseHandle(token); Win.CloseHandle(process); }
        }
        void Free() {
            if (!Watch.Ok) throw new ScreenError("cannot watch for customer input");
            if (Paused) throw new ScreenError(PauseText);
        }
        static void Send(params Win.In[] inputs) {
            if (Win.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Win.In))) != inputs.Length) throw new ScreenError("Windows refused the input");
        }
        static Win.In MouseEvent(int dx, int dy, int data, uint flags) {
            var i = new Win.In { Type = 0 }; i.Mouse = new Win.MouseIn { Dx = dx, Dy = dy, Data = unchecked((uint)data), Flags = flags }; return i;
        }
        static Win.In KeyEvent(int vk, ushort scan, uint flags) {
            var i = new Win.In { Type = 1 }; i.Key = new Win.KeyIn { Vk = (ushort)vk, Scan = scan, Flags = flags }; return i;
        }
        // Absolute move over the whole virtual desktop, rounded up so Windows lands on this exact pixel.
        static void MoveTo(int px, int py) {
            int vx = Win.GetSystemMetrics(76), vy = Win.GetSystemMetrics(77), vw = Math.Max(1, Win.GetSystemMetrics(78)), vh = Math.Max(1, Win.GetSystemMetrics(79));
            Send(MouseEvent((int)(((long)(px - vx) * 65536 + vw - 1) / vw), (int)(((long)(py - vy) * 65536 + vh - 1) / vh), 0, 0xC001));
        }
        static void Press(int[] combo) {
            var down = new List<Win.In>(); var up = new List<Win.In>();
            foreach (int vk in combo) {
                ushort scan = (ushort)Win.MapVirtualKey((uint)vk, 0); uint ext = KeySpec.IsExtended(vk) ? 1u : 0u;
                down.Add(KeyEvent(vk, scan, ext)); up.Insert(0, KeyEvent(vk, scan, ext | 2u));
            }
            Send(down.ToArray()); Thread.Sleep(30); Send(up.ToArray());
        }
        // Unicode events type any character the target accepts, whatever the keyboard layout.
        void TypeText(string text) {
            int n = 0;
            foreach (char c in text) {
                if (++n % 16 == 0) { if (Paused) throw new ScreenError(PauseText + " (typed " + (n - 1) + " of " + text.Length + " characters)"); }
                if (c == '\r') continue;
                if (c == '\n' || c == '\t') Press(new int[] { c == '\n' ? 0x0D : 0x09 });
                else Send(KeyEvent(0, c, 4), KeyEvent(0, c, 6));
                Thread.Sleep(2);
            }
        }
        // Refuse a target in this process's own windows (the corner window, dialogs) or in an elevated window.
        static void Target(int px, int py) {
            IntPtr hit = Win.WindowFromPoint(new Gdi.Point(px, py)), root = hit == IntPtr.Zero ? IntPtr.Zero : Win.GetAncestor(hit, 2);
            if (root != IntPtr.Zero && Owns(root)) throw new ScreenError("that spot is the support window; use another spot");
            NotElevated(root);
        }
        void Click(View v, int x, int y, string button, int count) {
            v.Check(x, y); int px = v.PhysX(x), py = v.PhysY(y);
            Target(px, py); MoveTo(px, py);
            uint down = button == "right" ? 8u : button == "middle" ? 0x20u : 2u;
            for (int i = 0; i < count; i++) { Send(MouseEvent(0, 0, 0, down), MouseEvent(0, 0, 0, down * 2)); Thread.Sleep(40); }
        }
        void Drag(View v, int x1, int y1, int x2, int y2) {
            v.Check(x1, y1); v.Check(x2, y2); int ax = v.PhysX(x1), ay = v.PhysY(y1), bx = v.PhysX(x2), by = v.PhysY(y2);
            Target(ax, ay); Target(bx, by);
            MoveTo(ax, ay); Thread.Sleep(50); Send(MouseEvent(0, 0, 0, 2));
            for (int i = 1; i <= 10; i++) { Thread.Sleep(20); MoveTo(ax + (bx - ax) * i / 10, ay + (by - ay) * i / 10); }
            Thread.Sleep(50); Send(MouseEvent(0, 0, 0, 4));
        }

        // Input actions: refuse during a customer pause, in the support window and in elevated windows.
        void Input(string name, Dictionary<string, object> a, View v) {
            Free();
            if (name == "type" || name == "key") {
                IntPtr fg = Win.GetForegroundWindow();
                if (fg != IntPtr.Zero && Owns(fg)) throw new ScreenError("the support window has the keyboard focus; click another window first");
                NotElevated(fg);
            }
            switch (name) {
                case "move": v.Check((int)Wire.Number(a, "x"), (int)Wire.Number(a, "y")); MoveTo(v.PhysX((int)Wire.Number(a, "x")), v.PhysY((int)Wire.Number(a, "y"))); break;
                case "click": {
                    string button = Wire.Text(a, "button") == "" ? "left" : Wire.Text(a, "button");
                    if (button != "left" && button != "right" && button != "middle") throw new ScreenError("button must be left, right or middle");
                    Click(v, (int)Wire.Number(a, "x"), (int)Wire.Number(a, "y"), button, (int)Math.Max(1, Math.Min(3, a.ContainsKey("count") ? Wire.Number(a, "count") : 1))); break;
                }
                case "drag": Drag(v, (int)Wire.Number(a, "x1"), (int)Wire.Number(a, "y1"), (int)Wire.Number(a, "x2"), (int)Wire.Number(a, "y2")); break;
                case "scroll": {
                    string dir = Wire.Text(a, "direction") == "" ? "down" : Wire.Text(a, "direction");
                    int amount = (int)Math.Max(1, Math.Min(50, a.ContainsKey("amount") ? Wire.Number(a, "amount") : 3));
                    if (dir != "up" && dir != "down" && dir != "left" && dir != "right") throw new ScreenError("direction must be up, down, left or right");
                    if (a.ContainsKey("x")) Click(v, (int)Wire.Number(a, "x"), (int)Wire.Number(a, "y"), "none", 0);
                    Send(MouseEvent(0, 0, 120 * amount * (dir == "up" || dir == "right" ? 1 : -1), dir == "up" || dir == "down" ? 0x800u : 0x1000u)); break;
                }
                case "type": {
                    string text = Wire.Text(a, "text");
                    if (text.Length > 5000) throw new ScreenError("text is longer than 5000 characters");
                    TypeText(text); break;
                }
                default: foreach (int[] combo in KeySpec.Parse(Wire.Text(a, "keys"))) { Free(); Press(combo); Thread.Sleep(20); } break;
            }
        }

        // UI Automation of the foreground window. Refs are numbers in the lines and live until the next ui_tree.
        string Tree(View v, int max) {
            IntPtr fg = Win.GetForegroundWindow();
            if (fg == IntPtr.Zero) throw new ScreenError("no window is in the foreground");
            if (Owns(fg)) throw new ScreenError("the foreground window is the support window");
            var cache = new CacheRequest { TreeScope = TreeScope.Element };
            foreach (var p in new AutomationProperty[] { AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.BoundingRectangleProperty, AutomationElement.IsOffscreenProperty, AutomationElement.IsKeyboardFocusableProperty }) cache.Add(p);
            var list = new List<AutomationElement>(); var lines = new List<string>(); var clock = Stopwatch.StartNew(); int visited = 0; bool more = false;
            using (cache.Activate()) {
                var walker = TreeWalker.ControlViewWalker; Action<AutomationElement, int> walk = null;
                walk = delegate(AutomationElement e, int depth) {
                    if (lines.Count >= max || ++visited > 4000 || clock.ElapsedMilliseconds > 8000) { more = true; return; }
                    try {
                        var c = e.Cached; if (c.IsOffscreen) return;
                        var r = c.BoundingRectangle;
                        if (!r.IsEmpty && (c.Name.Length > 0 || c.IsKeyboardFocusable)) {
                            int cx = (int)(r.X + r.Width / 2) - v.Phys.X, cy = (int)(r.Y + r.Height / 2) - v.Phys.Y;
                            if (cx >= 0 && cy >= 0 && cx < v.Phys.Width && cy < v.Phys.Height) {
                                list.Add(e); lines.Add(UiLines.Line(list.Count, c.ControlType.ProgrammaticName, c.Name, ScreenMath.ToImage(cx, v.W, v.Phys.Width), ScreenMath.ToImage(cy, v.H, v.Phys.Height)));
                            }
                        }
                        if (depth < 40) for (var child = walker.GetFirstChild(e, cache); child != null; child = walker.GetNextSibling(child, cache)) walk(child, depth + 1);
                    } catch (ElementNotAvailableException) { }
                };
                walk(AutomationElement.FromHandle(fg), 0);
            }
            refs = list; if (more) lines.Add("[more elements not shown; raise max_lines]");
            return String.Join("\n", lines.ToArray());
        }
        static bool Limited(Action action, int ms) {
            Exception error = null; var t = new Thread(delegate() { try { action(); } catch (Exception e) { error = e; } }); t.IsBackground = true; t.Start();
            if (!t.Join(ms)) return false;
            if (error != null) throw new ScreenError(error.Message);
            return true;
        }
        string UiAct(Dictionary<string, object> a) {
            Free();
            int n = (int)Wire.Number(a, "ref"); var list = refs; string verb = Wire.Text(a, "verb"), note = null;
            if (n < 1 || n > list.Count) throw new ScreenError("unknown ref " + n + "; call ui_tree first");
            var e = list[n - 1];
            try {
                if (e.Current.ProcessId == (int)Win.GetCurrentProcessId()) throw new ScreenError("that element belongs to the support window");
                Func<AutomationPattern, object> pattern = delegate(AutomationPattern p) {
                    object o; if (!e.TryGetCurrentPattern(p, out o)) throw new ScreenError("element " + n + " does not support " + verb); return o;
                };
                // if-else, not a switch on strings: the compiler would add a hash helper class named with a random GUID and break the reproducible build.
                if (verb == "invoke") { var invoke = (InvokePattern)pattern(InvokePattern.Pattern); if (!Limited(delegate { invoke.Invoke(); }, 5000)) note = "still running after 5 s; a dialog may be open"; }
                else if (verb == "set_value") ((ValuePattern)pattern(ValuePattern.Pattern)).SetValue(Wire.Text(a, "value"));
                else if (verb == "toggle") ((TogglePattern)pattern(TogglePattern.Pattern)).Toggle();
                else if (verb == "focus") e.SetFocus();
                else if (verb == "expand") ((ExpandCollapsePattern)pattern(ExpandCollapsePattern.Pattern)).Expand();
                else if (verb == "collapse") ((ExpandCollapsePattern)pattern(ExpandCollapsePattern.Pattern)).Collapse();
                else if (verb == "select") ((SelectionItemPattern)pattern(SelectionItemPattern.Pattern)).Select();
                else throw new ScreenError("verb must be invoke, set_value, toggle, focus, expand, collapse or select");
            } catch (ElementNotAvailableException) { throw new ScreenError("element " + n + " is gone; call ui_tree again"); }
            catch (InvalidOperationException x) { throw new ScreenError("element " + n + " cannot do " + verb + ": " + x.Message); }
            return note;
        }

        static void Merge(Dictionary<string, object> into, Dictionary<string, object> from) { foreach (var kv in from) into[kv.Key] = kv.Value; }
        static double Seconds(Dictionary<string, object> a) { object v; return a.TryGetValue("seconds", out v) && v != null ? Math.Max(0, Math.Min(10, Convert.ToDouble(v))) : 1; }
        // Runs one "screen" or "control" frame and returns its result. Never throws.
        public Dictionary<string, object> Run(Dictionary<string, object> frame, WaitHandle stop) {
            string desktop = "unknown";
            try {
                Dpi(); desktop = Desktop();
                var a = frame.ContainsKey("action") ? frame["action"] as Dictionary<string, object> : null;
                if (Wire.Text(frame, "type") == "control" || a == null) throw new ScreenError(Wire.Text(frame, "type") == "control" ? NoFull : "missing screen action");
                string name = Wire.Text(a, "name");
                if (name == "block_input" || name == "send_sas" || name == "type_secret" || name == "request_full_control") throw new ScreenError(NoFull);
                if (Array.IndexOf(new string[] { "screenshot", "zoom", "wait", "ui_tree", "ui_act", "click", "move", "drag", "scroll", "type", "key" }, name) < 0) throw new ScreenError("unknown screen action");
                var r = Wire.Map("ok", true);
                if (name == "wait") stop.WaitOne((int)(Seconds(a) * 1000));
                else if (desktop != "default") throw new ScreenError("cannot reach the screen; Windows may be locked or showing a security prompt");
                View v = name == "wait" && !Wire.Flag(a, "screenshot") ? null : GetView(a);
                bool input = name == "click" || name == "move" || name == "drag" || name == "scroll" || name == "type" || name == "key" || name == "ui_act";
                if (name == "screenshot" || (name == "wait" && v != null)) Merge(r, Shot(v.Phys));
                else if (name == "zoom") {
                    v.Check((int)Wire.Number(a, "x1"), (int)Wire.Number(a, "y1")); int x2 = (int)Wire.Number(a, "x2"), y2 = (int)Wire.Number(a, "y2");
                    int px1 = ScreenMath.EdgeToPhysical((int)Wire.Number(a, "x1"), v.W, v.Phys.Width), py1 = ScreenMath.EdgeToPhysical((int)Wire.Number(a, "y1"), v.H, v.Phys.Height);
                    int px2 = ScreenMath.EdgeToPhysical(x2, v.W, v.Phys.Width), py2 = ScreenMath.EdgeToPhysical(y2, v.H, v.Phys.Height);
                    if (px2 <= px1 || py2 <= py1) throw new ScreenError("zoom needs x2 > x1 and y2 > y1");
                    Merge(r, Shot(new Gdi.Rectangle(v.Phys.X + px1, v.Phys.Y + py1, px2 - px1, py2 - py1)));
                }
                else if (name == "ui_tree") r["text"] = Tree(v, (int)Math.Max(1, Math.Min(2000, a.ContainsKey("max_lines") ? Wire.Number(a, "max_lines") : 300)));
                else if (name == "ui_act") { string note = UiAct(a); if (note != null) r["text"] = note; }
                else if (name != "wait") Input(name, a, v);
                if (input && (!a.ContainsKey("screenshot") || Wire.Flag(a, "screenshot"))) { Thread.Sleep(300); Merge(r, Shot(v.Phys)); }
                if (v != null) { r["display"] = v.Index; r["displays"] = v.Count; }
                r["desktop"] = desktop;
                return r;
            } catch (Exception e) { return Wire.Map("ok", false, "error", e is ScreenError || e is ArgumentException ? e.Message : e.GetType().Name + ": " + e.Message); }
        }
    }

    public sealed class Client : IDisposable {
        readonly Dictionary<string, object> config;
        readonly ManualResetEvent stop = new ManualResetEvent(false);
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly object gate = new object();
        readonly System.Threading.Timer deadlineTimer;
        // Raised when a lane finishes, so a parked poll ends and the result goes out at once.
        readonly AutoResetEvent signal = new AutoResetEvent(false);
        HttpWebRequest request;
        bool polling, woke;
        long deadlineMs, generation, expiresAtMs, serverOffsetMs;
        int busy;
        string work;
        volatile Screen screen;
        public event Action<string> Log;
        public event Action<string> Status;
        public event Action Finished;
        // Raised once, after the first successful handshake. ExpiresLocal is valid.
        public event Action Connected;
        // false while polling fails with a network error, true once it works again.
        public event Action<bool> LinkChanged;
        // Number of command or file operations started and not yet reported to the relay.
        public event Action<int> BusyChanged;
        public string LastError = "";
        // Set only by the visible window when Windows shuts down for an
        // explicitly prepared restart. User close/End still ends the session.
        public volatile bool EndRemote = true;
        public Client(Dictionary<string, object> cfg) {
            config = cfg;
            // The relay sends the first-connect budget as milliseconds left when the
            // file was downloaded, so a PC clock that is wrong cannot end the client
            // at once. The absolute startup_expires_at is only a fallback for a
            // config without it. The relay enforces the same limit on its own clock.
            long remaining = cfg.ContainsKey("startup_ms") ? Wire.Number(cfg, "startup_ms") : Wire.Number(cfg, "startup_expires_at") - UnixNow();
            deadlineMs = Math.Max(0, Math.Min(7200000, remaining));
            deadlineTimer = new System.Threading.Timer(delegate(object state) { if (clock.ElapsedMilliseconds >= Interlocked.Read(ref deadlineMs)) Stop(); }, null, 100, 100);
        }
        public DateTime ExpiresLocal {
            get {
                long ms = Interlocked.Read(ref expiresAtMs);
                return ms == 0 ? DateTime.MinValue : new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms).ToLocalTime();
            }
        }
        public int BusyCount { get { return Thread.VolatileRead(ref busy); } }
        // True for 3 s after the customer last used the mouse or keyboard.
        public bool Paused { get { var s = screen; return s != null && s.Paused; } }
        // One operation at a time per lane. Screen operations run while a command runs.
        sealed class Lane {
            public readonly string Name; public readonly ManualResetEvent Done = new ManualResetEvent(false);
            public Thread Op; public Dictionary<string, object> OpResult, Result; public string ActiveId = "", LastId = "";
            public Lane(string name) { Name = name; }
            public bool Busy { get { return ActiveId != ""; } }
        }
        static string LaneOf(string type) { return type == "run" || type == "put_file" || type == "get_file" ? "cmd" : type == "screen" || type == "control" ? "screen" : null; }
        void Wake() {
            signal.Set();
            lock (gate) { woke = true; if (polling && request != null) request.Abort(); }
        }
        bool Woken(bool poll) {
            lock (gate) { if (!poll || !woke || stop.WaitOne(0)) return false; woke = false; return true; }
        }
        void Work(int delta) {
            int n = Interlocked.Add(ref busy, delta);
            var changed = BusyChanged; if (changed != null) changed(n);
        }
        void Link(bool up) { var link = LinkChanged; if (link != null) link(up); }
        public static long UnixNow() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
        static string PowerShellVersion() {
            foreach (string version in new string[] { "3", "1" }) {
                object value = Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\PowerShell\" + version + @"\PowerShellEngine", "PowerShellVersion", null);
                if (value != null) return Convert.ToString(value);
            }
            return "unknown";
        }
        void Print(string text) { var log = Log; if (log != null) log(text); }
        void ShowStatus(string text) { var status = Status; if (status != null) status(text); }
        public void Stop() {
            stop.Set(); lock (gate) { if (request != null) request.Abort(); }
        }
        // A poll that Wake ended early returns null.
        Dictionary<string, object> Send(Dictionary<string, object> body, bool ending, bool poll) {
            if (!ending && stop.WaitOne(0)) throw new OperationCanceledException();
            var req = (HttpWebRequest)WebRequest.Create(Wire.Text(config, "origin") + "/agent?sid=" + Wire.Text(config, "sid"));
            req.Method = "POST"; req.ContentType = "application/json"; req.AllowAutoRedirect = false;
            req.Timeout = ending ? 3000 : 30000; req.ReadWriteTimeout = req.Timeout;
            req.Headers["X-Attach-Key"] = Wire.Text(config, "key");
            req.Proxy = WebRequest.DefaultWebProxy;
            byte[] bytes = Encoding.UTF8.GetBytes(Wire.Json().Serialize(body)); req.ContentLength = bytes.Length;
            lock (gate) {
                if (!ending && stop.WaitOne(0)) throw new OperationCanceledException();
                if (poll && woke) { woke = false; return null; }
                request = req; polling = poll;
            }
            try {
                using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
                using (var response = (HttpWebResponse)req.GetResponse()) {
                    if (response.StatusCode != HttpStatusCode.OK) throw new InvalidDataException("Unexpected support server response.");
                    using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                        char[] buf = new char[8192]; var data = new StringBuilder(); int n;
                        while ((n = reader.Read(buf, 0, buf.Length)) > 0) {
                            if (data.Length + n > 750000) throw new InvalidDataException("Support response too large.");
                            data.Append(buf, 0, n);
                        }
                        return Wire.Json().Deserialize<Dictionary<string, object>>(data.ToString());
                    }
                }
            } catch (WebException e) {
                if (Woken(poll)) return null;
                var r = e.Response as HttpWebResponse;
                if (r != null) {
                    int code = (int)r.StatusCode; r.Close();
                    if (code == 401 || code == 403 || code == 409 || code == 410) throw new OperationCanceledException("Support access has ended.");
                }
                throw;
            } catch (IOException) { if (Woken(poll)) return null; throw; }
            finally { lock (gate) { if (request == req) { request = null; polling = false; } } }
        }
        static string AbsolutePath(string path) {
            // Only normal local absolute paths. Refuse relative, device, UNC,
            // and alternate-stream paths; do not turn a file op into a share login.
            if (!System.Text.RegularExpressions.Regex.IsMatch(path, @"^[A-Za-z]:[\\/]") || path.IndexOf(':', 2) >= 0)
                throw new ArgumentException("A local absolute file path is required.");
            return Path.GetFullPath(path);
        }
        Dictionary<string, object> Execute(Dictionary<string, object> frame) {
            try {
                if (stop.WaitOne(0)) throw new OperationCanceledException();
                string type = Wire.Text(frame, "type");
                if (type == "screen" || type == "control") return screen.Run(frame, stop);
                if (type == "run") {
                    string file = Path.Combine(work, "command.ps1");
                    string prefix = "$ProgressPreference = 'SilentlyContinue'\r\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\r\n";
                    File.WriteAllText(file, prefix + Wire.Text(frame, "command"), new UTF8Encoding(true));
                    using (var job = new CommandJob()) return job.Run(file, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), (int)Math.Max(1, Math.Min(600, Wire.Number(frame, "timeout_s"))), stop);
                }
                string path = AbsolutePath(Wire.Text(frame, "path"));
                if (type == "put_file") {
                    string encoded = Wire.Text(frame, "data_b64");
                    if (encoded.Length > 700000) throw new ArgumentException("File chunk too large.");
                    byte[] data = Convert.FromBase64String(encoded);
                    // Same as the PowerShell agent: create missing parent directories (path is already validated).
                    string parent = Path.GetDirectoryName(path);
                    if (!String.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                    using (var s = new FileStream(path, Wire.Flag(frame, "append") ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.Read)) s.Write(data, 0, data.Length);
                    return Wire.Map("ok", true, "bytes", data.Length);
                }
                if (type != "get_file") throw new ArgumentException("Unknown operation.");
                long offset = Math.Max(0, Wire.Number(frame, "offset"));
                int length = (int)Math.Max(1, Math.Min(524288, Wire.Number(frame, "length")));
                // FileShare.ReadWrite, like the PowerShell agent, so a log another process is writing can be read.
                using (var s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
                    s.Position = offset; byte[] data = new byte[length]; int total = 0, n;
                    while (total < length && (n = s.Read(data, total, length - total)) > 0) total += n;
                    return Wire.Map("ok", true, "data_b64", Convert.ToBase64String(data, 0, total), "size", s.Length, "eof", s.Position >= s.Length);
                }
            } catch (Exception e) { return Wire.Map("ok", false, "error", e.Message); }
        }
        public void Run() {
            var lanes = new Lane[] { new Lane("cmd"), new Lane("screen") }; string networkError = "";
            try {
                var security = new DirectorySecurity();
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                work = Path.Combine(Path.GetTempPath(), "remote-support-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(work, security);
                screen = new Screen(); screen.Start();
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2 on .NET 4.5.2
                while (!stop.WaitOne(0)) {
                    try {
                        if (generation == 0) {
                            var welcome = Send(Wire.Map("type", "hello", "machine", Environment.MachineName, "user", Environment.UserName,
                                "ps", PowerShellVersion(), "agent", "windows-app-2", "elevated", SupportAccess.IsAdministrator(),
                                "caps", new string[] { "screen", "uia", "lanes" }, "control", "normal"), false, false);
                            if (Wire.Text(welcome, "type") != "welcome") throw new InvalidDataException("Invalid support handshake.");
                            generation = Wire.Number(welcome, "generation");
                            long expires = Wire.Number(welcome, "expires_at"), now = Wire.Number(welcome, "server_time");
                            if (now == 0) now = UnixNow();
                            serverOffsetMs = now - UnixNow(); // the relay reports deadlines on its own clock
                            long remainingMs = Math.Max(0, Math.Min(86400000, expires - now));
                            Interlocked.Exchange(ref deadlineMs, clock.ElapsedMilliseconds + remainingMs);
                            Interlocked.Exchange(ref expiresAtMs, UnixNow() + remainingMs);
                            ShowStatus("Support session active. Close this window to end access.");
                            Print("Connected. Commands run as " + Environment.UserName + (SupportAccess.IsAdministrator() ? " with administrator rights." : " with normal user rights."));
                            var connected = Connected; if (connected != null) connected();
                        }
                        lock (gate) woke = false;
                        bool over = false;
                        foreach (var lane in lanes) {
                            if (lane.Op != null && lane.Done.WaitOne(0)) {
                                lane.Op.Join(); lane.Op = null; lane.Result = lane.OpResult;
                                lane.Result["type"] = "result"; lane.Result["id"] = lane.ActiveId; lane.Result["generation"] = generation;
                            }
                            if (lane.Result != null) {
                                var ack = Send(lane.Result, false, false);
                                if (Wire.Text(ack, "type") == "end") { over = true; break; }
                                if (Wire.Text(ack, "type") != "ack") throw new InvalidDataException("Result not acknowledged.");
                                lane.LastId = lane.ActiveId; lane.ActiveId = ""; lane.Result = null; Work(-1);
                            }
                        }
                        if (over) break;
                        if (lanes[0].Busy && lanes[1].Busy) {
                            // The relay answers a poll at once when no lane is free, so do not spin on it. Wait
                            // for a lane and poll every 2 s. That keeps the client marked alive and notices an
                            // operator end or expiry within about 2 s.
                            if (WaitHandle.WaitAny(new WaitHandle[] { signal, stop }, 2000) == 0) continue;
                            if (stop.WaitOne(0)) break;
                        }
                        // While one lane works, keep polling for the other, so screen operations reach the
                        // client during a long command. A finishing lane ends the parked poll through Wake.
                        var busyLanes = new List<string>(); foreach (var lane in lanes) if (lane.Busy) busyLanes.Add(lane.Name);
                        var pollClock = Stopwatch.StartNew();
                        var poll = Wire.Map("type", "poll", "generation", generation, "busy", lanes[0].Busy, "busy_lanes", busyLanes);
                        if (screen != null) { poll["desktop"] = Screen.Desktop(); poll["paused_until"] = screen.Paused ? UnixNow() + serverOffsetMs + screen.PausedForMs : (object)null; }
                        var frame = Send(poll, false, true);
                        if (frame == null) continue;
                        if (networkError != "") { networkError = ""; ShowStatus("Support session active. Close this window to end access."); Print("Connection restored."); Link(true); }
                        string type = Wire.Text(frame, "type"), id = Wire.Text(frame, "id");
                        if (type == "end") break;
                        if (type == "idle") {
                            // An older relay answers a poll at once while a command runs: do not spin on it.
                            if ((lanes[0].Busy || lanes[1].Busy) && pollClock.ElapsedMilliseconds < 1000 && WaitHandle.WaitAny(new WaitHandle[] { signal, stop }, 2000) == 1) break;
                            continue;
                        }
                        string laneName = LaneOf(type); Lane target = laneName == null ? null : lanes[laneName == "cmd" ? 0 : 1];
                        if (id == "" || target == null) throw new InvalidDataException("Invalid support operation.");
                        if (target.Busy || id == target.LastId) { stop.WaitOne(1000); continue; }
                        Print(type == "run" ? "$ " + Wire.Text(frame, "command") : type == "screen" || type == "control" ? type : type + " " + Wire.Text(frame, "path"));
                        target.ActiveId = id; target.Done.Reset(); Work(1);
                        var command = frame; var running = target;
                        target.Op = new Thread(delegate() { running.OpResult = Execute(command); running.Done.Set(); Wake(); });
                        target.Op.IsBackground = true; target.Op.Start();
                        stop.WaitOne(100);
                    } catch (OperationCanceledException) { break; }
                    catch (WebException e) {
                        if (networkError != e.Message) { networkError = e.Message; Print("Connection error: " + e.Message); }
                        ShowStatus("Connection interrupted. Retrying; close the window to end access."); Link(false); stop.WaitOne(3000);
                    }
                }
            } catch (Exception e) { LastError = e.Message; Print("Stopped: " + e.Message); }
            finally {
                Stop();
                foreach (var lane in lanes) if (lane.Op != null) lane.Op.Join(15000);
                if (EndRemote && generation != 0) { try { Send(Wire.Map("type", "end", "generation", generation), true, false); } catch { } }
                if (work != null) { try { Directory.Delete(work, true); } catch { } }
                Print(EndRemote ? "Support access stopped." : "Windows is restarting. One-time reconnect is prepared.");
                ShowStatus("Support session ended. You can close this window.");
                if (Interlocked.Exchange(ref busy, 0) > 0) { var changed = BusyChanged; if (changed != null) changed(0); }
                var finished = Finished; if (finished != null) finished();
                foreach (var lane in lanes) lane.Done.Close();
                if (screen != null) { var s = screen; screen = null; s.Dispose(); }
            }
        }
        public void Dispose() { Stop(); deadlineTimer.Dispose(); /* callbacks may still hold stop */ }
    }

    public static class RestartResume {
        const string RunOnce = @"Software\Microsoft\Windows\CurrentVersion\RunOnce";
        const string ConsentKey = @"Software\SupportMcp\ReconnectConsent";
        public static string Folder(Dictionary<string, object> cfg) {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SupportMcp", Wire.Text(cfg, "sid").Substring(0, 8));
        }
        public static string PathFor(Dictionary<string, object> cfg) { return Path.Combine(Folder(cfg), "agent.exe"); }
        public static string ValueName(Dictionary<string, object> cfg) { return "SupportMcp-" + Wire.Text(cfg, "sid").Substring(0, 8); }
        public static bool Scoped(Dictionary<string, object> cfg, string executable) {
            return Wire.Flag(cfg, "restart_resume") && String.Equals(Path.GetFullPath(executable), Path.GetFullPath(PathFor(cfg)), StringComparison.OrdinalIgnoreCase);
        }
        public static bool Valid(Dictionary<string, object> cfg, string executable) {
            long remaining = Wire.Number(cfg, "resume_expires_at") - Client.UnixNow();
            return Scoped(cfg, executable) && remaining > 0 && remaining <= 86400000;
        }
        static string ConsentValue(Dictionary<string, object> cfg) {
            using (var identity = WindowsIdentity.GetCurrent())
                return identity.User.Value + "|" + Wire.Number(cfg, "resume_expires_at").ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        public static bool HasAdministratorConsent(Dictionary<string, object> cfg) {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(ConsentKey))
                return key != null && String.Equals(key.GetValue(Wire.Text(cfg, "sid")) as string, ConsentValue(cfg), StringComparison.Ordinal);
        }
        public static void Arm(Dictionary<string, object> cfg) { Arm(cfg, false); }
        public static void Arm(Dictionary<string, object> cfg, bool administrator) {
            // Written only after the visible preparation prompt approves one
            // reconnect with these rights. Bind it to this user and deadline.
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(ConsentKey)) {
                if (administrator) key.SetValue(Wire.Text(cfg, "sid"), ConsentValue(cfg), Microsoft.Win32.RegistryValueKind.String);
                else key.DeleteValue(Wire.Text(cfg, "sid"), false);
            }
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunOnce))
                key.SetValue(ValueName(cfg), "\"" + PathFor(cfg) + "\" --resume", Microsoft.Win32.RegistryValueKind.String);
        }
        public static void Disarm(Dictionary<string, object> cfg) {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunOnce, true))
                if (key != null) key.DeleteValue(ValueName(cfg), false);
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(ConsentKey, true))
                if (key != null) key.DeleteValue(Wire.Text(cfg, "sid"), false);
        }
        public static void Cleanup(Dictionary<string, object> cfg) {
            Disarm(cfg);
            // Delete only the scoped support executable after it exits. Keep
            // this helper outside command Jobs; it performs no privileged work.
            string file = PathFor(cfg).Replace("'", "''"), folder = Folder(cfg).Replace("'", "''");
            string script = "$ErrorActionPreference='SilentlyContinue'; for($i=0;$i -lt 20;$i++){ Start-Sleep -Seconds 1; Remove-Item -LiteralPath '" + file + "' -Force; if(-not(Test-Path -LiteralPath '" + file + "')){ if(@(Get-ChildItem -LiteralPath '" + folder + "' -Force).Count -eq 0){ Remove-Item -LiteralPath '" + folder + "' -Force }; break } }";
            Process.Start(new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)),
                UseShellExecute = false, CreateNoWindow = true
            });
        }
    }

    // Colors for the customer windows. Light is the default; dark follows the
    // Windows "apps" theme when that registry value exists (not on Windows 7).
    public sealed class Palette {
        public readonly bool Dark;
        public readonly Brush Surface, Surface2, Ink, Muted, Line, Live, LiveSoft, LiveSoftHover, Work, WorkSoft, Stop, StopBg, StopBgHover, StopSolid, StopSolidHover;
        public readonly Color WorkColor, ShadowColor;
        public readonly double ShadowOpacity;
        public static Brush Solid(string hex, byte alpha) {
            Color c = (Color)ColorConverter.ConvertFromString(hex);
            var brush = new SolidColorBrush(Color.FromArgb(alpha, c.R, c.G, c.B)); brush.Freeze(); return brush;
        }
        public Palette(bool dark) {
            Dark = dark;
            if (dark) {
                Surface = Solid("#202227", 255); Surface2 = Solid("#2A2D33", 255); Ink = Solid("#F2F4F7", 255); Muted = Solid("#A3AAB6", 255); Line = Solid("#373B43", 255);
                Live = Solid("#3DD68C", 255); LiveSoft = Solid("#3DD68C", 46); LiveSoftHover = Solid("#3DD68C", 70);
                Work = Solid("#6EA0FF", 255); WorkSoft = Solid("#6EA0FF", 56); WorkColor = Color.FromRgb(0x6E, 0xA0, 0xFF);
                Stop = Solid("#FF8A80", 255); StopBg = Solid("#3A2224", 255); StopBgHover = Solid("#46292B", 255);
                StopSolid = Solid("#D9443B", 255); StopSolidHover = Solid("#C23B33", 255);
                ShadowColor = Colors.Black; ShadowOpacity = 0.45;
            } else {
                Surface = Solid("#FFFFFF", 255); Surface2 = Solid("#F5F6F8", 255); Ink = Solid("#141A24", 255); Muted = Solid("#5B6472", 255); Line = Solid("#E4E7EC", 255);
                Live = Solid("#1F9D55", 255); LiveSoft = Solid("#1F9D55", 41); LiveSoftHover = Solid("#1F9D55", 64);
                Work = Solid("#2563EB", 255); WorkSoft = Solid("#2563EB", 46); WorkColor = Color.FromRgb(0x25, 0x63, 0xEB);
                Stop = Solid("#B42318", 255); StopBg = Solid("#FDEDEC", 255); StopBgHover = Solid("#F9E0DE", 255);
                StopSolid = Solid("#C4302B", 255); StopSolidHover = Solid("#AC2823", 255);
                ShadowColor = Color.FromRgb(0x10, 0x18, 0x28); ShadowOpacity = 0.22;
            }
        }
        public static Palette Detect() {
            bool dark = false;
            try {
                object value = Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", null);
                dark = value is int && (int)value == 0;
            } catch (Exception) { }
            return new Palette(dark);
        }
    }

    // Small builders shared by both windows.
    public static class Ui {
        public const string TextFont = "Segoe UI Variable Text, Segoe UI";
        public const string DisplayFont = "Segoe UI Variable Display, Segoe UI";
        public const string MonoFont = "Cascadia Mono, Consolas";
        public static TextBlock Label(string text, double size, FontWeight weight, Brush color, string font) {
            return new TextBlock { Text = text, FontSize = size, FontWeight = weight, Foreground = color, FontFamily = new FontFamily(font), TextWrapping = TextWrapping.Wrap };
        }
        public static string Clock(TimeSpan span) {
            long s = (long)span.TotalSeconds;
            // Not String.Format(provider, format, a, b, c): that overload is new in .NET 4.6 and throws MissingMethodException on 4.5.2.
            var invariant = System.Globalization.CultureInfo.InvariantCulture;
            return (s / 3600).ToString("00", invariant) + ":" + ((s / 60) % 60).ToString("00", invariant) + ":" + (s % 60).ToString("00", invariant);
        }
        // The card: rounded, bordered, with a soft shadow. Content goes into
        // `inner`, which is clipped to the rounded corners.
        public static Border Card(Palette p, double width, out Grid inner) {
            var grid = new Grid();
            var card = new Border {
                Background = p.Surface, BorderBrush = p.Line, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8),
                HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Child = grid,
                Effect = new DropShadowEffect { BlurRadius = 24, ShadowDepth = 6, Direction = 270, Color = p.ShadowColor, Opacity = p.ShadowOpacity }
            };
            if (width > 0) card.Width = width;
            grid.SizeChanged += delegate { grid.Clip = new RectangleGeometry(new Rect(0, 0, grid.ActualWidth, grid.ActualHeight), 7, 7); };
            inner = grid; return card;
        }
        public static void Drag(Window window, UIElement handle) { Drag(window, handle, null); }
        public static void Drag(Window window, UIElement handle, Action moved) {
            handle.MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e) {
                if (e.ButtonState != MouseButtonState.Pressed) return;
                double left = window.Left, top = window.Top;
                try { window.DragMove(); } catch (InvalidOperationException) { return; }
                if (moved != null && (window.Left != left || window.Top != top)) moved();
            };
        }
        public static void Transparent(Window w) {
            w.WindowStyle = WindowStyle.None; w.AllowsTransparency = true; w.Background = Brushes.Transparent; w.ResizeMode = ResizeMode.NoResize;
            w.Topmost = true; w.ShowInTaskbar = true; w.Title = "Remote support"; w.UseLayoutRounding = true; w.SnapsToDevicePixels = true;
            w.FontFamily = new FontFamily(TextFont); w.FontSize = 13;
        }
    }

    // A small vector icon: stroked and filled paths painted with one brush.
    public sealed class Glyph {
        public readonly Canvas Root;
        readonly List<Shapes.Path> strokes = new List<Shapes.Path>(), fills = new List<Shapes.Path>();
        public Glyph(double size) { Root = new Canvas { Width = size, Height = size }; }
        public Glyph Line(string data, double thickness) {
            var path = new Shapes.Path { Data = Geometry.Parse(data), StrokeThickness = thickness, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round };
            strokes.Add(path); Root.Children.Add(path); return this;
        }
        public Glyph Fill(Geometry geometry) {
            var path = new Shapes.Path { Data = geometry };
            fills.Add(path); Root.Children.Add(path); return this;
        }
        public Glyph Paint(Brush brush) {
            foreach (var path in strokes) path.Stroke = brush;
            foreach (var path in fills) path.Fill = brush;
            return this;
        }
        public FrameworkElement Sized(double size) { return new Viewbox { Width = size, Height = size, Stretch = Stretch.Uniform, Child = Root }; }
        public static Glyph Screen() {
            return new Glyph(16).Line("M 3,2.5 L 13,2.5 A 1.5,1.5 0 0 1 14.5,4 L 14.5,10 A 1.5,1.5 0 0 1 13,11.5 L 3,11.5 A 1.5,1.5 0 0 1 1.5,10 L 1.5,4 A 1.5,1.5 0 0 1 3,2.5 Z", 1.3)
                .Line("M 5.5,14 L 10.5,14 M 8,11.5 L 8,14", 1.3);
        }
        public static Glyph Headset() {
            return new Glyph(20).Line("M 3.5,11 L 3.5,9.5 A 6.5,6.5 0 0 1 16.5,9.5 L 16.5,11", 1.6)
                .Fill(new RectangleGeometry(new Rect(2.5, 10.5, 3.5, 5), 1.4, 1.4)).Fill(new RectangleGeometry(new Rect(14, 10.5, 3.5, 5), 1.4, 1.4))
                .Line("M 15.8,15.5 C 15.8,16.9 14.4,17.7 12,17.7", 1.4);
        }
        public static Glyph Warning() {
            return new Glyph(20).Line("M 10,3 L 18,16.5 L 2,16.5 Z", 1.6).Line("M 10,8 L 10,12 M 10,14.2 L 10,14.3", 1.6);
        }
        public static Glyph Chevron(bool down) {
            return new Glyph(14).Line(down ? "M 3.5,5.5 L 7,9 L 10.5,5.5" : "M 3.5,8.5 L 7,5 L 10.5,8.5", 1.4);
        }
    }

    // Flat rounded button with a hover color and a keyboard focus ring.
    public sealed class FlatButton : Button {
        readonly Brush rest, hover;
        public FlatButton(object content, Brush foreground, Brush rest, Brush hover, Brush focusRing, double height, double minWidth, double padding, double radius, double fontSize) {
            this.rest = rest; this.hover = hover;
            Content = content; Foreground = foreground; Background = rest; Height = height; MinWidth = minWidth;
            Padding = new Thickness(padding, 0, padding, 0); FontSize = fontSize; FontWeight = FontWeights.SemiBold;
            Cursor = Cursors.Hand; Focusable = true; FocusVisualStyle = null; BorderThickness = new Thickness(0);
            var border = new FrameworkElementFactory(typeof(Border), "bd");
            border.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(Control.BackgroundProperty));
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(radius));
            border.SetValue(Border.BorderThicknessProperty, new Thickness(2));
            border.SetValue(Border.BorderBrushProperty, Brushes.Transparent);
            var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            presenter.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            presenter.SetValue(FrameworkElement.MarginProperty, new TemplateBindingExtension(Control.PaddingProperty));
            border.AppendChild(presenter);
            var template = new ControlTemplate(typeof(Button)) { VisualTree = border };
            var focused = new Trigger { Property = UIElement.IsKeyboardFocusedProperty, Value = true };
            focused.Setters.Add(new Setter(Border.BorderBrushProperty, focusRing, "bd"));
            template.Triggers.Add(focused);
            Template = template;
            IsVisibleChanged += delegate { Background = IsMouseOver ? hover : rest; };
        }
        protected override void OnMouseEnter(MouseEventArgs e) { base.OnMouseEnter(e); Background = hover; }
        protected override void OnMouseLeave(MouseEventArgs e) { base.OnMouseLeave(e); Background = rest; }
    }

    // The window the customer sees while support is connected.
    public sealed class SupportWindow : Window {
        const double CardWidth = 336, Gap = 12, Pad = 20;
        readonly Client client;
        readonly Palette p;
        readonly bool preparing;
        public volatile bool Preserve;
        bool connectedOnce, linkOk = true, busy, paused, workShown, ended, tucked, confirming, sessionEnding, sweeping, userMoved, placing;
        readonly Stopwatch session = new Stopwatch(), workClock = new Stopwatch();
        TimeSpan endedAfter;
        double userLeft, userCardBottom;
        readonly DispatcherTimer tick = new DispatcherTimer(), hold = new DispatcherTimer(), closer = new DispatcherTimer(), pause = new DispatcherTimer();
        readonly Grid root;
        readonly Border card, tile, tuckTile, edge;
        readonly Glyph tileGlyph, tuckGlyph;
        readonly System.Windows.Shapes.Rectangle sweep;
        readonly TranslateTransform sweepMove = new TranslateTransform();
        readonly TextBlock head, status, until, adminLine, noteLine, tuckTitle, tuckTimer, askTitle, askText;
        readonly StackPanel fullView, tuckView, askFoot;
        readonly Border askBox, normalFoot;
        readonly FlatButton collapse, endButton, tuckEnd, expand, keep, sure;
        Run timerRun;

        public SupportWindow(Client client, Palette palette, bool administrator, bool preparing, string note) {
            this.client = client; this.p = palette; this.preparing = preparing;
            Ui.Transparent(this);
            Width = CardWidth + 2 * Pad; SizeToContent = SizeToContent.Height; WindowStartupLocation = WindowStartupLocation.Manual;
            Foreground = p.Ink;

            Grid inner; card = Ui.Card(p, CardWidth, out inner);
            root = new Grid { Margin = new Thickness(Pad) }; root.Children.Add(card); Content = root;
            var stack = new StackPanel(); inner.Children.Add(stack);

            // 3 px edge: green when connected, blue sweep while working.
            edge = new Border { Height = 3 };
            var edgeHost = new Grid { Height = 3, ClipToBounds = true };
            edgeHost.Children.Add(edge);
            Color clear = Color.FromArgb(0, p.WorkColor.R, p.WorkColor.G, p.WorkColor.B);
            var sweepBrush = new LinearGradientBrush(clear, clear, 0);
            sweepBrush.GradientStops.Clear();
            sweepBrush.GradientStops.Add(new GradientStop(clear, 0)); sweepBrush.GradientStops.Add(new GradientStop(p.WorkColor, 0.5)); sweepBrush.GradientStops.Add(new GradientStop(clear, 1));
            sweep = new System.Windows.Shapes.Rectangle { Width = CardWidth * 0.45, Height = 3, Fill = sweepBrush, HorizontalAlignment = HorizontalAlignment.Left, RenderTransform = sweepMove, Visibility = Visibility.Collapsed };
            edgeHost.Children.Add(sweep);
            stack.Children.Add(edgeHost);

            // Full view: header, body, footer.
            fullView = new StackPanel(); stack.Children.Add(fullView);
            var header = new Grid { Height = 36, Margin = new Thickness(14, 0, 6, 0), Background = Brushes.Transparent };
            var title = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            var screen = Glyph.Screen().Paint(p.Muted).Sized(16); screen.Margin = new Thickness(0, 0, 8, 0);
            title.Children.Add(screen);
            var titleText = Ui.Label("Remote support", 12, FontWeights.SemiBold, p.Muted, Ui.TextFont); titleText.VerticalAlignment = VerticalAlignment.Center;
            title.Children.Add(titleText);
            header.Children.Add(title);
            collapse = IconButton(Glyph.Chevron(true), "Tuck into the corner"); collapse.HorizontalAlignment = HorizontalAlignment.Right;
            header.Children.Add(collapse);
            Ui.Drag(this, header, OnDragged);
            fullView.Children.Add(header);

            var body = new Grid { Margin = new Thickness(16, 2, 16, 14) };
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(40) });
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            tileGlyph = Glyph.Headset();
            tile = new Border { Width = 40, Height = 40, CornerRadius = new CornerRadius(10), VerticalAlignment = VerticalAlignment.Top, Child = tileGlyph.Sized(20) };
            body.Children.Add(tile);
            var text = new StackPanel { Margin = new Thickness(12, 0, 0, 0) };
            Grid.SetColumn(text, 1);
            head = Ui.Label("", 15.5, FontWeights.SemiBold, p.Ink, Ui.DisplayFont); head.LineHeight = 21; head.Margin = new Thickness(0, 0, 0, 5);
            status = Ui.Label("", 12.5, FontWeights.Normal, p.Muted, Ui.TextFont);
            text.Children.Add(head); text.Children.Add(status);
            if (administrator) {
                adminLine = Ui.Label("Running with administrator rights.", 12.5, FontWeights.Normal, p.Stop, Ui.TextFont); adminLine.Margin = new Thickness(0, 6, 0, 0);
                text.Children.Add(adminLine);
            }
            if (!String.IsNullOrEmpty(note)) {
                noteLine = Ui.Label(note, 12, FontWeights.Normal, p.Muted, Ui.TextFont); noteLine.Margin = new Thickness(0, 6, 0, 0);
                text.Children.Add(noteLine);
            }
            body.Children.Add(text);
            fullView.Children.Add(body);

            // Normal footer.
            normalFoot = new Border { BorderBrush = p.Line, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(8, 10, 12, 12) };
            var footGrid = new Grid();
            footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            until = Ui.Label("", 12, FontWeights.Normal, p.Muted, Ui.TextFont);
            until.Margin = new Thickness(4, 0, 8, 0); until.VerticalAlignment = VerticalAlignment.Center; until.TextWrapping = TextWrapping.NoWrap; until.TextTrimming = TextTrimming.CharacterEllipsis;
            footGrid.Children.Add(until);
            endButton = new FlatButton("End session", p.Stop, p.StopBg, p.StopBgHover, p.Work, 32, 0, 12, 6, 13);
            Grid.SetColumn(endButton, 1); footGrid.Children.Add(endButton);
            normalFoot.Child = footGrid;
            fullView.Children.Add(normalFoot);

            // Inline end confirmation.
            askBox = new Border { BorderBrush = p.Line, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(16, 12, 16, 0), Visibility = Visibility.Collapsed };
            var ask = new StackPanel();
            askTitle = Ui.Label("End the session?", 13, FontWeights.SemiBold, p.Ink, Ui.TextFont); askTitle.Margin = new Thickness(0, 0, 0, 2);
            askText = Ui.Label("Support loses access to this PC right away.", 12.5, FontWeights.Normal, p.Muted, Ui.TextFont);
            ask.Children.Add(askTitle); ask.Children.Add(askText); askBox.Child = ask;
            fullView.Children.Add(askBox);
            askFoot = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(8, 10, 12, 12), Visibility = Visibility.Collapsed };
            keep = new FlatButton("Keep connected", p.Ink, Brushes.Transparent, p.Surface2, p.Work, 32, 0, 12, 6, 13);
            sure = new FlatButton("End session", Brushes.White, p.StopSolid, p.StopSolidHover, p.Work, 32, 0, 14, 6, 13); sure.Margin = new Thickness(8, 0, 0, 0);
            askFoot.Children.Add(keep); askFoot.Children.Add(sure);
            fullView.Children.Add(askFoot);

            // Tucked bar.
            tuckGlyph = Glyph.Headset();
            tuckTile = new Border { Width = 26, Height = 26, CornerRadius = new CornerRadius(7), Child = tuckGlyph.Sized(14), VerticalAlignment = VerticalAlignment.Center };
            tuckView = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(8, 6, 6, 6), Background = Brushes.Transparent, Visibility = Visibility.Collapsed };
            tuckTitle = Ui.Label("Remote support", 12.5, FontWeights.SemiBold, p.Ink, Ui.TextFont); tuckTitle.Margin = new Thickness(8, 0, 0, 0); tuckTitle.VerticalAlignment = VerticalAlignment.Center; tuckTitle.TextWrapping = TextWrapping.NoWrap;
            tuckTimer = Ui.Label("", 12, FontWeights.Normal, p.Muted, Ui.MonoFont); tuckTimer.Margin = new Thickness(8, 0, 0, 0); tuckTimer.VerticalAlignment = VerticalAlignment.Center; tuckTimer.TextWrapping = TextWrapping.NoWrap;
            expand = IconButton(Glyph.Chevron(false), "Show the support window"); expand.Margin = new Thickness(4, 0, 0, 0);
            tuckEnd = new FlatButton("End", p.Stop, p.StopBg, p.StopBgHover, p.Work, 28, 0, 10, 6, 12.5); tuckEnd.Margin = new Thickness(2, 0, 0, 0);
            tuckView.Children.Add(tuckTile); tuckView.Children.Add(tuckTitle); tuckView.Children.Add(tuckTimer); tuckView.Children.Add(expand); tuckView.Children.Add(tuckEnd);
            Ui.Drag(this, tuckView, OnDragged);
            stack.Children.Add(tuckView);

            collapse.Click += delegate { tucked = true; confirming = false; Render(); };
            expand.Click += delegate { tucked = false; Render(); };
            endButton.Click += delegate { AskToEnd(); };
            tuckEnd.Click += delegate { AskToEnd(); };
            keep.Click += delegate { confirming = false; Render(); };
            sure.Click += delegate { client.Stop(); ShowEnded(); };
            PreviewKeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Escape && confirming) { confirming = false; Render(); e.Handled = true; } };

            tick.Interval = TimeSpan.FromSeconds(1); tick.Tick += delegate { UpdateTimer(); };
            pause.Interval = TimeSpan.FromMilliseconds(250);
            pause.Tick += delegate { bool now = client.Paused; if (now != paused) { paused = now; Render(); } };
            hold.Tick += delegate { hold.Stop(); if (!busy) workShown = false; Render(); };
            closer.Interval = TimeSpan.FromSeconds(4); closer.Tick += delegate { closer.Stop(); Close(); };

            // Placement is computed from the laid-out card (see Place), never from
            // an estimate. This rough first position only avoids a visible jump.
            Rect area = SystemParameters.WorkArea;
            Left = area.Right - Gap + Pad - Width;
            Top = area.Bottom - Gap - Pad - 300;
            Render();
            card.SizeChanged += delegate { Place(); Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(Place)); };
            ContentRendered += delegate { Place(); };
            PropertyChangedEventHandler workAreaChanged = delegate(object sender, PropertyChangedEventArgs e) { if (e.PropertyName == "WorkArea") Place(); };
            SystemParameters.StaticPropertyChanged += workAreaChanged;
            Closed += delegate { SystemParameters.StaticPropertyChanged -= workAreaChanged; };

            Closing += OnClosing;
            if (Application.Current != null)
                Application.Current.SessionEnding += delegate(object sender, SessionEndingCancelEventArgs e) { sessionEnding = true; };

            // Client threads post to the UI thread only; nothing here shows commands or paths.
            client.Connected += delegate { Post(OnConnected); };
            client.LinkChanged += delegate(bool up) { Post(delegate { OnLink(up); }); };
            client.BusyChanged += delegate(int count) { Post(delegate { OnBusy(count > 0); }); };
            client.Finished += delegate { Post(ShowEnded); };
        }

        // The visible card's right and bottom edges sit Gap pixels inside the work
        // area; the window is the card plus a transparent shadow margin of Pad.
        // After the customer drags the window, their spot is kept (bottom edge
        // fixed while the height changes) and only clamped onto the work area.
        void Place() {
            if (placing || card.ActualHeight <= 0) return;
            placing = true;
            try {
                Rect area = SystemParameters.WorkArea;
                double cardHeight = card.ActualHeight;
                double left = userMoved ? userLeft : area.Right - Gap + Pad - Width;
                double cardBottom = userMoved ? userCardBottom : area.Bottom - Gap;
                double top = cardBottom - cardHeight - Pad;
                if (userMoved) {
                    left = Math.Min(left, area.Right - Width + Pad); left = Math.Max(left, area.Left - Pad);
                    top = Math.Min(top, area.Bottom - cardHeight - Pad); top = Math.Max(top, area.Top - Pad);
                    userLeft = left; userCardBottom = top + Pad + cardHeight;
                }
                if (Math.Abs(Left - left) > 0.01) Left = left;
                if (Math.Abs(Top - top) > 0.01) Top = top;
            } finally { placing = false; }
        }
        void OnDragged() {
            userMoved = true; userLeft = Left; userCardBottom = Top + Pad + card.ActualHeight; Place();
        }

        FlatButton IconButton(Glyph glyph, string tip) {
            var button = new FlatButton(glyph.Paint(p.Muted).Sized(14), p.Muted, Brushes.Transparent, p.Surface2, p.Work, 28, 28, 0, 6, 12);
            button.Width = 28; button.ToolTip = tip; return button;
        }
        void Post(Action action) { Dispatcher.BeginInvoke(DispatcherPriority.Normal, action); }

        void OnConnected() {
            if (connectedOnce || ended) return;
            connectedOnce = true; linkOk = true; session.Start(); tick.Start(); pause.Start(); Render();
        }
        void OnLink(bool up) { if (ended || linkOk == up) return; linkOk = up; Render(); }
        void OnBusy(bool now) {
            if (ended) return;
            busy = now;
            if (now) {
                hold.Stop();
                if (!workShown) { workShown = true; workClock.Reset(); workClock.Start(); }
            } else if (workShown) {
                long left = 1000 - workClock.ElapsedMilliseconds;
                if (left <= 0) workShown = false;
                else { hold.Interval = TimeSpan.FromMilliseconds(left); hold.Start(); }
            }
            Render();
        }

        void AskToEnd() {
            if (ended) return;
            tucked = false; confirming = true; Render();
            UpdateLayout(); Activate(); keep.Focus();
        }
        void ShowEnded() {
            if (ended) return;
            ended = true; endedAfter = session.Elapsed; session.Stop(); tick.Stop(); pause.Stop(); hold.Stop(); paused = false;
            confirming = false; tucked = false; workShown = false; busy = false;
            Render(); closer.Start();
        }
        void OnClosing(object sender, System.ComponentModel.CancelEventArgs e) {
            // User close (End session, Alt+F4, taskbar Close) asks inline first.
            // Windows shutdown and an already ended session close without asking.
            if (!ended && !sessionEnding) { e.Cancel = true; AskToEnd(); return; }
            if (preparing && !ended && sessionEnding) { Preserve = true; client.EndRemote = false; }
            client.Stop();
        }

        void UpdateTimer() {
            string time = Ui.Clock(session.Elapsed);
            if (timerRun != null) timerRun.Text = time;
            tuckTimer.Text = connectedOnce ? time : "";
        }
        void SetSweeping(bool on) {
            if (on == sweeping) return;
            sweeping = on;
            if (on) {
                sweep.Visibility = Visibility.Visible;
                var move = new DoubleAnimation(-CardWidth * 0.45, CardWidth, new Duration(TimeSpan.FromSeconds(1.15))) { RepeatBehavior = RepeatBehavior.Forever };
                sweepMove.BeginAnimation(TranslateTransform.XProperty, move);
            } else {
                sweepMove.BeginAnimation(TranslateTransform.XProperty, null);
                sweep.Visibility = Visibility.Collapsed;
            }
        }

        void Render() {
            bool live = connectedOnce && linkOk && !ended;
            bool working = live && workShown;
            bool animate = working && SystemParameters.ClientAreaAnimation;
            Brush tileBack = !live ? p.Surface2 : working ? p.WorkSoft : p.LiveSoft;
            Brush tileFore = !live ? p.Muted : working ? p.Work : p.Live;
            tile.Background = tileBack; tuckTile.Background = tileBack;
            tileGlyph.Paint(tileFore); tuckGlyph.Paint(tileFore);
            edge.Background = !live ? p.Line : working ? (animate ? p.WorkSoft : p.Work) : p.Live;
            SetSweeping(animate);

            head.Text = ended ? "Support is disconnected." : !connectedOnce ? "Connecting to support..." : !linkOk ? "Reconnecting to support..." : "A remote support agent is connected to your machine.";
            status.Inlines.Clear(); timerRun = null;
            if (ended) {
                status.Inlines.Add(new Run("Session ended after " + Ui.Clock(endedAfter) + ". Support can no longer reach this PC."));
            } else if (!connectedOnce) {
                status.Inlines.Add(new Run("This window stays open while support is connected."));
            } else if (paused && linkOk) {
                status.Inlines.Add(new Run("Paused while you use the PC") { FontWeight = FontWeights.SemiBold, Foreground = p.Ink });
            } else if (working) {
                status.Inlines.Add(new Run("Support is working on your PC") { FontWeight = FontWeights.SemiBold, Foreground = p.Ink });
            } else {
                status.Inlines.Add(new Run(linkOk ? "Connected for " : "Trying again. Session time "));
                timerRun = new Run(Ui.Clock(session.Elapsed)) { Foreground = p.Ink, FontFamily = new FontFamily(Ui.MonoFont), FontSize = 12 };
                status.Inlines.Add(timerRun);
            }
            DateTime expires = client.ExpiresLocal;
            until.Text = connectedOnce && expires != DateTime.MinValue ? "Ends by itself " + expires.ToString("ddd d MMM, HH:mm", System.Globalization.CultureInfo.InvariantCulture) : "";
            tuckTitle.Text = working ? "Support is working" : "Remote support";
            tuckTimer.Text = connectedOnce ? Ui.Clock(session.Elapsed) : "";

            // Once the session has ended these lines would be stale.
            if (adminLine != null) adminLine.Visibility = ended ? Visibility.Collapsed : Visibility.Visible;
            if (noteLine != null) noteLine.Visibility = ended ? Visibility.Collapsed : Visibility.Visible;

            bool small = tucked && !ended;
            card.Width = small ? Double.NaN : CardWidth;
            fullView.Visibility = small ? Visibility.Collapsed : Visibility.Visible;
            tuckView.Visibility = small ? Visibility.Visible : Visibility.Collapsed;
            collapse.Visibility = ended ? Visibility.Hidden : Visibility.Visible;
            normalFoot.Visibility = !ended && !confirming ? Visibility.Visible : Visibility.Collapsed;
            askBox.Visibility = askFoot.Visibility = !ended && confirming ? Visibility.Visible : Visibility.Collapsed;
        }
    }

    // Consent prompt in the same visual language. "Don't allow" is the default.
    public sealed class ConsentDialog : Window {
        bool allowed;
        public static bool Ask(string message, bool administrator) {
            var dialog = new ConsentDialog(Palette.Detect(), message, administrator);
            dialog.ShowDialog();
            return dialog.allowed;
        }
        ConsentDialog(Palette p, string message, bool administrator) {
            const double CardWidth = 440, Pad = 20;
            Ui.Transparent(this);
            Width = CardWidth + 2 * Pad; SizeToContent = SizeToContent.Height; WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Foreground = p.Ink;
            Grid inner; var card = Ui.Card(p, CardWidth, out inner);
            var root = new Grid { Margin = new Thickness(Pad) }; root.Children.Add(card); Content = root;
            var stack = new StackPanel(); inner.Children.Add(stack);
            Brush accent = administrator ? p.Stop : p.Work;
            stack.Children.Add(new Border { Height = 3, Background = administrator ? p.Stop : p.Work });

            var header = new Grid { Height = 36, Margin = new Thickness(14, 0, 6, 0), Background = Brushes.Transparent };
            var title = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            var screen = Glyph.Screen().Paint(p.Muted).Sized(16); screen.Margin = new Thickness(0, 0, 8, 0);
            title.Children.Add(screen);
            var titleText = Ui.Label("Remote support", 12, FontWeights.SemiBold, p.Muted, Ui.TextFont); titleText.VerticalAlignment = VerticalAlignment.Center;
            title.Children.Add(titleText);
            header.Children.Add(title); Ui.Drag(this, header);
            stack.Children.Add(header);

            var body = new Grid { Margin = new Thickness(16, 2, 16, 16) };
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(40) });
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var glyph = administrator ? Glyph.Warning() : Glyph.Headset();
            glyph.Paint(administrator ? p.Stop : p.Work);
            body.Children.Add(new Border { Width = 40, Height = 40, CornerRadius = new CornerRadius(10), VerticalAlignment = VerticalAlignment.Top,
                Background = administrator ? p.StopBg : p.WorkSoft, Child = glyph.Sized(20) });
            var text = new StackPanel { Margin = new Thickness(12, 0, 0, 0) }; Grid.SetColumn(text, 1);
            var heading = Ui.Label("Allow remote support?", 15.5, FontWeights.SemiBold, administrator ? p.Stop : p.Ink, Ui.DisplayFont); heading.LineHeight = 21; heading.Margin = new Thickness(0, 0, 0, 6);
            var copy = Ui.Label(message, 12.5, FontWeights.Normal, p.Ink, Ui.TextFont); copy.LineHeight = 18;
            text.Children.Add(heading); text.Children.Add(copy);
            body.Children.Add(text);
            stack.Children.Add(body);

            var foot = new Border { BorderBrush = p.Line, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(8, 10, 12, 12) };
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            var deny = new FlatButton("Don't allow", p.Ink, p.Surface2, p.Line, p.Work, 32, 96, 14, 6, 13);
            var allow = administrator
                ? new FlatButton("Allow", p.Stop, p.StopBg, p.StopBgHover, p.Work, 32, 80, 14, 6, 13)
                : new FlatButton("Allow", p.Live, p.LiveSoft, p.LiveSoftHover, p.Work, 32, 80, 14, 6, 13);
            allow.Margin = new Thickness(8, 0, 0, 0);
            deny.IsDefault = true;
            buttons.Children.Add(deny); buttons.Children.Add(allow);
            foot.Child = buttons; stack.Children.Add(foot);

            deny.Click += delegate { allowed = false; Close(); };
            allow.Click += delegate { allowed = true; Close(); };
            PreviewKeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Escape) { e.Handled = true; allowed = false; Close(); } };
            Loaded += delegate { Activate(); deny.Focus(); Keyboard.Focus(deny); };
        }
    }

    public static class Program {
        [STAThread] public static void Main(string[] args) {
            WF.Application.EnableVisualStyles();
            try {
                var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                bool administrator = SupportAccess.IsAdministrator();
                string executable = System.Reflection.Assembly.GetExecutingAssembly().Location;
                var config = Wire.ReadConfig(executable);
                bool requestedResume = args.Length == 1 && (args[0] == "--prepare-restart" || args[0] == "--resume");
                bool resume = requestedResume && RestartResume.Valid(config, executable);
                if (requestedResume && !resume) {
                    if (RestartResume.Scoped(config, executable)) RestartResume.Cleanup(config);
                    WF.MessageBox.Show("This restart support session has expired or is invalid.", "Remote support"); return;
                }
                bool preparing = resume && args[0] == "--prepare-restart";
                if (resume) { config["startup_expires_at"] = Wire.Number(config, "resume_expires_at"); config.Remove("startup_ms"); }
                bool first; using (var mutex = new Mutex(true, "Local\\SupportMcp" + (resume ? "Resume-" : "-") + Wire.Text(config, "sid"), out first)) {
                    if (!first) { WF.MessageBox.Show("This support session is already open.", "Remote support"); return; }
                    // Resume is pre-consented through the existing support
                    // session and restricted to its private path and deadline.
                    bool approvedAdministratorResume = resume && !preparing && administrator && RestartResume.HasAdministratorConsent(config);
                    if (!approvedAdministratorResume && !SupportAccess.Confirm(administrator, resume && !preparing, delegate(string message) {
                        if (preparing) message += "\n\nAlso allow ONE automatic reconnect at the next Windows sign-in with these same rights, without another prompt? It keeps this session's original expiry. End session cancels it.";
                        return ConsentDialog.Ask(message, administrator) ? WF.DialogResult.Yes : WF.DialogResult.No;
                    })) return;
                    if (preparing) RestartResume.Arm(config, administrator);
                    else if (resume) RestartResume.Disarm(config); // one restart only
                    SupportWindow window = null;
                    try {
                        using (var client = new Client(config)) {
                            string note = preparing ? "One automatic reconnect is enabled at the next sign-in. End session cancels it."
                                : resume ? "Reconnected after restart. No further automatic reconnect is installed." : null;
                            window = new SupportWindow(client, Palette.Detect(), administrator, preparing, note);
                            var win = window;
                            client.Finished += delegate { if (resume && !win.Preserve) RestartResume.Disarm(config); };
                            var thread = new Thread(client.Run); thread.IsBackground = true;
                            bool started = false;
                            win.Loaded += delegate { if (!started) { started = true; thread.Start(); } };
                            win.Closed += delegate { app.Shutdown(); };
                            app.Run(win);
                            client.Stop();
                            if (started) thread.Join(20000);
                        }
                    } finally { if (resume && !(window != null && window.Preserve)) RestartResume.Cleanup(config); }
                }
            } catch (Exception e) { WF.MessageBox.Show(e.Message, "Remote support"); }
        }
    }
}
