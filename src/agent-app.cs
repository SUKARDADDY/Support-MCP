// .NET Framework 4 client for Windows 7 to 11. One exe with several roles, chosen by the first argument:
// none (the customer's app), --elevate-install, --service, --helper and --window (full control, see FullInstall),
// and for a saved PC the setup wizard, --device-install, --device-service, --tray, --uninstall, --device-remove,
// --device-update, --device-update-rollback and --device-ask (DeviceSetup to DeviceUninstall).
// Normal mode runs screen control (capture, input, UI Automation) in the user's own process; full control runs
// it in a SYSTEM helper on the user's console session, so it reaches the secure desktop too.
// The compiler names a helper class with a random GUID for a constant primitive
// array initializer of three or more elements and for a string switch with more than
// six cases, and that breaks the reproducible build. Use loops, if-else and
// non-constant arrays instead (docs/development.md).
// The customer window is WPF (part of .NET Framework 4); WinForms is used only
// for MessageBox and the DialogResult type of SupportAccess.Confirm.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Interop;
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

// The release version. scripts/bump-version.mjs rewrites these lines and Wire.Version; test/version.test.js checks them.
// Fully qualified, so no System.Reflection using brings new type names into scope.
[assembly: System.Reflection.AssemblyTitle("Support-MCP")]
[assembly: System.Reflection.AssemblyProduct("Support-MCP")]
[assembly: System.Reflection.AssemblyVersion("0.8.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.8.0.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("0.8.0")]

namespace SupportMcp {
    public static class SupportAccess {
        public static bool IsAdministrator() {
            using (var identity = WindowsIdentity.GetCurrent())
                return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        public static string ConsentMessage(bool administrator) { return ConsentMessage(administrator, true); }
        // screen = false is a reconnect whose earlier approval did not cover screen control: the prompt must say what will happen.
        public static string ConsentMessage(bool administrator, bool screen) {
            string what = screen ? "see your screen, control your mouse and keyboard, run commands and read or change files" : "run commands and read or change files";
            string rights = administrator
                ? "This client is running as Administrator. Allow remote support to " + what + " with administrator rights?\n\nSupport can change system settings and files for all users."
                : "Allow remote support to " + what + " as your signed-in user?";
            if (!screen) rights += "\n\nScreen, mouse and keyboard control stay off for this reconnect.";
            return rights + "\n\nA small window stays in the corner of your screen while support is connected. Access ends when you close it, click End session, or after 24 hours. Nothing reconnects after reboot unless separately prepared.";
        }
        public static bool Confirm(bool administrator, bool resume, Func<string, WF.DialogResult> prompt) { return Confirm(administrator, resume, true, prompt); }
        public static bool Confirm(bool administrator, bool resume, bool screen, Func<string, WF.DialogResult> prompt) {
            // A prepared reconnect never grants administrator access silently.
            return (resume && !administrator) || prompt(ConsentMessage(administrator, screen)) == WF.DialogResult.Yes;
        }
        // Full control is the default. UAC's own prompt is the consent; these texts are for when no prompt will
        // appear (FullHeading) and for the fallback when elevation was declined or failed (LimitedHeading).
        public const string Asking = "Windows will ask for permission to give support full control.";
        public const string FullHeading = "Give support full control of this PC?";
        public const string FullText = "Support can see your screen, control your mouse and keyboard, work through Windows security prompts and the sign-in screen, and keep working after a restart. Access ends when you click End session, or after 24 hours, and everything is removed.";
        public const string LimitedHeading = "Continue with limited support?";
        public const string LimitedText = "Support can see your screen and control your mouse and keyboard, but not Windows security prompts.";
        public const string LimitedAdmin = " This app was started as Administrator, so commands run with administrator rights.";
        public const string NoAdminNote = "Running without administrator access.";
    }

    // How full control gets its consent. Prompt: UAC will ask (Yes/No for an administrator, a password for a
    // standard user). Confirm: elevation will happen without a prompt, so the app asks itself, because consent must
    // always be a click. Unavailable: this account cannot elevate (UAC is off and it is not an administrator).
    public enum Consent { Prompt, Confirm, Unavailable }
    public static class ConsentPath {
        // elevated: the process already has a full administrator token. elevationType: TokenElevationType (1 default,
        // 2 full, 3 limited, the filtered token of an administrator). enableLua and consentAdmin: the UAC policy values, -1 when absent.
        public static Consent Decide(bool elevated, int elevationType, int enableLua, int consentAdmin) {
            if (elevated) return Consent.Confirm;
            if (enableLua == 0) return Consent.Unavailable;
            if (elevationType == 3 && consentAdmin == 0) return Consent.Confirm;
            return Consent.Prompt;
        }
        public static Consent Detect() {
            int lua = -1, admin = -1;
            using (var hklm = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64))
            using (var key = hklm.OpenSubKey(SasShare.PolicyKey)) {
                if (key != null) { object v = key.GetValue("EnableLUA"); if (v is int) lua = (int)v; v = key.GetValue("ConsentPromptBehaviorAdmin"); if (v is int) admin = (int)v; }
            }
            using (var identity = WindowsIdentity.GetCurrent()) return Decide(SupportAccess.IsAdministrator(), Native.ElevationType(identity.Token), lua, admin);
        }
    }

    public static class Wire {
        public const string Footer = "SUPPORTMCPCFG1";
        // The release version, sent in the hello. The hello's "agent" field stays the protocol generation.
        public const string Version = "0.8.0";
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
        // Text from the relay for a window or the tray: control characters dropped, trimmed, at most max characters.
        public static string Clean(string text, int max) {
            var b = new StringBuilder();
            foreach (char c in text ?? "") if (!char.IsControl(c)) b.Append(c);
            string t = b.ToString().Trim();
            return t.Length > max ? t.Substring(0, max) : t;
        }
        public static Dictionary<string, object> ReadConfig(string file) { return ReadConfig(File.ReadAllBytes(file)); }
        // A session footer only. A footer with a "kind" (the setup download from /install) is refused, so no session
        // role (--service, --helper, --elevate-install, the default and resume paths) can ever run on one.
        public static Dictionary<string, object> ReadConfig(byte[] all) {
            var cfg = Parse(all);
            if (cfg.ContainsKey("kind")) throw new InvalidDataException("Invalid session configuration.");
            if (!System.Text.RegularExpressions.Regex.IsMatch(Text(cfg, "sid"), "^[0-9a-f]{64}$") ||
                !System.Text.RegularExpressions.Regex.IsMatch(Text(cfg, "key"), "^[0-9a-f]{64}$")) throw new InvalidDataException("Invalid session credentials.");
            CheckOrigin(cfg);
            return cfg;
        }
        // The footer's kind: "" for a session, "device" for a setup download. Throws when there is no valid footer.
        public static string Kind(byte[] all) { return Text(Parse(all), "kind"); }
        // A setup footer: {"kind":"device","origin":...} with at most one of a technician's pairing code (ABCDE-FGH23)
        // or a team's workspace slug, and nothing else. It carries no session and no key.
        public const string CodePattern = @"^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}\z", SlugPattern = @"^[a-z0-9-]{1,40}\z";
        public static Dictionary<string, object> ReadDevice(byte[] all) {
            var cfg = Parse(all);
            foreach (string name in cfg.Keys)
                if (name != "kind" && name != "origin" && name != "code" && name != "workspace") throw new InvalidDataException("Invalid setup configuration.");
            if (!"device".Equals(Value(cfg, "kind"))) throw new InvalidDataException("Invalid setup configuration.");
            bool code = cfg.ContainsKey("code"), workspace = cfg.ContainsKey("workspace");
            if ((code && workspace) || (code && !(Value(cfg, "code") is string && System.Text.RegularExpressions.Regex.IsMatch((string)cfg["code"], CodePattern)))
                || (workspace && !(Value(cfg, "workspace") is string && System.Text.RegularExpressions.Regex.IsMatch((string)cfg["workspace"], SlugPattern))))
                throw new InvalidDataException("Invalid setup configuration.");
            CheckOrigin(cfg);
            return cfg;
        }
        static object Value(Dictionary<string, object> d, string key) { object v; return d.TryGetValue(key, out v) ? v : null; }
        // The footer's JSON object, after the magic string and the size check.
        static Dictionary<string, object> Parse(byte[] all) {
            int start = Payload(all), n = all.Length - Footer.Length - 4 - start;
            for (int i = 0; i < Footer.Length; i++) if (all[all.Length - Footer.Length + i] != (byte)Footer[i]) throw new InvalidDataException("Invalid session configuration.");
            Dictionary<string, object> cfg;
            try { cfg = Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(all, start, n)); }
            catch (Exception) { throw new InvalidDataException("Invalid session configuration."); }
            if (cfg == null) throw new InvalidDataException("Invalid session configuration.");
            return cfg;
        }
        // https, or http on loopback, with no path, user, query or fragment.
        static void CheckOrigin(Dictionary<string, object> cfg) {
            Uri origin;
            if (!(Value(cfg, "origin") is string) || !Uri.TryCreate((string)cfg["origin"], UriKind.Absolute, out origin)
                || (origin.Scheme != "https" && !(origin.Scheme == "http" && origin.IsLoopback))
                || origin.AbsolutePath != "/" || origin.UserInfo != "" || origin.Query != "" || origin.Fragment != "")
                throw new InvalidDataException("Invalid support server.");
        }
        // The length of the exe without its appended session configuration. The corner window's copy is cut there,
        // so the file a signed-in user can read carries no attach key.
        public static int Payload(byte[] all) {
            int tail = Footer.Length + 4;
            if (all.Length < tail) throw new InvalidDataException("Missing session configuration.");
            int n = BitConverter.ToInt32(all, all.Length - tail);
            if (n < 1 || n > 4096 || n > all.Length - tail) throw new InvalidDataException("Invalid session configuration size.");
            return all.Length - tail - n;
        }
    }

    // The child starts suspended. Assign it to a kill-on-close Job before any
    // customer command can run. Refuse execution if Windows cannot contain it.
    public sealed class CommandJob : IDisposable {
        IntPtr job, process;
        readonly MemoryStream stdout = new MemoryStream(), stderr = new MemoryStream();
        Thread outReader, errReader;
        public bool OutClipped, ErrClipped;
        [StructLayout(LayoutKind.Sequential)] internal struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct Startup {
            public int Size; public string Reserved, Desktop, Title;
            public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct ProcessInfo { public IntPtr Process, Thread; public int Id, ThreadId; }
        [StructLayout(LayoutKind.Sequential)] internal struct BasicLimits {
            public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking;
            public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] internal struct ExtendedLimits {
            public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref ExtendedLimits limits, int size);
        [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated; }
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int c, out Accounting info, int size, IntPtr returned);
        public const int SettleMs = 1000;
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateProcess(IntPtr p, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr t);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr p, uint timeout);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security s, int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref Security s, uint create, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string exe, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool CreateProcessAsUser(IntPtr token, string exe, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
        [DllImport("userenv.dll", SetLastError = true)] internal static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
        [DllImport("userenv.dll")] internal static extern bool DestroyEnvironmentBlock(IntPtr env);
        // A Job that kills every process in it when its last handle closes, with no breakaway.
        internal static IntPtr KillOnClose() {
            IntPtr j = CreateJobObject(IntPtr.Zero, null); Check(j != IntPtr.Zero);
            var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
            if (!SetInformationJobObject(j, 9, ref limits, Marshal.SizeOf(limits))) { int e = Marshal.GetLastWin32Error(); CloseHandle(j); throw new Win32Exception(e); }
            return j;
        }
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
        public Dictionary<string, object> Run(string scriptPath, string cwd, int timeoutSeconds, WaitHandle stop) { return Run(scriptPath, cwd, timeoutSeconds, stop, IntPtr.Zero); }
        // token: a primary token to run as (full control: the signed-in user, in their session), or zero for this process's own.
        public Dictionary<string, object> Run(string scriptPath, string cwd, int timeoutSeconds, WaitHandle stop, IntPtr token) {
            IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero, input = IntPtr.Zero, env = IntPtr.Zero;
            ProcessInfo pi = new ProcessInfo();
            try {
                job = KillOnClose(); // KILL_ON_JOB_CLOSE, no breakaway
                var security = new Security { Size = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
                Check(CreatePipe(out outRead, out outWrite, ref security, 0));
                Check(CreatePipe(out errRead, out errWrite, ref security, 0));
                Check(SetHandleInformation(outRead, 1, 0)); Check(SetHandleInformation(errRead, 1, 0));
                input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero); Check(input != new IntPtr(-1));
                var si = new Startup { Size = Marshal.SizeOf(typeof(Startup)), Flags = 0x101, Input = input, Output = outWrite, Error = errWrite };
                string exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
                string args = "\"" + exe + "\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -File \"" + scriptPath + "\"";
                if (token == IntPtr.Zero) Check(CreateProcess(exe, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref si, out pi));
                else {
                    Check(CreateEnvironmentBlock(out env, token, false)); si.Desktop = @"winsta0\default";
                    Check(CreateProcessAsUser(token, exe, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, true, 0x08000404, env, cwd, ref si, out pi));
                }
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
                // PowerShell does not wait for a GUI program it starts, such as rundll32.exe user32.dll,LockWorkStation. Give what
                // is left in the Job up to SettleMs to finish by itself, so it is not stopped before it did its work.
                Accounting info; var settle = Stopwatch.StartNew();
                while (!timedOut && settle.ElapsedMilliseconds < SettleMs && QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) && info.Active > 0 && !stop.WaitOne(20)) { }
                Close(ref job); // then stop the descendants that are still running
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
                if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
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
        // The relay accepts display numbers 0 to 15, so a result may report at most 16 displays.
        public const int MaxDisplays = 16;
        public static void CapDisplays(List<Gdi.Rectangle> list) { if (list.Count > MaxDisplays) list.RemoveRange(MaxDisplays, list.Count - MaxDisplays); }
        // The display that holds a point, or the nearest one when the point is on none of them. -1 for an empty list.
        public static int MonitorAt(IList<Gdi.Rectangle> list, int x, int y) {
            int best = -1; long bestDistance = long.MaxValue;
            for (int i = 0; i < list.Count; i++) {
                var r = list[i];
                long dx = x < r.Left ? r.Left - x : x >= r.Right ? x - r.Right + 1 : 0, dy = y < r.Top ? r.Top - y : y >= r.Bottom ? y - r.Bottom + 1 : 0;
                long d = dx * dx + dy * dy;
                if (d < bestDistance) { bestDistance = d; best = i; }
            }
            return best;
        }
    }

    // GetLastInputInfo covers the customer's input and the app's own. This tells the two apart by the tick of the
    // app's last injected input, so the pause still works when Windows has dropped a hook. The tick has the
    // resolution of the system clock (about 15.6 ms), so on its own it can miss a key pressed in the same tick as the
    // app's last event; Screen also watches the keys and buttons that are held down.
    public static class InputIdle {
        // SendInput updates the last-input time before it returns (300 of 300 on Windows 11), so no slack is needed on
        // that system. A little stays in case an older Windows updates it a moment later; it is far below the 20 ms gap.
        public const int SlackMs = 10;
        // Milliseconds since the customer last used the mouse or keyboard, or -1 when the last input was the app's own.
        public static long CustomerAgoMs(uint lastInputTick, uint nowTick, uint lastInjectedTick, bool injected) {
            if (injected && unchecked((int)(lastInputTick - lastInjectedTick)) <= SlackMs) return -1;
            // Unsigned: a PC idle for more than 24.8 days still reads as idle. A time a moment ahead of now (the clock
            // was read just before the input) reads as "just now".
            uint ago = unchecked(nowTick - lastInputTick);
            return ago > uint.MaxValue - 1000 ? 0 : ago;
        }
        // A key that has read down for this long while no input reached Windows is stuck, not held by the customer.
        public const long StuckMs = 10000;
        public static bool Stuck(long downForMs, bool inputSince) { return !inputSince && downForMs >= StuckMs; }
        // Milliseconds left of the pause window for that age, 0 when there is none.
        public static long RemainingMs(long agoMs) { return agoMs < 0 ? 0 : Math.Max(0, PauseClock.WindowMs - agoMs); }
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
        // Windows ignores an injected Win+L, and the L would be typed into the focused window.
        public const string LockHint = "Windows ignores an injected Win+L. To lock the PC, use run with as: \"user\" and the command rundll32.exe user32.dll,LockWorkStation";
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
                if (mods.Contains(0x5B) && mods.Contains(0x4C)) throw new ArgumentException(LockHint);
                combos.Add(mods.ToArray());
            }
            if (combos.Count == 0) throw new ArgumentException("No keys given.");
            return combos;
        }
    }

    public static class UiLines {
        // [12] Button "OK" (640,412): the ref, the control type, the name and the center in screenshot pixels.
        // The verbs ui_act can use on an element, from the UI Automation patterns it supports: invoke (InvokePattern), set_value
        // (ValuePattern, not read-only), toggle, expand and collapse (ExpandCollapsePattern, unless the element is a leaf), select
        // (SelectionItemPattern), and focus when the element can take the keyboard focus. A disabled element has none and is
        // marked "disabled" instead, because every verb on it would fail. Empty when none.
        public static string Verbs(bool invoke, bool value, bool readOnly, bool toggle, bool expand, bool select, bool focus, bool enabled = true, bool leaf = false) {
            if (!enabled) return "disabled";
            var list = new List<string>();
            if (invoke) list.Add("invoke");
            if (value && !readOnly) list.Add("set_value");
            if (toggle) list.Add("toggle");
            if (expand && !leaf) { list.Add("expand"); list.Add("collapse"); }
            if (select) list.Add("select");
            if (focus) list.Add("focus");
            return string.Join(",", list.ToArray());
        }
        public static string Line(int n, string type, string name, int x, int y, string verbs = "") {
            if (type.StartsWith("ControlType.")) type = type.Substring(12);
            var clean = new StringBuilder();
            foreach (char c in name) clean.Append(char.IsControl(c) ? ' ' : c == '"' ? '\'' : c);
            string text = clean.ToString().Trim(); if (text.Length > 80) text = text.Substring(0, 77) + "...";
            return "[" + n + "] " + type + (text.Length > 0 ? " \"" + text + "\"" : "") + " (" + x + "," + y + ")" + (verbs.Length > 0 ? " " + verbs : "");
        }
        // The relay takes at most 200,000 characters of result text. Stop at MaxChars and say that more exists.
        public const int MaxChars = 190000;
        public const string MoreByCount = "[more elements not shown; raise max_lines]", MoreByChars = "[more elements not shown; the text limit was reached]";
        public static string Join(IList<string> lines, bool moreByCount, int maxChars, out int kept) {
            var text = new StringBuilder(); kept = 0; bool cut = false;
            foreach (string line in lines) {
                if (text.Length + line.Length + 1 > maxChars - MoreByChars.Length - 1) { cut = true; break; }
                if (kept > 0) text.Append('\n');
                text.Append(line); kept++;
            }
            if (cut || moreByCount) { if (kept > 0) text.Append('\n'); text.Append(cut ? MoreByChars : MoreByCount); }
            return text.ToString();
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

    // After the customer answers "End the session?" with Keep connected, the focus goes back to the window that had it
    // before the confirm took it, so support is not left with the support window in front.
    static class FocusReturn {
        // The window to hand the focus back to, or zero for none. Only while the support window still holds the
        // focus (the customer has not clicked elsewhere meanwhile), and never to one of our own windows or one
        // that is gone, hidden, minimized, on another desktop or no longer the same window.
        public static IntPtr Target(IntPtr remembered, IntPtr foreground, Func<IntPtr, bool> ours, Func<IntPtr, bool> usable) {
            if (remembered == IntPtr.Zero || foreground == IntPtr.Zero || ours(remembered) || !ours(foreground)) return IntPtr.Zero;
            return usable(remembered) ? remembered : IntPtr.Zero;
        }
        // True when the handle is still the same visible, not minimized top-level window of this thread's current desktop:
        // the same process and thread own it as when it was remembered, so a reused handle is not mistaken for it.
        public static bool Usable(IntPtr window, uint pid, uint thread) {
            if (!Win.IsWindowVisible(window) || Win.IsIconic(window)) return false;
            uint now; uint nowThread = Win.GetWindowThreadProcessId(window, out now);
            if (now != pid || nowThread != thread) return false;
            bool found = false;
            Win.EnumDesktopWindows(Win.GetThreadDesktop(Win.GetCurrentThreadId()), delegate(IntPtr w, IntPtr data) { if (w == window) { found = true; return false; } return true; }, IntPtr.Zero);
            return found;
        }
        public static bool Ours(IntPtr window) { uint pid; Win.GetWindowThreadProcessId(window, out pid); return pid == Win.GetCurrentProcessId(); }
    }

    sealed class ScreenError : Exception { public ScreenError(string message) : base(message) { } }

    static class Win {
        public const uint NoActivate = 0x08000000, AppWindow = 0x00040000;
        public delegate bool WindowProc(IntPtr window, IntPtr data);
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
        [StructLayout(LayoutKind.Sequential)] public struct LastInput { public uint Size, Time; }
        [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LastInput info);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rc rect);
        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
        [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint ms);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out Gdi.Point p);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Gdi.Point p);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr window, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] public static extern int SetWindowLong(IntPtr window, int index, int value);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr desktop, WindowProc proc, IntPtr data);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern int GetMessage(out Msg m, IntPtr window, uint min, uint max);
        [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint thread, uint message, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr desktop);
        [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
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
        IntPtr desktop; // full control: the desktop the hooks watch (closed on Dispose), or zero for the thread's own
        public InputWatch() {
            mouse = delegate(int code, IntPtr w, IntPtr l) { if (code >= 0 && (Marshal.ReadInt32(l, 12) & 3) == 0) Clock.Touch(PauseClock.Now()); return Win.CallNextHookEx(IntPtr.Zero, code, w, l); };
            keys = delegate(int code, IntPtr w, IntPtr l) { if (code >= 0 && (Marshal.ReadInt32(l, 8) & 0x12) == 0) Clock.Touch(PauseClock.Now()); return Win.CallNextHookEx(IntPtr.Zero, code, w, l); };
        }
        public void Start() { Start(IntPtr.Zero); }
        // Low-level hooks see only the input of the desktop of their thread, so full control re-arms them on each desktop.
        public void Start(IntPtr desktop) {
            this.desktop = desktop;
            thread = new Thread(Loop); thread.IsBackground = true; thread.Start(); ready.WaitOne(5000);
        }
        void Loop() {
            threadId = Win.GetCurrentThreadId();
            if (desktop != IntPtr.Zero && !Win.SetThreadDesktop(desktop)) { ready.Set(); return; }
            IntPtr module = Win.GetModuleHandle(null), m = Win.SetWindowsHookEx(14, mouse, module, 0), k = Win.SetWindowsHookEx(13, keys, module, 0);
            Ok = m != IntPtr.Zero && k != IntPtr.Zero; ready.Set();
            Win.Msg msg; while (Ok && Win.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
            if (m != IntPtr.Zero) Win.UnhookWindowsHookEx(m);
            if (k != IntPtr.Zero) Win.UnhookWindowsHookEx(k);
        }
        public void Dispose() {
            Ok = false; if (thread == null) return;
            Win.PostThreadMessage(threadId, 0x12, IntPtr.Zero, IntPtr.Zero);
            if (thread.Join(3000) && desktop != IntPtr.Zero) Win.CloseDesktop(desktop);
        }
    }

    // Capture, input and UI Automation for one screen operation at a time, all in the user's own process.
    public sealed class Screen : IDisposable {
        public const string PauseText = "customer is using the PC; try again in a few seconds";
        public const string NoFull = "this needs full control";
        // The only error text type_secret ever returns. Nothing about the secret or the target can leak through it.
        public const string SecretFailed = "type_secret failed";
        // Least time between two typed characters. Windows 11 Notepad reads the character of a Unicode key event late,
        // so a character injected before it has read the previous one replaces it (see TypeText). 20 ms is twice the
        // slowest gap that still went wrong in the measurements, and it holds the relay's 35 ms per character budget.
        public const int TypeGapMs = 20;
        internal volatile InputWatch Watch = new InputWatch();
        // Full control: this process is the SYSTEM helper on the console session. It may work on the secure desktop,
        // its own windows are the corner window's processes (OwnPids), Blocked is true while block_input holds the
        // customer's input (then the pause does not apply), and Step runs between the steps of an input.
        public static volatile bool Full;
        internal static volatile int[] OwnPids = new int[0];
        public Func<bool> Blocked;
        public Action Step;
        string watchDesktop;
        readonly object rearmGate = new object();
        volatile List<AutomationElement> refs = new List<AutomationElement>();
        volatile int treeDisplay; // the display the last ui_tree read; ui_act's screenshot comes from it
        static int injectedTick; static volatile bool injectedAny; // the app's own last injected input, for GetLastInputInfo
        public void Start() { Watch.Start(); if (!Watch.Ok) ProveFallback(); }
        // Full control, on a thread that is on the input desktop: move the hooks to that desktop when it changed.
        internal void Rearm() {
            lock (rearmGate) {
                string name = InputName();
                if (name == null || (name == watchDesktop && Watch.Ok)) return;
                IntPtr d = Win.OpenInputDesktop(0, false, 0x10000000);
                if (d == IntPtr.Zero) return;
                var fresh = new InputWatch(); fresh.Start(d);
                var old = Watch; Watch = fresh; watchDesktop = name; old.Dispose();
                if (!fresh.Ok) ProveFallback();
            }
        }
        public void Dispose() { Watch.Dispose(); }
        public bool Paused { get { return PausedForMs > 0; } }
        // The pause comes from three sources. The low-level hooks see only physical input, but Windows removes a hook
        // that times out, without telling the app. So there are two that cannot be dropped. GetLastInputInfo also
        // counts the app's own input, so it is compared with the tick of the app's last injection (Send records it
        // from the same call), and a later input counts. That tick is only as fine as the system clock, so a key
        // pressed in the same tick as the app's last event shows only in the third source: a key or mouse button that
        // is down right now. The app's own key events go down and up inside one SendInput call, so between its calls
        // nothing of its own is down.
        public long PausedForMs {
            get {
                var info = new Win.LastInput { Size = (uint)Marshal.SizeOf(typeof(Win.LastInput)) };
                bool known = Win.GetLastInputInfo(ref info);
                long external = known
                    ? InputIdle.RemainingMs(InputIdle.CustomerAgoMs(info.Time, unchecked((uint)Environment.TickCount), unchecked((uint)Thread.VolatileRead(ref injectedTick)), injectedAny)) : 0;
                if (AnyInputDown(known ? info.Time : 0)) Watch.Clock.Touch(PauseClock.Now());
                return Math.Max(external, Watch.Clock.RemainingMs(PauseClock.Now()));
            }
        }
        static int holding; // above 0 while the app itself keeps a key or mouse button down (Press, Drag)
        // Keys and mouse buttons the app pressed and has not yet seen come up. A key or click that switches the desktop
        // (Escape or Cancel on the Ctrl+Alt+Del screen, Return on the sign-in screen, Yes on UAC) does its work on the
        // way down; its up is refused, or lands on the desktop that is gone, so Windows keeps it down on the new one.
        // Unstick sends those ups on the desktop shown now, and AnyInputDown never takes them for the customer's.
        static readonly List<int> ours = new List<int>();
        static readonly object pad = new object(); // one sender of downs and ups at a time: an input, or Unstick
        static bool Ours(int vk) { lock (ours) return ours.Contains(vk); }
        static void NoteDowns(Win.In[] inputs) {
            foreach (var i in inputs) {
                int vk = i.Type == 1 ? ((i.Key.Flags & 6) == 0 ? i.Key.Vk : 0) : (i.Mouse.Flags & 2) != 0 ? 1 : (i.Mouse.Flags & 8) != 0 ? 2 : (i.Mouse.Flags & 0x20) != 0 ? 4 : 0;
                if (vk != 0) lock (ours) if (!ours.Contains(vk)) ours.Add(vk);
            }
        }
        static bool OnShownDesktop() {
            string shown = InputName(), mine = DesktopName(Win.GetThreadDesktop(Win.GetCurrentThreadId()));
            return shown != null && shown == mine; // GetAsyncKeyState reads nothing on any other desktop
        }
        // On a thread on the desktop shown now: release what the app left down, and forget what is up.
        internal static void Unstick() {
            if (Thread.VolatileRead(ref holding) > 0 || !OnShownDesktop()) return;
            lock (pad) {
                int[] list; lock (ours) list = ours.ToArray();
                foreach (int vk in list) {
                    if ((Win.GetAsyncKeyState(vk) & 0x8000) != 0) {
                        var up = vk == 1 ? MouseEvent(0, 0, 0, 4) : vk == 2 ? MouseEvent(0, 0, 0, 0x10) : vk == 4 ? MouseEvent(0, 0, 0, 0x40)
                            : KeyEvent(vk, (ushort)Win.MapVirtualKey((uint)vk, 0), (KeySpec.IsExtended(vk) ? 1u : 0u) | 2u);
                        Win.SendInput(1, new Win.In[] { up }, Marshal.SizeOf(typeof(Win.In))); RecordInjection();
                    }
                    if ((Win.GetAsyncKeyState(vk) & 0x8000) == 0) lock (ours) ours.Remove(vk);
                }
            }
        }
        // Since when each key has read down, and the last-input time then. A key the customer holds repeats, so the
        // last-input time moves; one that reads down for StuckMs while it does not is stuck, and stops the pause.
        static readonly Dictionary<int, long> downSince = new Dictionary<int, long>(); static readonly Dictionary<int, uint> downTick = new Dictionary<int, uint>();
        static bool AnyInputDown(uint lastInput) {
            if (Thread.VolatileRead(ref holding) > 0) return false;
            long now = PauseClock.Now(); bool any = false;
            lock (downSince) {
                for (int vk = 1; vk < 255; vk++) {
                    if ((Win.GetAsyncKeyState(vk) & 0x8000) == 0) { downSince.Remove(vk); continue; }
                    if (Ours(vk)) continue;
                    long since; uint tick;
                    if (!downSince.TryGetValue(vk, out since) || !downTick.TryGetValue(vk, out tick) || tick != lastInput) { downSince[vk] = since = now; downTick[vk] = lastInput; }
                    if (!InputIdle.Stuck(now - since, false)) any = true;
                }
            }
            return any;
        }
        // After the app's own input: the time Windows gave it. Any input later than this is the customer's.
        static void RecordInjection() {
            int now = Environment.TickCount, stamp = now;
            var info = new Win.LastInput { Size = (uint)Marshal.SizeOf(typeof(Win.LastInput)) };
            if (Win.GetLastInputInfo(ref info) && unchecked((int)(info.Time - (uint)now)) > 0) stamp = unchecked((int)info.Time);
            Interlocked.Exchange(ref injectedTick, stamp); injectedAny = true;
        }
        // When the hooks did not install, the two other sources are the only guard. Prove first that this session's
        // last-input time follows the app's own input: send one harmless key (F24) and read the time back.
        volatile bool fallbackProven;
        internal bool ProveFallback() {
            try {
                Send(KeyEvent(0x87, 0, 0), KeyEvent(0x87, 0, 2));
                var info = new Win.LastInput { Size = (uint)Marshal.SizeOf(typeof(Win.LastInput)) };
                bool ok = Win.GetLastInputInfo(ref info) && Math.Abs(unchecked((int)(info.Time - (uint)Environment.TickCount))) <= 100;
                fallbackProven = ok; return ok;
            } catch (ScreenError) { return false; }
        }

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
            ScreenMath.CapDisplays(others); // the relay rejects a result that reports more displays than it can number
            return others;
        }
        // "default" for the user's desktop. The secure desktop (UAC, lock, sign-in, Ctrl+Alt+Del) is "secure" in full
        // control and "unknown" in normal mode, which cannot open it.
        internal static string Desktop() { string name = InputName(); return name == "Default" ? "default" : name == "Winlogon" ? "secure" : "unknown"; }
        internal static string InputName() {
            IntPtr d = Win.OpenInputDesktop(0, false, 1);
            if (d == IntPtr.Zero) d = Win.OpenInputDesktop(0, false, 0); // no access asked: the name is all that is read
            if (d == IntPtr.Zero) return null;
            try { return DesktopName(d); } finally { Win.CloseDesktop(d); }
        }
        internal static string DesktopName(IntPtr d) { var name = new StringBuilder(64); int needed; return Win.GetUserObjectInformation(d, 2, name, 128, out needed) ? name.ToString() : null; }

        sealed class View {
            public Gdi.Rectangle Phys; public int Index, Count, W, H;
            public int PhysX(int x) { return Phys.X + ScreenMath.ToPhysical(x, W, Phys.Width); }
            public int PhysY(int y) { return Phys.Y + ScreenMath.ToPhysical(y, H, Phys.Height); }
            public void Check(int x, int y) { if (x < 0 || y < 0 || x >= W || y >= H) throw new ScreenError("coordinate " + x + "," + y + " is outside the " + W + "x" + H + " screenshot"); }
        }
        static View GetView(int i) {
            var list = Monitors();
            if (i < 0 || i >= list.Count) throw new ScreenError("no display " + i + "; this PC has " + list.Count);
            var v = new View { Phys = list[i], Index = i, Count = list.Count }; ScreenMath.Fit(v.Phys.Width, v.Phys.Height, out v.W, out v.H); return v;
        }
        static View GetView(Dictionary<string, object> a) { return GetView((int)Wire.Number(a, "display")); }
        // The display of the last ui_tree, or the primary one when displays changed since: the ref may still be good.
        static View GetViewOrPrimary(int i) { return GetView(i >= 0 && i < Monitors().Count ? i : 0); }
        // ui_tree reads the foreground window, so it uses the display that holds the center of that window.
        static View ForegroundView() {
            IntPtr fg = Win.GetForegroundWindow();
            if (fg == IntPtr.Zero) throw new ScreenError("no window is in the foreground");
            Win.Rc rc; int index = 0;
            if (Win.GetWindowRect(fg, out rc)) index = Math.Max(0, ScreenMath.MonitorAt(Monitors(), (rc.L + rc.R) / 2, (rc.T + rc.B) / 2));
            return GetView(index);
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

        static bool Owns(IntPtr window) { uint pid; Win.GetWindowThreadProcessId(window, out pid); return OwnsPid((int)pid); }
        static bool OwnsPid(int pid) { return pid == (int)Win.GetCurrentProcessId() || Array.IndexOf(OwnPids, pid) >= 0; }
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
            var blocked = Blocked; if (blocked != null && blocked()) return; // the customer's input is blocked, so it cannot pause support
            if (!Watch.Ok && !fallbackProven) throw new ScreenError("cannot watch for customer input");
            if (Paused) throw new ScreenError(PauseText);
        }
        // Between the steps of a longer input: stop when support access has ended, and give way to the customer.
        void Between(WaitHandle stop) {
            if (stop.WaitOne(0)) throw new ScreenError("support access ended");
            var step = Step; if (step != null) step();
            Free();
        }
        // Waits ms, or throws when support access ends first.
        static void Wait(WaitHandle stop, int ms) { if (stop.WaitOne(ms)) throw new ScreenError("support access ended"); }
        // Keystrokes go to the foreground window: refuse the support window and an elevated window. The check
        // is repeated for every step of a multi-step input, because the focus can change between steps.
        static void KeyTarget(ref IntPtr seen) {
            IntPtr fg = Win.GetForegroundWindow();
            if (fg == seen) return;
            if (fg != IntPtr.Zero && Owns(fg)) throw new ScreenError("the support window has the keyboard focus; click another window first");
            NotElevated(fg);
            seen = fg;
        }
        internal static void Send(params Win.In[] inputs) {
            NoteDowns(inputs);
            uint sent = Win.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Win.In)));
            RecordInjection();
            if (sent != inputs.Length) throw new ScreenError("Windows refused the input");
        }
        static Win.In MouseEvent(int dx, int dy, int data, uint flags) {
            var i = new Win.In { Type = 0 }; i.Mouse = new Win.MouseIn { Dx = dx, Dy = dy, Data = unchecked((uint)data), Flags = flags }; return i;
        }
        internal static Win.In KeyEvent(int vk, ushort scan, uint flags) {
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
            Interlocked.Increment(ref holding);
            try {
                lock (pad) {
                string before = Full ? InputName() : null;
                Send(down.ToArray()); Thread.Sleep(30);
                // Full control: a key that switches the desktop (Return on the sign-in screen) has done its work, and Windows
                // refuses its key-up on the desktop that is gone. That is not a failure.
                try { Send(up.ToArray()); } catch (ScreenError) { if (!Full || InputName() == before) throw; }
                }
            } finally { Interlocked.Decrement(ref holding); }
        }
        // One real key press, down and up in a single call.
        static void Tap(int vk) {
            ushort scan = (ushort)Win.MapVirtualKey((uint)vk, 0); uint ext = KeySpec.IsExtended(vk) ? 1u : 0u;
            lock (pad) Send(KeyEvent(vk, scan, ext), KeyEvent(vk, scan, ext | 2u));
        }
        // Unicode key events type any character the target accepts, whatever the keyboard layout. Newline and tab are
        // real Return and Tab keys. A character above U+FFFF goes as its two surrogate halves, one event pair each.
        //
        // Pacing matters. Windows 11 Notepad does not take the character from each Unicode key event. It reads it
        // when it gets to the event, and by then a faster sender has already replaced it: "abc def 123" became
        // "abc 3333333". One call with every event gave the same result, so the fix is time between characters.
        // The old code slept 2 ms, which is 2 ms only while something (a browser, a WPF animation like this app's
        // own window) has raised the system timer to 1 ms; otherwise Windows rounds it up to 15.6 ms and the bug hid.
        // So this raises the timer itself and waits TypeGapMs between characters. Typing 5000 characters takes
        // about 100 s.
        internal void TypeText(string text, WaitHandle stop, bool secret) {
            int sent = 0, total = 0; IntPtr seen = IntPtr.Zero; var gap = new Stopwatch(); bool afterHigh = false;
            foreach (char c in text) if (c != '\r') total++;
            Win.timeBeginPeriod(1);
            try {
                foreach (char c in text) {
                    if (c == '\r') continue;
                    // The two halves of a surrogate pair go out as one character: nothing is checked between them.
                    bool secondHalf = afterHigh && char.IsLowSurrogate(c);
                    try {
                        // Wait out the gap, watching the customer and the stop flag all the time, then check once more
                        // right before the event. A check before the gap would be 20 ms old by the time it is sent.
                        // Thread.Sleep(1), not WaitOne(1): with the timer at 1 ms the sleep takes about 2 ms, but a 1 ms wait on a handle still takes about 15 ms.
                        while (gap.IsRunning && gap.ElapsedMilliseconds < TypeGapMs) { if (!secondHalf) Between(stop); Thread.Sleep(1); }
                        if (!secondHalf) { Between(stop); KeyTarget(ref seen); }
                        if (c == '\n') Tap(0x0D); else if (c == '\t') Tap(0x09);
                        else Send(KeyEvent(0, c, 4), KeyEvent(0, c, 6));
                    } catch (ScreenError e) {
                        // A secret's error carries no count, and the relay drops its text anyway.
                        if (secret || sent == 0) throw;
                        throw new ScreenError(e.Message + " (typed " + sent + " of " + total + " characters)");
                    }
                    gap.Reset(); gap.Start(); sent++; afterHigh = char.IsHighSurrogate(c);
                }
            } finally { Win.timeEndPeriod(1); }
        }
        // Refuse a target in this process's own windows (the corner window, dialogs) or in an elevated window.
        static void Target(int px, int py) {
            IntPtr hit = Win.WindowFromPoint(new Gdi.Point(px, py)), root = hit == IntPtr.Zero ? IntPtr.Zero : Win.GetAncestor(hit, 2);
            if (root != IntPtr.Zero && Owns(root)) throw new ScreenError("that spot is the support window; use another spot");
            NotElevated(root);
        }
        void Click(View v, int x, int y, string button, int count, WaitHandle stop) {
            v.Check(x, y); int px = v.PhysX(x), py = v.PhysY(y);
            Target(px, py); MoveTo(px, py);
            uint down = button == "right" ? 8u : button == "middle" ? 0x20u : 2u;
            for (int i = 0; i < count; i++) { if (i > 0) Between(stop); lock (pad) Send(MouseEvent(0, 0, 0, down), MouseEvent(0, 0, 0, down * 2)); Wait(stop, 40); }
        }
        // The button is released even when the drag stops early, so a pause never leaves it held down.
        void Drag(View v, int x1, int y1, int x2, int y2, WaitHandle stop) {
            v.Check(x1, y1); v.Check(x2, y2); int ax = v.PhysX(x1), ay = v.PhysY(y1), bx = v.PhysX(x2), by = v.PhysY(y2);
            Target(ax, ay); Target(bx, by);
            MoveTo(ax, ay); Wait(stop, 50);
            Interlocked.Increment(ref holding);
            lock (pad) try {
                Send(MouseEvent(0, 0, 0, 2));
                for (int i = 1; i <= 10; i++) { Wait(stop, 20); Between(stop); MoveTo(ax + (bx - ax) * i / 10, ay + (by - ay) * i / 10); }
                Wait(stop, 50);
            } finally { try { Send(MouseEvent(0, 0, 0, 4)); } finally { Interlocked.Decrement(ref holding); } }
        }

        // Input actions: refuse during a customer pause, in the support window and in elevated windows.
        void Input(string name, Dictionary<string, object> a, View v, WaitHandle stop) {
            Free();
            IntPtr seen = IntPtr.Zero;
            if (name == "type" || name == "type_secret" || name == "key") KeyTarget(ref seen);
            // type_secret shares the typing code; the name is mapped so the switch stays small (see the note at the top).
            switch (name == "type_secret" ? "type" : name) {
                case "move": v.Check((int)Wire.Number(a, "x"), (int)Wire.Number(a, "y")); MoveTo(v.PhysX((int)Wire.Number(a, "x")), v.PhysY((int)Wire.Number(a, "y"))); break;
                case "click": {
                    string button = Wire.Text(a, "button") == "" ? "left" : Wire.Text(a, "button");
                    if (button != "left" && button != "right" && button != "middle") throw new ScreenError("button must be left, right or middle");
                    Click(v, (int)Wire.Number(a, "x"), (int)Wire.Number(a, "y"), button, (int)Math.Max(1, Math.Min(3, a.ContainsKey("count") ? Wire.Number(a, "count") : 1)), stop); break;
                }
                case "drag": Drag(v, (int)Wire.Number(a, "x1"), (int)Wire.Number(a, "y1"), (int)Wire.Number(a, "x2"), (int)Wire.Number(a, "y2"), stop); break;
                case "scroll": {
                    string dir = Wire.Text(a, "direction") == "" ? "down" : Wire.Text(a, "direction");
                    int amount = (int)Math.Max(1, Math.Min(50, a.ContainsKey("amount") ? Wire.Number(a, "amount") : 3));
                    if (dir != "up" && dir != "down" && dir != "left" && dir != "right") throw new ScreenError("direction must be up, down, left or right");
                    if (a.ContainsKey("x")) Click(v, (int)Wire.Number(a, "x"), (int)Wire.Number(a, "y"), "none", 0, stop);
                    Send(MouseEvent(0, 0, 120 * amount * (dir == "up" || dir == "right" ? 1 : -1), dir == "up" || dir == "down" ? 0x800u : 0x1000u)); break;
                }
                case "type": {
                    string text = Wire.Text(a, "text");
                    if (text.Length > 5000) throw new ScreenError("text is longer than 5000 characters");
                    TypeText(text, stop, name == "type_secret"); break;
                }
                default:
                    foreach (int[] combo in KeySpec.Parse(Wire.Text(a, "keys"))) { Between(stop); KeyTarget(ref seen); Press(combo); Wait(stop, 20); }
                    break;
            }
        }

        // UI Automation of the foreground window. Refs are numbers in the lines and live until the next ui_tree.
        // The verbs of an element, read from the cache the walk already asked for (one round trip per element, not one per pattern).
        static string VerbsOf(AutomationElement e) {
            bool value = Cached(e, AutomationElement.IsValuePatternAvailableProperty), readOnly = false;
            if (value) { object o = e.GetCachedPropertyValue(ValuePattern.IsReadOnlyProperty); readOnly = !(o is bool) || (bool)o; } // unknown counts as read-only
            bool expand = Cached(e, AutomationElement.IsExpandCollapsePatternAvailableProperty), leaf = false;
            if (expand) { object o = e.GetCachedPropertyValue(ExpandCollapsePattern.ExpandCollapseStateProperty); leaf = o is ExpandCollapseState && (ExpandCollapseState)o == ExpandCollapseState.LeafNode; }
            object enabled = e.GetCachedPropertyValue(AutomationElement.IsEnabledProperty); // unknown counts as enabled
            return UiLines.Verbs(Cached(e, AutomationElement.IsInvokePatternAvailableProperty), value, readOnly, Cached(e, AutomationElement.IsTogglePatternAvailableProperty),
                expand, Cached(e, AutomationElement.IsSelectionItemPatternAvailableProperty), e.Cached.IsKeyboardFocusable, !(enabled is bool) || (bool)enabled, leaf);
        }
        static bool Cached(AutomationElement e, AutomationProperty p) { object o = e.GetCachedPropertyValue(p); return o is bool && (bool)o; }
        string Tree(View v, int max) {
            IntPtr fg = Win.GetForegroundWindow();
            if (fg == IntPtr.Zero) throw new ScreenError("no window is in the foreground");
            if (Owns(fg)) throw new ScreenError("the foreground window is the support window");
            var cache = new CacheRequest { TreeScope = TreeScope.Element };
            foreach (var p in new AutomationProperty[] { AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.BoundingRectangleProperty, AutomationElement.IsOffscreenProperty, AutomationElement.IsKeyboardFocusableProperty, AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty, AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty, AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsEnabledProperty }) cache.Add(p);
            cache.Add(ValuePattern.IsReadOnlyProperty); cache.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
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
                                list.Add(e); lines.Add(UiLines.Line(list.Count, c.ControlType.ProgrammaticName, c.Name, ScreenMath.ToImage(cx, v.W, v.Phys.Width), ScreenMath.ToImage(cy, v.H, v.Phys.Height), VerbsOf(e)));
                            }
                        }
                        if (depth < 40) for (var child = walker.GetFirstChild(e, cache); child != null; child = walker.GetNextSibling(child, cache)) walk(child, depth + 1);
                    } catch (ElementNotAvailableException) { } catch (InvalidOperationException) { } catch (COMException) { } // one bad element must not end the tree
                };
                walk(AutomationElement.FromHandle(fg), 0);
            }
            int kept; string text = UiLines.Join(lines, more, UiLines.MaxChars, out kept);
            if (kept < list.Count) list.RemoveRange(kept, list.Count - kept); // a ref the text does not show is not offered
            refs = list; treeDisplay = v.Index;
            return text;
        }
        static bool Limited(Action action, int ms) {
            // The new thread works on this thread's desktop, which in full control may be the secure one.
            Exception error = null; IntPtr desktop = Win.GetThreadDesktop(Win.GetCurrentThreadId());
            var t = new Thread(delegate() { try { Win.SetThreadDesktop(desktop); action(); } catch (Exception e) { error = e; } }); t.IsBackground = true; t.Start();
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
                if (OwnsPid(e.Current.ProcessId)) throw new ScreenError("that element belongs to the support window");
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
        // Full control: runs a capture on a fresh thread on the desktop shown now (the helper sets it), for the screenshot
        // after an input that switched the desktop. null in normal mode.
        public static Func<Func<Dictionary<string, object>>, Dictionary<string, object>> OnShown;
        public const int SettleMs = 2000;
        // The screenshot after an input. The input has happened whatever this finds: the capture follows a desktop switch
        // and is retried for SettleMs, and if it still fails the result says so in text and stays ok.
        static void Settle(Dictionary<string, object> r, View v, string before, WaitHandle stop) {
            var clock = Stopwatch.StartNew(); string reason = "the screen could not be captured";
            while (true) {
                try {
                    var onShown = OnShown;
                    Merge(r, onShown == null || InputName() == before ? Shot(v.Phys) : onShown(delegate { Dpi(); return Shot(v.Phys); }));
                    return;
                } catch (Exception e) { reason = e.Message; }
                if (clock.ElapsedMilliseconds >= SettleMs || stop.WaitOne(250)) break;
            }
            object note; r["text"] = (r.TryGetValue("text", out note) ? note + "\n" : "") + "input sent; no screenshot: " + reason;
        }
        public Dictionary<string, object> Run(Dictionary<string, object> frame, WaitHandle stop) {
            string desktop = "unknown"; bool secret = false;
            try {
                Dpi(); desktop = Desktop(); Unstick(); string startName = InputName();
                var a = frame.ContainsKey("action") ? frame["action"] as Dictionary<string, object> : null;
                if (Wire.Text(frame, "type") == "control" || a == null) throw new ScreenError(Wire.Text(frame, "type") == "control" ? NoFull : "missing screen action");
                string name = Wire.Text(a, "name");
                secret = name == "type_secret";
                if (name == "block_input" || name == "send_sas" || name == "request_full_control") throw new ScreenError(NoFull);
                if (Array.IndexOf(new string[] { "screenshot", "zoom", "wait", "ui_tree", "ui_act", "click", "move", "drag", "scroll", "type", "type_secret", "key" }, name) < 0) throw new ScreenError("unknown screen action");
                var r = Wire.Map("ok", true);
                if (name == "wait") stop.WaitOne((int)(Seconds(a) * 1000));
                else if (desktop != "default" && !(Full && desktop == "secure")) throw new ScreenError(Full ? "cannot reach the screen right now" : "cannot reach the screen; Windows may be locked or showing a security prompt");
                // ui_tree reads the display of the foreground window and ui_act answers with the display of its ui_tree, so refs and pixels agree.
                View v = name == "wait" && !Wire.Flag(a, "screenshot") ? null : name == "ui_tree" ? ForegroundView() : name == "ui_act" ? GetViewOrPrimary(treeDisplay) : GetView(a);
                bool input = name == "click" || name == "move" || name == "drag" || name == "scroll" || name == "type" || name == "type_secret" || name == "key" || name == "ui_act";
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
                else if (name != "wait") Input(name, a, v, stop);
                if (input && (!a.ContainsKey("screenshot") || Wire.Flag(a, "screenshot"))) { Wait(stop, 300); Settle(r, v, startName, stop); }
                if (v != null) { r["display"] = v.Index; r["displays"] = v.Count; }
                r["desktop"] = input ? Desktop() : desktop; // after the input: it may have switched the desktop
                Unstick();
                return r;
            } catch (Exception e) {
                // Nothing of a secret, and no detail about where it went, can come back in an error.
                if (secret) return Wire.Map("ok", false, "error", SecretFailed);
                return Wire.Map("ok", false, "error", e is ScreenError || e is ArgumentException ? e.Message : e.GetType().Name + ": " + e.Message);
            }
        }
    }

    // What the window shows: the normal-mode Client, or the full-control service seen through its pipe (ServiceLink).
    public interface ISupportLink {
        event Action Connected; event Action<bool> LinkChanged; event Action<int> BusyChanged; event Action Finished;
        bool Paused { get; }
        bool Blocked { get; }
        DateTime ExpiresLocal { get; }
        // True when access goes on after the customer signs out or restarts, so closing the window then must not end it.
        bool SurvivesSignOut { get; }
        // True when the link finished because the session's service could not be reached, not because the session ended.
        bool Lost { get; }
        // A saved PC's session: who drives it now (an email or a service id, from the relay), "" otherwise.
        string Driver { get; }
        // A saved PC's session: the PC's access setting ("ask" or "any"), "" for a one-off link.
        string Access { get; }
        void Stop();
    }

    // The service's side of the Client in full control: screen frames go to the SYSTEM helper, commands may run as
    // the signed-in user or as SYSTEM, and the first welcome moves the service's own deadline. Limited: a saved PC set
    // to limited support (DeviceService), hosted by its SYSTEM service but acting only as the signed-in user: the
    // helper runs with the user's own token, commands run as the user and never as SYSTEM, files are opened while
    // impersonating the user, and the hello says control "normal".
    public interface IFullControl {
        bool Limited { get; }
        string UserName { get; }
        Dictionary<string, object> ScreenOp(Dictionary<string, object> frame, WaitHandle stop);
        // A primary token of the console user, elevated when they are an administrator, and their profile folder.
        // Throws ArgumentException with TokenChoice.NobodySignedIn when nobody is signed in.
        IntPtr UserToken(out string profile);
        void Report(Dictionary<string, object> poll, long serverOffsetMs);
        void Welcomed(long expiresAtMs);
    }

    public sealed class Client : IDisposable, ISupportLink {
        readonly Dictionary<string, object> config;
        readonly ManualResetEvent stop = new ManualResetEvent(false);
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly object gate = new object();
        readonly System.Threading.Timer deadlineTimer;
        // Raised when a lane finishes, so a parked poll ends and the result goes out at once.
        readonly AutoResetEvent signal = new AutoResetEvent(false);
        HttpWebRequest request;
        bool polling, woke;
        // The status code of the last 4xx answer the relay gave to a request, 0 if the last request had none.
        int rejected;
        long deadlineMs, generation, expiresAtMs, serverOffsetMs;
        int busy;
        string work;
        volatile Screen screen;
        // False when this run was resumed after a restart whose consent did not cover screen control. The app then
        // reports no screen cap and refuses any screen frame, so only commands and files work (see RestartResume).
        public volatile bool ScreenAllowed = true;
        // Full control (the service) when set. In normal mode CanElevate adds the "full" cap, and RequestFull runs
        // request_full_control; it returns null when the service took over, and then this client sends nothing more.
        public IFullControl Full;
        public bool CanElevate;
        public Func<Dictionary<string, object>> RequestFull;
        public string WorkRoot; // where the temporary command folder goes; the user's Temp folder when null
        // A saved PC's session: the device key, sent as "Authorization: Bearer" on every /agent request instead of the
        // X-Attach-Key header. EndReason: added to the end this client sends ("owner" when the person at the PC ended).
        public string Bearer;
        public volatile string EndReason;
        volatile string driver = "";
        // Who drives a saved PC's session, from the welcome and each poll answer (relay-v1-spec "driver").
        public string Driver { get { return driver; } }
        public string Access { get { return ""; } }
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
        public Client(Dictionary<string, object> cfg) : this(cfg, 7200000) { }
        // maxStartMs: the longest wait for the first connection. The service passes its own deadline, up to 24 hours.
        public Client(Dictionary<string, object> cfg, long maxStartMs) {
            config = cfg;
            // The relay sends the first-connect budget as milliseconds left when the
            // file was downloaded, so a PC clock that is wrong cannot end the client
            // at once. The absolute startup_expires_at is only a fallback for a
            // config without it. The relay enforces the same limit on its own clock.
            long remaining = cfg.ContainsKey("startup_ms") ? Wire.Number(cfg, "startup_ms") : Wire.Number(cfg, "startup_expires_at") - UnixNow();
            deadlineMs = Math.Max(0, Math.Min(maxStartMs, remaining));
            deadlineTimer = new System.Threading.Timer(delegate(object state) { if (clock.ElapsedMilliseconds >= Interlocked.Read(ref deadlineMs)) Stop(); }, null, 100, 100);
        }
        public DateTime ExpiresLocal {
            get {
                long ms = Interlocked.Read(ref expiresAtMs);
                return ms == 0 ? DateTime.MinValue : new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms).ToLocalTime();
            }
        }
        // The session's end on this PC's clock, Unix ms, 0 before the first welcome.
        public long ExpiresAtMs { get { return Interlocked.Read(ref expiresAtMs); } }
        public int BusyCount { get { return Thread.VolatileRead(ref busy); } }
        // True for 3 s after the customer last used the mouse or keyboard.
        public bool Paused { get { var s = screen; return s != null && s.Paused; } }
        public bool Blocked { get { return false; } }
        public bool SurvivesSignOut { get { return false; } }
        public bool Lost { get { return false; } }
        // One operation at a time per lane. Screen operations run while a command runs.
        sealed class Lane {
            public readonly string Name; public readonly ManualResetEvent Done = new ManualResetEvent(false);
            public Thread Op; public Dictionary<string, object> OpResult, Result; public string ActiveId = "", LastId = "";
            public bool Rejected; // the relay refused this lane's result, which was replaced by a plain error
            public Lane(string name) { Name = name; }
            public bool Busy { get { return ActiveId != ""; } }
        }
        static string LaneOf(string type) { return type == "run" || type == "put_file" || type == "get_file" ? "cmd" : type == "screen" || type == "control" ? "screen" : null; }
        public long ServerOffsetMs { get { return Interlocked.Read(ref serverOffsetMs); } }
        // Ends a parked poll, so the next poll carries a fresh report (the full-control service uses it after a change).
        public void Nudge() { Wake(); }
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
        void NoteDriver(Dictionary<string, object> answer) { string d = Wire.Clean(Wire.Text(answer, "driver"), 200); if (d.Length > 0) driver = d; }
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
        // Stop was called, or the run ended (the relay ended the session, or it expired).
        public bool Stopped { get { return stop.WaitOne(0); } }
        // A poll that Wake ended early returns null.
        Dictionary<string, object> Send(Dictionary<string, object> body, bool ending, bool poll) {
            if (!ending && stop.WaitOne(0)) throw new OperationCanceledException();
            var req = (HttpWebRequest)WebRequest.Create(Wire.Text(config, "origin") + "/agent?sid=" + Wire.Text(config, "sid"));
            req.Method = "POST"; req.ContentType = "application/json"; req.AllowAutoRedirect = false;
            rejected = 0;
            req.Timeout = ending ? 3000 : 30000; req.ReadWriteTimeout = req.Timeout;
            if (Bearer != null) req.Headers["Authorization"] = "Bearer " + Bearer;
            else req.Headers["X-Attach-Key"] = Wire.Text(config, "key");
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
                    if (code >= 400 && code < 500) rejected = code;
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
                if (type == "screen" || type == "control") {
                    if (Full != null) return Full.ScreenOp(frame, stop);
                    if (type == "control") { var request = RequestFull; return request == null ? Wire.Map("ok", false, "error", Screen.NoFull) : request(); }
                    var s = screen;
                    if (!ScreenAllowed || s == null) return Wire.Map("ok", false, "error", "the customer has not approved screen control for this session");
                    return s.Run(frame, stop);
                }
                if (type == "run") {
                    // Normal mode: every command runs as the signed-in user. Full control: as the console user (elevated
                    // when an administrator, in their session) or, with as: "system", as the service itself.
                    // Limited support (a saved PC): as the signed-in user only, like normal mode.
                    string runAs = Wire.Text(frame, "as"); bool userOnly = Full == null || Full.Limited;
                    if (userOnly && runAs == "system") return Wire.Map("ok", false, "error", "as: \"system\" needs full control");
                    if (runAs != "" && runAs != "user" && runAs != "system") return Wire.Map("ok", false, "error", userOnly ? "as must be user" : "as must be user or system");
                    string file = Path.Combine(work, "command-" + Guid.NewGuid().ToString("N") + ".ps1"), cwd = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                    string prefix = "$ProgressPreference = 'SilentlyContinue'\r\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\r\n";
                    IntPtr token = IntPtr.Zero;
                    try {
                        if (Full != null && runAs != "system") token = Full.UserToken(out cwd);
                        File.WriteAllText(file, prefix + Wire.Text(frame, "command"), new UTF8Encoding(true));
                        // The work folder is SYSTEM's own. The user the command runs as may read this one script, not change it.
                        if (token != IntPtr.Zero) using (var identity = new WindowsIdentity(token)) File.SetAccessControl(file, FullAcl.Script(identity.User));
                        using (var job = new CommandJob()) return job.Run(file, cwd, (int)Math.Max(1, Math.Min(600, Wire.Number(frame, "timeout_s"))), stop, token);
                    } finally { if (token != IntPtr.Zero) Win.CloseHandle(token); try { File.Delete(file); } catch (Exception) { } }
                }
                string path = AbsolutePath(Wire.Text(frame, "path"));
                if (type == "put_file") {
                    string encoded = Wire.Text(frame, "data_b64");
                    if (encoded.Length > 700000) throw new ArgumentException("File chunk too large.");
                    byte[] data = Convert.FromBase64String(encoded);
                    // Same as the PowerShell agent: create missing parent directories (path is already validated). Full control
                    // writes as SYSTEM, so it refuses links and junctions on the way (Native.OpenPlain). Limited support
                    // writes while impersonating the signed-in user, so Windows checks the user's own rights.
                    if (Full != null && Full.Limited) return AsUser(delegate {
                        string up = Path.GetDirectoryName(path);
                        if (!String.IsNullOrEmpty(up)) Directory.CreateDirectory(up);
                        using (var s = new FileStream(path, Wire.Flag(frame, "append") ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.Read)) s.Write(data, 0, data.Length);
                        return Wire.Map("ok", true, "bytes", data.Length);
                    });
                    if (Full != null) { using (var s = Native.OpenPlain(path, true, Wire.Flag(frame, "append"))) s.Write(data, 0, data.Length); return Wire.Map("ok", true, "bytes", data.Length); }
                    string parent = Path.GetDirectoryName(path);
                    if (!String.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                    using (var s = new FileStream(path, Wire.Flag(frame, "append") ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.Read)) s.Write(data, 0, data.Length);
                    return Wire.Map("ok", true, "bytes", data.Length);
                }
                if (type != "get_file") throw new ArgumentException("Unknown operation.");
                long offset = Math.Max(0, Wire.Number(frame, "offset"));
                int length = (int)Math.Max(1, Math.Min(524288, Wire.Number(frame, "length")));
                // FileShare.ReadWrite, like the PowerShell agent, so a log another process is writing can be read.
                Func<Dictionary<string, object>> read = delegate {
                    using (var s = Full != null && !Full.Limited ? Native.OpenPlain(path, false, false) : new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
                        s.Position = offset; byte[] data = new byte[length]; int total = 0, n;
                        while (total < length && (n = s.Read(data, total, length - total)) > 0) total += n;
                        return Wire.Map("ok", true, "data_b64", Convert.ToBase64String(data, 0, total), "size", s.Length, "eof", s.Position >= s.Length);
                    }
                };
                return Full != null && Full.Limited ? AsUser(read) : read();
            } catch (Exception e) { return Wire.Map("ok", false, "error", e.Message); }
        }
        // Limited support: runs f while this thread impersonates the signed-in user (Full.UserToken), so a file is
        // opened with that user's rights and never with the service's.
        Dictionary<string, object> AsUser(Func<Dictionary<string, object>> f) {
            string profile; IntPtr token = Full.UserToken(out profile);
            try {
                using (var identity = new WindowsIdentity(token))
                using (identity.Impersonate()) return f();
            } finally { Win.CloseHandle(token); }
        }
        // The largest request body the relay takes. A result over it, or one the relay answers with a 4xx
        // (400 invalid result, 413 too large), would be refused every time it is resent, and the client would
        // never poll again. So it is replaced once by a plain error result and the lane carries on.
        const int ResultMax = 750000;
        void RejectResult(Lane lane) {
            lane.Rejected = true;
            lane.Result = Wire.Map("type", "result", "id", lane.ActiveId, "generation", generation, "ok", false, "error", "result rejected by relay");
        }
        // Returns the relay's answer type: "ack" or "end".
        string SendResult(Lane lane) {
            while (true) {
                string json = null;
                try { json = Wire.Json().Serialize(lane.Result); } catch (InvalidOperationException) { }
                if (json == null || Encoding.UTF8.GetByteCount(json) > ResultMax) {
                    if (lane.Rejected) return "ack"; // even the plain error does not fit: drop it
                    RejectResult(lane); continue;
                }
                try { return Wire.Text(Send(lane.Result, false, false), "type"); }
                catch (WebException) {
                    // Only 400 (invalid result) and 413 (too large) say the result itself is bad. Anything else, 408 or 429
                    // for example, is a failure of the moment and takes the normal retry path.
                    if (rejected != 400 && rejected != 413) throw;
                    // The relay refused the plain error too. It always validates, so this is not expected. Drop it and
                    // carry on: the operator's call then ends with the relay's own timeout instead of hanging for ever.
                    if (lane.Rejected) return "ack";
                    RejectResult(lane);
                }
            }
        }
        public void Run() {
            var lanes = new Lane[] { new Lane("cmd"), new Lane("screen") }; string networkError = "";
            try {
                var security = new DirectorySecurity();
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                work = Path.Combine(WorkRoot ?? Path.GetTempPath(), "remote-support-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(work, security);
                // Without screen consent there is no Screen at all: no global input hooks and no F24 probe. Execute
                // refuses screen frames, and the poll reports no pause. Full control has no Screen here: the helper does it.
                if (Full == null && ScreenAllowed) { screen = new Screen(); screen.Start(); }
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2 on .NET 4.5.2
                while (!stop.WaitOne(0)) {
                    try {
                        if (generation == 0) {
                            // "full" in caps: this app can ask for full control (or has it); control: what it has now. A saved PC
                            // with limited support is hosted by a service (Full) but has no full control: "normal".
                            bool full = Full != null, system = full && !Full.Limited, canFull = system || (CanElevate && ScreenAllowed);
                            var welcome = Send(Wire.Map("type", "hello", "machine", Environment.MachineName, "user", full ? Full.UserName : Environment.UserName,
                                "ps", PowerShellVersion(), "agent", "windows-app-2", "version", Wire.Version, "elevated", system || (!full && SupportAccess.IsAdministrator()),
                                "caps", canFull ? new string[] { "screen", "uia", "lanes", "full" } : ScreenAllowed ? new string[] { "screen", "uia", "lanes" } : new string[] { "lanes" },
                                "control", system ? "full" : "normal"), false, false);
                            if (Wire.Text(welcome, "type") != "welcome") throw new InvalidDataException("Invalid support handshake.");
                            generation = Wire.Number(welcome, "generation");
                            NoteDriver(welcome);
                            long expires = Wire.Number(welcome, "expires_at"), now = Wire.Number(welcome, "server_time");
                            if (now == 0) now = UnixNow();
                            Interlocked.Exchange(ref serverOffsetMs, now - UnixNow()); // the relay reports deadlines on its own clock
                            long remainingMs = Math.Max(0, Math.Min(86400000, expires - now));
                            Interlocked.Exchange(ref deadlineMs, clock.ElapsedMilliseconds + remainingMs);
                            Interlocked.Exchange(ref expiresAtMs, UnixNow() + remainingMs);
                            if (full) Full.Welcomed(UnixNow() + remainingMs);
                            ShowStatus("Support session active. Close this window to end access.");
                            Print("Connected. Commands run as " + Environment.UserName + (SupportAccess.IsAdministrator() ? " with administrator rights." : " with normal user rights."));
                            var connected = Connected; if (connected != null) connected();
                        }
                        lock (gate) woke = false;
                        bool over = false;
                        foreach (var lane in lanes) {
                            if (lane.Op != null && lane.Done.WaitOne(0)) {
                                lane.Op.Join(); lane.Op = null; lane.Result = lane.OpResult;
                                if (lane.Result == null) { over = true; break; } // request_full_control handed the session to the service
                                lane.Result["type"] = "result"; lane.Result["id"] = lane.ActiveId; lane.Result["generation"] = generation;
                            }
                            if (lane.Result != null) {
                                string ack = SendResult(lane);
                                if (ack == "end") { over = true; break; }
                                if (ack != "ack") throw new InvalidDataException("Result not acknowledged.");
                                lane.LastId = lane.ActiveId; lane.ActiveId = ""; lane.Result = null; lane.Rejected = false; Work(-1);
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
                        if (Full != null) Full.Report(poll, serverOffsetMs);
                        else {
                            poll["desktop"] = Screen.Desktop();
                            var watching = screen; if (watching != null) poll["paused_until"] = watching.Paused ? UnixNow() + serverOffsetMs + watching.PausedForMs : (object)null;
                        }
                        var frame = Send(poll, false, true);
                        if (frame == null) continue;
                        NoteDriver(frame);
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
                if (EndRemote && generation != 0) {
                    var end = Wire.Map("type", "end", "generation", generation); string reason = EndReason; if (reason != null) end["reason"] = reason;
                    try { Send(end, true, false); } catch { }
                }
                if (work != null) { try { Directory.Delete(work, true); } catch { } }
                Print(EndRemote ? "Support access stopped." : "Windows is restarting. One-time reconnect is prepared.");
                ShowStatus("Support session ended. You can close this window.");
                if (Interlocked.Exchange(ref busy, 0) > 0) { var changed = BusyChanged; if (changed != null) changed(0); }
                var finished = Finished; if (finished != null) finished();
                // The lanes' wait handles stay open: an op thread that outlived the join above may still Set one.
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
        // Screen control, mouse and keyboard are part of what the customer approves. A reconnect runs without a
        // prompt, so it may use them only when the prepare prompt said so. Arm records that approval under its own
        // value name; a reconnect prepared by an older app, or without it, gets commands and files only.
        static string ScreenValueName(Dictionary<string, object> cfg) { return Wire.Text(cfg, "sid") + "|screen"; }
        public static bool HasScreenConsent(Dictionary<string, object> cfg) {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(ConsentKey))
                return key != null && String.Equals(key.GetValue(ScreenValueName(cfg)) as string, ConsentValue(cfg), StringComparison.Ordinal);
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
                key.SetValue(ScreenValueName(cfg), ConsentValue(cfg), Microsoft.Win32.RegistryValueKind.String);
            }
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunOnce))
                key.SetValue(ValueName(cfg), "\"" + PathFor(cfg) + "\" --resume", Microsoft.Win32.RegistryValueKind.String);
        }
        public static void Disarm(Dictionary<string, object> cfg) {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunOnce, true))
                if (key != null) key.DeleteValue(ValueName(cfg), false);
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(ConsentKey, true))
                if (key != null) { key.DeleteValue(Wire.Text(cfg, "sid"), false); key.DeleteValue(ScreenValueName(cfg), false); }
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

    // The saved PC's client for the /device/ wire (docs/relay-v1-spec.md): pair or ask to join, check in, change its
    // own settings, and leave on uninstall. Every request is POST JSON with "protocol": 1, the key (when it has one) in
    // the Authorization header and never the URL, TLS 1.2 switched on first (Windows 7 cannot reach an https relay
    // without it), 30-second timeouts, the default proxy and no redirects. A response over the cap, or one that does not
    // parse, is read as offline, so a hostile answer cannot grow the process. It runs no command and sees no screen.
    public sealed class DeviceLink {
        public enum DeviceResult { Ok, Pending, CodeInvalid, Removed, UpdateNeeded, Offline, Refused }
        // Result: the outcome below. Status: the HTTP status, 0 when the request never got an answer. Body: the parsed
        // JSON answer, or null. Message: the relay's own error message, for a Refused result.
        public sealed class Answer {
            public readonly DeviceResult Result; public readonly int Status; public readonly Dictionary<string, object> Body; public readonly string Message;
            public Answer(DeviceResult result, int status, Dictionary<string, object> body, string message) { Result = result; Status = status; Body = body; Message = message; }
            // A 2xx answer, whether the PC is active (Ok) or waiting for approval (Pending).
            public bool Ok { get { return Result == DeviceResult.Ok || Result == DeviceResult.Pending; } }
        }
        public const int Protocol = 1, ResponseCap = 65536;
        readonly string origin;
        public DeviceLink(string origin) { this.origin = origin; }
        public Answer Pair(Dictionary<string, object> body) { return Send("/device/pair", body, null); }
        public Answer Hello(string key, Dictionary<string, object> body) { return Send("/device/hello", body, key); }
        public Answer Update(string key, Dictionary<string, object> body) { return Send("/device/update", body, key); }
        public Answer Leave(string key) { return Send("/device/leave", Wire.Map(), key); }
        // The release download (DeviceUpdate): the same app the setup page serves, from POST <origin>/install with no query,
        // the header Origin: <origin> and an empty body, as the page's button sends it. The answer carries a setup footer,
        // which the caller strips (Wire.Payload) before it checks the exe against the signed note. Null for anything but a
        // 200, a body over DownloadCap, a drop, or a download that takes longer than DownloadMs in all. The same TLS,
        // proxy and no-redirect rules as the wire.
        public const int DownloadCap = 2 * 1024 * 1024;
        internal static int DownloadMs = 120000; // the whole download's deadline; the native tests shorten it
        public byte[] Download() {
            System.Threading.Timer deadline = null;
            try {
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2 on .NET 4.5.2
                var req = (HttpWebRequest)WebRequest.Create(origin + "/install");
                req.Method = "POST"; req.AllowAutoRedirect = false; req.ContentLength = 0;
                req.Timeout = 30000; req.ReadWriteTimeout = 30000;
                req.Proxy = WebRequest.DefaultWebProxy;
                req.Headers["Origin"] = origin;
                // ReadWriteTimeout limits each read; this ends a body that keeps trickling in.
                int deadlineMs = DownloadMs;
                deadline = new System.Threading.Timer(delegate { try { req.Abort(); } catch (Exception) { } }, null, deadlineMs, Timeout.Infinite);
                var clock = Stopwatch.StartNew();
                using (var response = (HttpWebResponse)req.GetResponse()) {
                    if ((int)response.StatusCode != 200 || response.ContentLength > DownloadCap) return null;
                    using (var stream = response.GetResponseStream()) {
                        var data = new MemoryStream(); byte[] buf = new byte[65536]; int n;
                        while ((n = stream.Read(buf, 0, buf.Length)) > 0) {
                            if (data.Length + n > DownloadCap || clock.ElapsedMilliseconds > deadlineMs) return null;
                            data.Write(buf, 0, n);
                        }
                        return data.ToArray();
                    }
                }
            } catch (Exception) {
                return null;
            } finally { if (deadline != null) deadline.Dispose(); }
        }
        Answer Send(string path, Dictionary<string, object> body, string key) {
            try {
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2 on .NET 4.5.2
                var req = (HttpWebRequest)WebRequest.Create(origin + path);
                req.Method = "POST"; req.ContentType = "application/json"; req.AllowAutoRedirect = false;
                req.Timeout = 30000; req.ReadWriteTimeout = 30000;
                req.Proxy = WebRequest.DefaultWebProxy;
                if (key != null) req.Headers["Authorization"] = "Bearer " + key;
                var full = new Dictionary<string, object>(body); full["protocol"] = Protocol;
                byte[] bytes = Encoding.UTF8.GetBytes(Wire.Json().Serialize(full)); req.ContentLength = bytes.Length;
                using (var stream = req.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
                using (var response = (HttpWebResponse)req.GetResponse()) return Read((int)response.StatusCode, response);
            } catch (WebException e) {
                var r = e.Response as HttpWebResponse;
                if (r == null) return new Answer(DeviceResult.Offline, 0, null, "");
                using (r) return Read((int)r.StatusCode, r);
            } catch (Exception) {
                return new Answer(DeviceResult.Offline, 0, null, "");
            }
        }
        static Answer Read(int status, HttpWebResponse response) {
            Dictionary<string, object> body = null;
            try {
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    char[] buf = new char[8192]; var data = new StringBuilder(); int n;
                    while ((n = reader.Read(buf, 0, buf.Length)) > 0) { if (data.Length + n > ResponseCap) break; data.Append(buf, 0, n); }
                    body = Wire.Json().Deserialize<Dictionary<string, object>>(data.ToString());
                }
            } catch (Exception) { }
            return Map(status, body);
        }
        // The pinned mapping. A 2xx with no readable body is unexpected, so it counts as offline and the caller retries.
        static Answer Map(int status, Dictionary<string, object> body) {
            string code = "", message = "";
            object err;
            if (body != null && body.TryGetValue("error", out err) && err is Dictionary<string, object>) {
                var e = (Dictionary<string, object>)err; code = Wire.Text(e, "code"); message = Wire.Text(e, "message");
            }
            if (status == 200 || status == 201) return body != null ? new Answer(DeviceResult.Ok, status, body, "") : new Answer(DeviceResult.Offline, 0, null, "");
            if (status == 202) return body != null ? new Answer(DeviceResult.Pending, status, body, "") : new Answer(DeviceResult.Offline, 0, null, "");
            if (status == 401) return new Answer(DeviceResult.Removed, status, body, message);
            if (status == 426) return new Answer(DeviceResult.UpdateNeeded, status, body, message);
            if (status == 404 && code == "code_invalid") return new Answer(DeviceResult.CodeInvalid, status, body, message);
            return new Answer(DeviceResult.Refused, status, body, message);
        }
    }

    // The saved PC's doorbell (relay-v1-spec "The doorbell"): one quiet WebSocket to GET <origin>/device/ring?protocol=1
    // with the device key as a Bearer header, the same origin as DeviceLink. Windows 7 has no WebSocket client, so this
    // is the smallest RFC 6455 client that does the job, over a TcpClient and an SslStream (TLS 1.2, the system's
    // certificate checks; plain TCP only for an http origin, which is loopback by the footer rules). The relay sends
    // text frames only to ring; any text frame wakes the check-in, at most once every RingGapMs, and its content is
    // never read. It also reads ping, pong and close frames; a frame over FrameMax, a fragment, a binary or masked
    // frame, or anything else closes the connection. It sends a masked protocol ping every PingMs and reconnects when
    // nothing arrived for PongMs. Reconnects wait 5 seconds, doubling to 5 minutes; a ring resets that. Each
    // (re)connect wakes the check-in too. The service reads Connected to pick its schedule.
    public sealed class Doorbell {
        public const string RingPath = "/device/ring?protocol=1";
        public const int FrameMax = 1024;
        // The tests shorten these.
        internal int PingMs = 30000, PongMs = 60000, RingGapMs = 2000, ConnectMs = 30000;
        internal long MinBackoffMs = 5000, MaxBackoffMs = 300000;
        readonly Uri origin; readonly string key; readonly Action wake;
        readonly ManualResetEvent stop = new ManualResetEvent(false);
        readonly object writeGate = new object(), ringGate = new object(), connGate = new object();
        volatile bool connected; Thread thread;
        System.Net.Sockets.TcpClient tcp; Stream stream;
        long lastHeard, lastPing, lastWake = long.MinValue / 2; bool wakeQueued;
        readonly System.Threading.Timer deferred;
        int connections;
        public Doorbell(string origin, string key, Action wake) {
            this.origin = new Uri(origin); this.key = key; this.wake = wake;
            deferred = new System.Threading.Timer(delegate { Deferred(); }, null, Timeout.Infinite, Timeout.Infinite);
        }
        public bool Connected { get { return connected; } }
        // Successful handshakes so far (tests).
        public int Connections { get { return Thread.VolatileRead(ref connections); } }
        public void Start() { if (thread != null) return; thread = new Thread(Run); thread.IsBackground = true; thread.Start(); }
        public void Stop() {
            stop.Set(); Abort();
            var t = thread; if (t != null && t != Thread.CurrentThread) t.Join(5000);
            deferred.Change(Timeout.Infinite, Timeout.Infinite);
        }
        // The wait before the next connection attempt: MinBackoffMs, doubling, at most MaxBackoffMs.
        public static long NextBackoff(long current, long min, long max) { return current <= 0 ? min : Math.Min(current * 2, max); }
        void Run() {
            long backoff = 0;
            while (!stop.WaitOne(0)) {
                bool rang = false;
                try { Session(ref rang); } catch (Exception) { }
                connected = false; Abort();
                if (rang) backoff = 0;
                backoff = NextBackoff(backoff, MinBackoffMs, MaxBackoffMs);
                if (stop.WaitOne((int)Math.Min(backoff, int.MaxValue))) break;
            }
            connected = false;
        }
        void Abort() { Abort(null); }
        // Closes the connection; with only set, only while it is still that one (a late timer of an old connection).
        void Abort(System.Net.Sockets.TcpClient only) {
            System.Net.Sockets.TcpClient c; Stream st;
            lock (connGate) { if (only != null && tcp != only) return; c = tcp; st = stream; tcp = null; stream = null; }
            if (st != null) try { st.Dispose(); } catch (Exception) { }
            if (c != null) try { c.Close(); } catch (Exception) { }
        }
        // One connection: open, upgrade, then read frames until it ends.
        void Session(ref bool rang) {
            var c = new System.Net.Sockets.TcpClient();
            lock (connGate) { if (stop.WaitOne(0)) { c.Close(); return; } tcp = c; }
            int port = origin.Port;
            var pending = c.BeginConnect(origin.DnsSafeHost, port, null, null);
            if (WaitHandle.WaitAny(new WaitHandle[] { stop, pending.AsyncWaitHandle }, ConnectMs) != 1) return;
            c.EndConnect(pending);
            c.NoDelay = true; c.ReceiveTimeout = ConnectMs; c.SendTimeout = ConnectMs;
            Stream s = c.GetStream();
            if (origin.Scheme == "https") {
                var ssl = new System.Net.Security.SslStream(s, false);
                lock (connGate) { if (tcp != c) { ssl.Dispose(); return; } stream = ssl; }
                ssl.AuthenticateAsClient(origin.DnsSafeHost, null, System.Security.Authentication.SslProtocols.Tls12, ServicePointManager.CheckCertificateRevocationList); // as the check-in: off unless the process turns it on
                s = ssl;
            } else lock (connGate) { if (tcp != c) return; stream = s; }
            Upgrade(s);
            c.ReceiveTimeout = 0; // from here the reader waits as long as it takes; the liveness timer ends a dead one
            long now = PauseClock.Now(); Interlocked.Exchange(ref lastHeard, now); Interlocked.Exchange(ref lastPing, now);
            connected = true; Interlocked.Increment(ref connections);
            Wake();
            int tick = Math.Max(10, Math.Min(1000, PingMs / 4));
            using (new System.Threading.Timer(delegate { Tick(s, c); }, null, tick, tick)) {
                while (!stop.WaitOne(0)) { if (!Frame(s, c)) break; rang |= ringSeen; ringSeen = false; }
                rang |= ringSeen; ringSeen = false;
            }
        }
        bool ringSeen;
        void Tick(Stream s, System.Net.Sockets.TcpClient c) {
            long now = PauseClock.Now();
            if (now - Interlocked.Read(ref lastHeard) >= PongMs) { Abort(c); return; } // nothing, not even a pong: dead
            if (now - Interlocked.Read(ref lastPing) >= PingMs) { Interlocked.Exchange(ref lastPing, now); Send(s, 9, new byte[0], c); }
        }
        // The client's handshake (RFC 6455 4.1): 101, Upgrade: websocket, Connection: Upgrade and the accept value.
        void Upgrade(Stream s) {
            var nonce = new byte[16]; using (var rng = new System.Security.Cryptography.RNGCryptoServiceProvider()) rng.GetBytes(nonce);
            string wsKey = Convert.ToBase64String(nonce);
            string host = origin.Host + (origin.IsDefaultPort ? "" : ":" + origin.Port.ToString(System.Globalization.CultureInfo.InvariantCulture));
            string request = "GET " + RingPath + " HTTP/1.1\r\nHost: " + host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + wsKey
                + "\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer " + key + "\r\n\r\n";
            byte[] bytes = Encoding.ASCII.GetBytes(request);
            lock (writeGate) { s.Write(bytes, 0, bytes.Length); s.Flush(); }
            var head = new StringBuilder(); var one = new byte[1];
            while (!head.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal)) {
                if (head.Length >= 8192 || s.Read(one, 0, 1) != 1) throw new IOException("no upgrade");
                head.Append((char)one[0]);
            }
            string[] lines = head.ToString().Split(new string[] { "\r\n" }, StringSplitOptions.None);
            string[] status = lines[0].Split(' ');
            if (status.Length < 2 || !status[0].StartsWith("HTTP/1.", StringComparison.Ordinal) || status[1] != "101") throw new IOException("no upgrade");
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < lines.Length; i++) { int colon = lines[i].IndexOf(':'); if (colon > 0) headers[lines[i].Substring(0, colon).Trim()] = lines[i].Substring(colon + 1).Trim(); }
            string upgrade, connection, accept;
            if (!headers.TryGetValue("Upgrade", out upgrade) || !String.Equals(upgrade, "websocket", StringComparison.OrdinalIgnoreCase)
                || !headers.TryGetValue("Connection", out connection) || connection.IndexOf("upgrade", StringComparison.OrdinalIgnoreCase) < 0
                || !headers.TryGetValue("Sec-WebSocket-Accept", out accept) || accept != AcceptFor(wsKey)) throw new IOException("bad upgrade");
        }
        public static string AcceptFor(string wsKey) {
            using (var sha = System.Security.Cryptography.SHA1.Create())
                return Convert.ToBase64String(sha.ComputeHash(Encoding.ASCII.GetBytes(wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        }
        static byte[] Read(Stream s, int n) {
            var b = new byte[n]; int got = 0;
            while (got < n) { int r = s.Read(b, got, n - got); if (r <= 0) throw new EndOfStreamException(); got += r; }
            return b;
        }
        // One frame from the relay. False: close the connection.
        bool Frame(Stream s, System.Net.Sockets.TcpClient c) {
            byte[] h = Read(s, 2);
            bool fin = (h[0] & 0x80) != 0, masked = (h[1] & 0x80) != 0; int rsv = h[0] & 0x70, op = h[0] & 0x0F; long len = h[1] & 0x7F;
            if (!fin || rsv != 0 || masked || len == 127) return false; // a fragment, an extension, a masked or a huge frame
            if (len == 126) { byte[] e = Read(s, 2); len = (e[0] << 8) | e[1]; }
            if (len > FrameMax || (op >= 8 && len > 125)) return false;
            byte[] payload = Read(s, (int)len);
            Interlocked.Exchange(ref lastHeard, PauseClock.Now());
            if (op == 1) { ringSeen = true; Wake(); return true; } // a ring: its text is never read
            if (op == 9) { Send(s, 10, payload, c); return true; }
            if (op == 10) return true;
            if (op == 8) { Send(s, 8, payload.Length >= 2 ? new byte[] { payload[0], payload[1] } : new byte[0], c); return false; }
            return false; // binary, a continuation or a reserved opcode
        }
        // A masked frame from the client (RFC 6455 5.3), at most 125 bytes: ping, pong and close only.
        void Send(Stream s, int op, byte[] payload, System.Net.Sockets.TcpClient c) {
            var frame = new byte[6 + payload.Length]; var mask = new byte[4];
            using (var rng = new System.Security.Cryptography.RNGCryptoServiceProvider()) rng.GetBytes(mask);
            frame[0] = (byte)(0x80 | op); frame[1] = (byte)(0x80 | payload.Length);
            Buffer.BlockCopy(mask, 0, frame, 2, 4);
            for (int i = 0; i < payload.Length; i++) frame[6 + i] = (byte)(payload[i] ^ mask[i % 4]);
            try { lock (writeGate) { s.Write(frame, 0, frame.Length); s.Flush(); } } catch (Exception) { Abort(c); }
        }
        // At most one wake every RingGapMs. One that comes sooner is not lost: it waits for the end of the gap.
        void Wake() {
            bool now = false;
            lock (ringGate) {
                long t = PauseClock.Now();
                if (t - lastWake >= RingGapMs) { lastWake = t; now = true; }
                else if (!wakeQueued) { wakeQueued = true; deferred.Change(Math.Max(1, lastWake + RingGapMs - t), Timeout.Infinite); }
            }
            if (now) wake();
        }
        void Deferred() {
            lock (ringGate) { if (!wakeQueued) return; wakeQueued = false; lastWake = PauseClock.Now(); }
            if (!stop.WaitOne(0)) wake();
        }
    }

    // ---- Full control -----------------------------------------------------------------------------------------
    // The customer's app elevates through UAC and runs itself with --elevate-install. That copies the exe (with its
    // session configuration) into an admin-only folder, writes the deadline, registers a backstop task and starts a
    // temporary LocalSystem service (--service). The service owns the relay connection, runs commands as the
    // signed-in user or as SYSTEM, and keeps two processes on the console session: a SYSTEM helper (--helper) that
    // runs every screen operation and so reaches the secure desktop, and the corner window as the user (--window).
    // It removes itself when the session ends or its deadline passes, and the backstop task removes it otherwise.

    static class Native {
        [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQueryUserToken(uint session, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr result);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int kind, ref uint value, int length);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int length, out int returned);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, out IntPtr value, int length, out int returned);
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserProfileDirectory(IntPtr token, StringBuilder path, ref int size);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint session);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeServerSessionId(SafePipeHandle pipe, out uint session);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances, uint outSize, uint inSize, uint timeout, ref CommandJob.Security security);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr sd, IntPtr size);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool BlockInput(bool block);
        // Frees an icon handle made by Bitmap.GetHicon (the tray's icon, drawn at run time).
        [DllImport("user32.dll", SetLastError = true)] public static extern bool DestroyIcon(IntPtr icon);
        // Lets the process that gets the call take the foreground (-1 is ASFW_ANY): a second start hands this over so the running tray's panel gets focus.
        [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
        [DllImport("sas.dll")] static extern void SendSAS(bool asUser);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetDefaultDllDirectories(uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool MoveFileEx(string from, string to, uint flags);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ShellInfo {
            public int Size; public uint Mask; public IntPtr Window; public string Verb, File, Parameters, Directory; public int Show;
            public IntPtr InstApp, IdList; public string Class; public IntPtr ClassKey; public uint HotKey; public IntPtr Icon, Process;
        }
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ShellExecuteEx(ref ShellInfo info);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint create, uint flags, IntPtr template);
        [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint Attributes, C1, C2, A1, A2, W1, W2, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out FileInfo info);

        public static int ElevationType(IntPtr token) { int v, n; return GetTokenInformation(token, 18, out v, 4, out n) ? v : 1; }
        public static bool ExitCode(IntPtr process, out uint code) { return GetExitCodeProcess(process, out code); }
        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr info, out int count);
        [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
        [StructLayout(LayoutKind.Sequential)] struct WtsSession { public uint Id; public IntPtr Station; public int State; }
        // The ids of the sessions in the WTSActive state (0): the console with a user, and Remote Desktop sessions.
        public static List<uint> ActiveSessions() {
            var list = new List<uint>(); IntPtr info; int n;
            if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out info, out n)) return list;
            try {
                int size = Marshal.SizeOf(typeof(WtsSession));
                for (int i = 0; i < n; i++) { var w = (WtsSession)Marshal.PtrToStructure(new IntPtr(info.ToInt64() + (long)i * size), typeof(WtsSession)); if (w.State == 0) list.Add(w.Id); }
            } finally { WTSFreeMemory(info); }
            return list;
        }
        // The elevated half of an administrator's split token. SYSTEM, which holds SeTcbPrivilege, gets a primary token.
        public static IntPtr Linked(IntPtr token) { IntPtr v; int n; return GetTokenInformation(token, 19, out v, IntPtr.Size, out n) ? v : IntPtr.Zero; }
        public static string Profile(IntPtr token) { var b = new StringBuilder(260); int n = b.Capacity; return GetUserProfileDirectory(token, b, ref n) ? b.ToString() : Environment.SystemDirectory; }
        // This process's SYSTEM token as a primary token for another session: the helper's token on the console.
        public static IntPtr SystemTokenFor(uint session) {
            IntPtr own, dup;
            if (!OpenProcessToken(GetCurrentProcess(), 0x02000000, out own)) throw new Win32Exception();
            try { if (!DuplicateTokenEx(own, 0x02000000, IntPtr.Zero, 2, 1, out dup)) throw new Win32Exception(); } finally { CloseHandle(own); }
            if (!SetTokenInformation(dup, 12, ref session, 4)) { int e = Marshal.GetLastWin32Error(); CloseHandle(dup); throw new Win32Exception(e); }
            return dup;
        }
        // Starts exe on winsta0\default with a token of the console session. With a job it starts suspended and joins the
        // job before it runs a single instruction. Returns the process handle; the caller closes it.
        public static CommandJob.ProcessInfo Launch(IntPtr token, string exe, string args, bool environment, IntPtr job) {
            var si = new CommandJob.Startup { Size = Marshal.SizeOf(typeof(CommandJob.Startup)), Desktop = @"winsta0\default" };
            CommandJob.ProcessInfo pi; IntPtr env = IntPtr.Zero;
            try {
                if (environment && !CommandJob.CreateEnvironmentBlock(out env, token, false)) env = IntPtr.Zero;
                uint flags = (job != IntPtr.Zero ? 4u : 0u) | (env != IntPtr.Zero ? 0x400u : 0u);
                if (!CommandJob.CreateProcessAsUser(token, exe, new StringBuilder("\"" + exe + "\" " + args), IntPtr.Zero, IntPtr.Zero, false, flags, env, Environment.SystemDirectory, ref si, out pi)) throw new Win32Exception();
            } finally { if (env != IntPtr.Zero) CommandJob.DestroyEnvironmentBlock(env); }
            if (job != IntPtr.Zero && (!CommandJob.AssignProcessToJobObject(job, pi.Process) || CommandJob.ResumeThread(pi.Thread) == uint.MaxValue)) {
                int e = Marshal.GetLastWin32Error(); CommandJob.TerminateProcess(pi.Process, 1); CloseHandle(pi.Process); CloseHandle(pi.Thread); throw new Win32Exception(e);
            }
            CloseHandle(pi.Thread);
            return pi;
        }
        // A pipe that only the accounts in sddl can open, never from the network. first: fail when the name exists, so
        // nobody can create it before us and wait for our clients.
        public static NamedPipeServerStream PipeServer(string name, string sddl, int instances, bool first) { return PipeServer(name, sddl, instances, first, false); }
        // overlapped: reads on it can time out (Pipes.Read with ms).
        public static NamedPipeServerStream PipeServer(string name, string sddl, int instances, bool first, bool overlapped) {
            IntPtr sd;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out sd, IntPtr.Zero)) throw new Win32Exception();
            try {
                var security = new CommandJob.Security { Size = Marshal.SizeOf(typeof(CommandJob.Security)), Descriptor = sd };
                var h = CreateNamedPipe(@"\\.\pipe\" + name, 3u | (first ? 0x80000u : 0u) | (overlapped ? 0x40000000u : 0u), 8u, (uint)instances, 65536, 65536, 0, ref security);
                if (h.IsInvalid) throw new Win32Exception();
                return new NamedPipeServerStream(PipeDirection.InOut, overlapped, false, h);
            } finally { LocalFree(sd); }
        }
        // UAC: runs exe elevated and waits for it. Returns its exit code, or -1223 when the customer said No. answered runs
        // once the customer said Yes and the elevated process exists.
        public static int RunElevated(string exe, string args, IntPtr owner, Action answered) {
            var info = new ShellInfo { Size = Marshal.SizeOf(typeof(ShellInfo)), Mask = 0x40 | 0x100 | 0x400, Window = owner, Verb = "runas", File = exe, Parameters = args, Show = 1 };
            if (!ShellExecuteEx(ref info)) { int e = Marshal.GetLastWin32Error(); if (e == 1223) return -1223; throw new Win32Exception(e); }
            if (info.Process == IntPtr.Zero) throw new Win32Exception(5);
            try { answered(); CommandJob.WaitForSingleObject(info.Process, 0xFFFFFFFF); uint code; return GetExitCodeProcess(info.Process, out code) ? (int)code : -1; }
            finally { CloseHandle(info.Process); }
        }
        public static string SendSas() {
            try { SendSAS(false); return null; } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
            return "this version of Windows cannot send Ctrl+Alt+Del";
        }
        // The elevated installer runs from its own copy in a fresh Temp folder (Elevation.Stage). Also load DLLs from
        // System32 only after Main starts (Windows 8, or 7 with KB2533623).
        public static void SafeDllSearch() { try { SetDefaultDllDirectories(0x800); } catch (EntryPointNotFoundException) { } }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateDirectory(string path, ref CommandJob.Security security);
        // Creates path with the security of sec in one step, and fails when anything exists there: an existing folder
        // is never adopted, so nobody can hold a handle to it from before.
        public static void CreateLocked(string path, DirectorySecurity sec) {
            var pin = GCHandle.Alloc(sec.GetSecurityDescriptorBinaryForm(), GCHandleType.Pinned);
            try {
                var security = new CommandJob.Security { Size = Marshal.SizeOf(typeof(CommandJob.Security)), Descriptor = pin.AddrOfPinnedObject() };
                if (!CreateDirectory(path, ref security)) throw new Win32Exception();
            } finally { pin.Free(); }
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern int GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder path, int size, int flags);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle h, int kind, ref byte delete, int size);
        [StructLayout(LayoutKind.Sequential)] struct BasicInfo { public long Created, Accessed, Written, Changed; public uint Attributes; }
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle h, int kind, ref BasicInfo info, int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int kind, IntPtr buffer, int size);
        [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
        [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public int Length; public IntPtr Root, Name; public uint Attributes; public IntPtr Security, Quality; }
        [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status, Information; }
        [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle h, uint access, ref ObjectAttributes attributes, out IoStatus io, IntPtr size, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
        // DELETE, SYNCHRONIZE, read and write attributes, list the folder. Shared for reading and writing only, never for
        // deleting: nobody can rename, delete or replace what one of these handles holds while it is open.
        const uint TreeAccess = 0x10000 | 0x100000 | 0x80 | 0x100 | 0x1, TreeShare = 3;
        // Tests: BeforeOpen runs between listing a folder and opening an entry of it, AfterCheck between checking a folder
        // through its handle and listing it. A swap at either point must not make DeleteTree follow a link.
        internal static Action<string> BeforeOpen = null, AfterCheck = null;
        // Deletes a folder and what is in it. Every level is opened as itself (FILE_OPEN_REPARSE_POINT) and checked through
        // its handle; an entry is opened relative to the handle of its folder, never through a path that could be resolved
        // again, and removed through its own handle. So a link (a junction, also the top folder itself, or one swapped in
        // at any moment) is removed and never followed, and a held folder cannot be swapped while it is worked on.
        public static void DeleteTree(string dir) {
            var h = CreateFile(dir, TreeAccess, TreeShare, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
            if (h.IsInvalid) throw new Win32Exception();
            using (h) DeleteOpen(h, Path.GetFileName(dir));
        }
        static void DeleteOpen(SafeFileHandle h, string name) {
            FileInfo info; if (!GetFileInformationByHandle(h, out info)) throw new Win32Exception();
            bool link = (info.Attributes & 0x400) != 0, folder = (info.Attributes & 0x10) != 0;
            if (folder && !link) {
                var check = AfterCheck; if (check != null) check(name);
                foreach (string entry in Entries(h)) {
                    var hook = BeforeOpen; if (hook != null) hook(entry);
                    using (var child = OpenIn(h, entry)) if (child != null) try { DeleteOpen(child, entry); } catch (Exception) { }
                }
            }
            if (!link && (info.Attributes & 1) != 0) {
                // Attributes belong to the file, not to the name: clearing ReadOnly on one of several hard links would change
                // a file elsewhere, so such a file stays.
                if (!folder && info.Links > 1) return;
                var basic = new BasicInfo { Attributes = (info.Attributes & ~1u) == 0 ? 0x80 : info.Attributes & ~1u };
                if (!SetFileInformationByHandle(h, 0, ref basic, Marshal.SizeOf(typeof(BasicInfo)))) throw new Win32Exception();
            }
            byte yes = 1; if (!SetFileInformationByHandle(h, 4, ref yes, 1)) throw new Win32Exception();
        }
        // The names in a folder, read through its handle (FileIdBothDirectoryInfo).
        static List<string> Entries(SafeFileHandle h) {
            var names = new List<string>(); const int Size = 65536; IntPtr buffer = Marshal.AllocHGlobal(Size);
            try {
                int kind = 11; // restart from the first entry
                while (GetFileInformationByHandleEx(h, kind, buffer, Size)) {
                    kind = 10;
                    for (int at = 0; ; ) {
                        IntPtr e = buffer + at; int next = Marshal.ReadInt32(e, 0), length = Marshal.ReadInt32(e, 60);
                        string name = Marshal.PtrToStringUni(e + 104, length / 2);
                        if (name != "." && name != "..") names.Add(name);
                        if (next == 0) break;
                        at += next;
                    }
                }
                int error = Marshal.GetLastWin32Error(); if (error != 18) throw new Win32Exception(error); // 18: no more files
            } finally { Marshal.FreeHGlobal(buffer); }
            return names;
        }
        // Opens name inside the folder of dir, as itself, or null.
        static SafeFileHandle OpenIn(SafeFileHandle dir, string name) {
            IntPtr text = Marshal.StringToHGlobalUni(name), unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
            bool added = false;
            try {
                Marshal.StructureToPtr(new UnicodeString { Length = (ushort)(name.Length * 2), MaximumLength = (ushort)(name.Length * 2 + 2), Buffer = text }, unicode, false);
                dir.DangerousAddRef(ref added);
                var attributes = new ObjectAttributes { Length = Marshal.SizeOf(typeof(ObjectAttributes)), Root = dir.DangerousGetHandle(), Name = unicode, Attributes = 0x40 };
                SafeFileHandle h; IoStatus io;
                // FILE_OPEN; FILE_OPEN_REPARSE_POINT, synchronous, backup intent (folders).
                int status = NtCreateFile(out h, TreeAccess, ref attributes, out io, IntPtr.Zero, 0, TreeShare, 1, 0x200000 | 0x20 | 0x4000, IntPtr.Zero, 0);
                if (status >= 0) return h;
                if (h != null) h.Dispose();
                return null;
            } finally {
                if (added) dir.DangerousRelease();
                Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(text);
            }
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateDirectory(string path, IntPtr security);
        static string FinalPath(SafeFileHandle h) {
            var name = new StringBuilder(1024); int n = GetFinalPathNameByHandle(h, name, name.Capacity, 0);
            string final = n > 0 && n < name.Capacity ? name.ToString() : "";
            return final.StartsWith(@"\\?\") ? final.Substring(4) : final;
        }
        // Full control runs file operations as SYSTEM, and a user may put a junction, a link or a second hard link in a
        // path to aim SYSTEM at a protected file. So every folder of the path, from the drive down, is opened as itself
        // (never a link's target), checked to be a plain folder with exactly its own path, and held without delete
        // sharing, so nobody can rename or replace it until the file is open. A missing folder (to write) is created one
        // level at a time, each checked the same way before the next. The file itself must then have exactly the
        // requested path, be no link and (to write) have one name only. A file this call created somewhere else is
        // deleted again. 8.3 short names fail the check too; use the long path.
        public const string LinkRefused = "the path goes through a link or junction, or the file has another name; file operations as SYSTEM refuse those";
        static List<SafeFileHandle> HoldFolders(string full, bool create) {
            var held = new List<SafeFileHandle>(); var levels = new List<string>(); bool ok = false;
            for (string level = Path.GetDirectoryName(full); level != null; level = Path.GetDirectoryName(level)) levels.Insert(0, level);
            try {
                foreach (string level in levels) {
                    if (create && !Directory.Exists(level) && !File.Exists(level) && !CreateDirectory(level, IntPtr.Zero) && Marshal.GetLastWin32Error() != 183) throw new Win32Exception();
                    // FILE_READ_ATTRIBUTES; share read and write, not delete; BACKUP_SEMANTICS | OPEN_REPARSE_POINT
                    var h = CreateFile(level, 0x80, 3, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
                    if (h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                    held.Add(h); FileInfo info;
                    if (!GetFileInformationByHandle(h, out info) || (info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0
                        || !String.Equals(FinalPath(h).TrimEnd('\\'), level.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new ArgumentException(LinkRefused);
                }
                ok = true; return held;
            } finally { if (!ok) foreach (var h in held) h.Dispose(); }
        }
        public static FileStream OpenPlain(string path, bool write, bool append) {
            string full = Path.GetFullPath(path);
            var held = HoldFolders(full, write);
            try {
                // write: GENERIC_WRITE, DELETE, FILE_READ_ATTRIBUTES, OPEN_ALWAYS, share read. read: GENERIC_READ, OPEN_EXISTING, share read and write.
                var h = CreateFile(full, write ? 0x40000000u | 0x10000u | 0x80u : 0x80000000u, write ? 1u : 3u, IntPtr.Zero, write ? 4u : 3u, 0x00200000, IntPtr.Zero);
                int error = Marshal.GetLastWin32Error();
                if (h.IsInvalid) throw new Win32Exception(error);
                bool created = write && error != 183, ok = false;
                try {
                    FileInfo info;
                    ok = GetFileInformationByHandle(h, out info) && (info.Attributes & 0x410) == 0 && (!write || info.Links <= 1)
                        && String.Equals(FinalPath(h), full, StringComparison.OrdinalIgnoreCase);
                    if (!ok) { if (created) { byte yes = 1; SetFileInformationByHandle(h, 4, ref yes, 1); } throw new ArgumentException(LinkRefused); }
                    var stream = new FileStream(h, write ? FileAccess.Write : FileAccess.Read);
                    if (write) { if (append) stream.Seek(0, SeekOrigin.End); else stream.SetLength(0); }
                    return stream;
                } finally { if (!ok) h.Dispose(); }
            } finally { foreach (var f in held) f.Dispose(); }
        }
    }

    // The pipes between the roles carry a 4-byte length and then UTF-8 JSON. Every message is checked before use.
    public static class Pipes {
        public const int ResultMax = 2000000;
        static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = ResultMax }; }
        public static void Write(Stream s, Dictionary<string, object> m) {
            byte[] body = Encoding.UTF8.GetBytes(Json().Serialize(m)), all = new byte[body.Length + 4];
            BitConverter.GetBytes(body.Length).CopyTo(all, 0); body.CopyTo(all, 4);
            s.Write(all, 0, all.Length); s.Flush();
        }
        public static Dictionary<string, object> Read(Stream s, int max) { return Read(s, max, 0); }
        // ms above 0: the whole message must arrive within ms (the stream must be overlapped), else TimeoutException.
        public static Dictionary<string, object> Read(Stream s, int max, int ms) {
            var clock = Stopwatch.StartNew();
            int n = BitConverter.ToInt32(Fill(s, 4, ms, clock), 0);
            if (n < 2 || n > max) throw new InvalidDataException("bad message size");
            Dictionary<string, object> m;
            try { m = Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(Fill(s, n, ms, clock))); }
            catch (Exception) { throw new InvalidDataException("bad message"); }
            if (m == null) throw new InvalidDataException("bad message");
            return m;
        }
        static byte[] Fill(Stream s, int n, int ms, Stopwatch clock) {
            var b = new byte[n]; int got = 0, r;
            while (got < n) {
                if (ms <= 0) r = s.Read(b, got, n - got);
                else {
                    var pending = s.BeginRead(b, got, n - got, null, null);
                    long left = ms - clock.ElapsedMilliseconds;
                    if (left <= 0 || !pending.AsyncWaitHandle.WaitOne((int)left)) throw new System.TimeoutException("the pipe client sent nothing in time");
                    r = s.EndRead(pending);
                }
                if (r <= 0) throw new EndOfStreamException();
                got += r;
            }
            return b;
        }
        // A client end that asks only for reading and writing data, and lets the server identify it but never act as it:
        // a process that took the name first must not be able to impersonate SYSTEM or the user.
        public static NamedPipeClientStream Client(string name) {
            return new NamedPipeClientStream(".", name, PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.ReadAttributes | PipeAccessRights.Synchronize,
                PipeOptions.Asynchronous, TokenImpersonationLevel.Identification, HandleInheritability.None);
        }
        // True when the pipe's server end runs in session 0, so it is a service and not a squatter in an interactive
        // session. The device pipe's ACL lets only SYSTEM add instances, but a squatter can take the name first.
        public static bool ServerIsService(SafePipeHandle pipe) { uint session; return Native.GetNamedPipeServerSessionId(pipe, out session) && session == 0; }
        // What a corner window may ask the service: exactly {"type":"status"} or {"type":"end"}. null for anything else.
        public static string UiRequest(Dictionary<string, object> m) {
            object t; if (m.Count != 1 || !m.TryGetValue("type", out t)) return null;
            return "status".Equals(t) || "end".Equals(t) ? (string)t : null;
        }
        // What a saved PC's tray may ask the service: exactly {"type":"status"}, {"type":"allow_any_time"},
        // {"type":"refresh"} or {"type":"end_session"}. Any extra field, or any other type, is null (closed), so nothing
        // can ask for access "ask".
        public static string DeviceRequest(Dictionary<string, object> m) {
            object t; if (m.Count != 1 || !m.TryGetValue("type", out t)) return null;
            return "status".Equals(t) || "allow_any_time".Equals(t) || "refresh".Equals(t) || "end_session".Equals(t) ? (string)t : null;
        }
    }

    public static class FullAcl {
        public static readonly SecurityIdentifier SystemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            AdminsSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), UsersSid = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
            InteractiveSid = new SecurityIdentifier(WellKnownSidType.InteractiveSid, null);
        // The service folder: SYSTEM and Administrators only, nothing inherited from %ProgramData%.
        public static DirectorySecurity Folder() {
            var s = new DirectorySecurity(); s.SetAccessRuleProtection(true, false);
            foreach (var who in new SecurityIdentifier[] { SystemSid, AdminsSid })
                s.AddAccessRule(new FileSystemAccessRule(who, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            return s;
        }
        static FileSecurity ForFile(SecurityIdentifier reader, FileSystemRights rights) {
            var s = new FileSecurity(); s.SetAccessRuleProtection(true, false);
            foreach (var who in new SecurityIdentifier[] { SystemSid, AdminsSid }) s.AddAccessRule(new FileSystemAccessRule(who, FileSystemRights.FullControl, AccessControlType.Allow));
            s.AddAccessRule(new FileSystemAccessRule(reader, rights, AccessControlType.Allow));
            return s;
        }
        // HKLM\SOFTWARE\SupportMCP: SYSTEM and Administrators only, inherited by its subkeys.
        public static RegistrySecurity Registry() {
            var s = new RegistrySecurity(); s.SetAccessRuleProtection(true, false);
            foreach (var who in new SecurityIdentifier[] { SystemSid, AdminsSid }) s.AddAccessRule(new RegistryAccessRule(who, RegistryRights.FullControl, InheritanceFlags.ContainerInherit, PropagationFlags.None, AccessControlType.Allow));
            return s;
        }
        // The corner window runs as the signed-in user, so its copy (which carries no session key) is readable by Users.
        public static FileSecurity Window() { return ForFile(UsersSid, FileSystemRights.ReadAndExecute); }
        // A command for as: "user" may be read, not changed, by the user it runs as.
        public static FileSecurity Script(SecurityIdentifier user) { return ForFile(user, FileSystemRights.Read); }
    }

    // Issue #22: any signed-in user may create a Global mutex or event before we do, with an access list of their own,
    // and Windows then opens theirs and ignores the security we ask for. So a named object that already exists is
    // trusted only when its owner is SYSTEM or BUILTIN\Administrators; an owner that cannot be read counts as hostile.
    public static class OwnerCheck {
        // Tests only: one more owner to trust (the test account, which creates its Local test objects itself).
        internal static SecurityIdentifier AlsoTrusted = null;
        public const string Blocked = "Another program is blocking Support. Restart the PC and try again.";
        public static bool Trusted(SecurityIdentifier owner) {
            var also = AlsoTrusted;
            return owner != null && (owner.Equals(FullAcl.SystemSid) || owner.Equals(FullAcl.AdminsSid) || (also != null && owner.Equals(also)));
        }
        // The owner through read, false when it cannot be read.
        public static bool Trusted(Func<ObjectSecurity> read) {
            try { var s = read(); return s != null && Trusted(s.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier); } catch (Exception) { return false; }
        }
        // An open mutex. Its own handle may lack READ_CONTROL (.NET falls back to an open with modify and synchronize
        // only), so a second handle that asks for nothing but that is tried too. The object stays the one named, as the
        // first handle keeps it alive.
        public static bool Trusted(Mutex m, string name) {
            if (Trusted(delegate { return m.GetAccessControl(); })) return true;
            return Trusted(delegate { using (var r = Mutex.OpenExisting(name, MutexRights.ReadPermissions)) return r.GetAccessControl(); });
        }
        public static bool Trusted(EventWaitHandle e) { return Trusted(delegate { return e.GetAccessControl(); }); }
        // The SIDs a PowerShell check accepts, as a PowerShell array literal of quoted strings.
        public static string PowerShellList() {
            var also = AlsoTrusted;
            return "@('" + FullAcl.SystemSid.Value + "','" + FullAcl.AdminsSid.Value + "'" + (also != null ? ",'" + also.Value + "'" : "") + ")";
        }
        // Opens an existing event with rights plus ReadPermissions, and returns it only when its owner is trusted.
        public static EventWaitHandle OpenEvent(string name, EventWaitHandleRights rights) {
            EventWaitHandle e;
            try { if (!EventWaitHandle.TryOpenExisting(name, rights | EventWaitHandleRights.ReadPermissions, out e)) return null; } catch (Exception) { return null; }
            if (Trusted(e)) return e;
            e.Dispose(); return null;
        }
    }

    // state.json in the service folder: the full session id and the deadline (Unix ms on the UTC wall clock).
    public sealed class FullState {
        public const long DayMs = 86400000;
        public string Sid = "", Task = ""; public long Deadline; public bool Welcomed; public int AppPid;
        public static bool Expired(long deadline, long now) { return now >= deadline; }
        public static long Clamp(long deadline, long now) { return Math.Min(deadline, now + DayMs); }
        // The first welcome replaces connect_by with the session's expiry. A later one (after a restart) only brings it closer.
        public static long OnWelcome(long stored, bool welcomed, long sessionEnd, long now) { long d = Clamp(sessionEnd, now); return welcomed ? Math.Min(stored, d) : d; }
        public static string PathIn(string folder) { return Path.Combine(folder, "state.json"); }
        public void Save(string folder) {
            string file = PathIn(folder), temp = file + ".new";
            File.WriteAllText(temp, Wire.Json().Serialize(Wire.Map("sid", Sid, "task", Task, "deadline", Deadline, "welcomed", Welcomed, "app_pid", AppPid)));
            if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file);
        }
        // null when missing or damaged. The service then treats the session as over.
        public static FullState Load(string folder) {
            try {
                var m = Wire.Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(PathIn(folder)));
                var st = new FullState { Sid = Wire.Text(m, "sid"), Task = Wire.Text(m, "task"), Deadline = Wire.Number(m, "deadline"), Welcomed = Wire.Flag(m, "welcomed"), AppPid = (int)Wire.Number(m, "app_pid") };
                return st.Deadline > 0 && st.Sid.Length == 64 && st.Task.StartsWith("SupportMcp-", StringComparison.Ordinal) ? st : null;
            } catch (Exception) { return null; }
        }
    }

    // SoftwareSASGeneration lets a service call SendSAS (1: services, 3: services and ease of access apps). Sessions
    // on one PC share it. Each holds a value named after its service under HoldersKey; the first that had to change
    // the value records what it found ("original": the number as text, or "absent") and what it wrote. The last holder to leave puts
    // the original back, and only when the value is still the one written, so a later change by an administrator stays.
    public static class SasShare {
        public const string PolicyKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", RootKey = @"SOFTWARE\SupportMCP", HoldersKey = RootKey + @"\SoftwareSASGeneration", Value = "SoftwareSASGeneration";
        // HKLM in the 64-bit view: this is an x86 process, and these keys must not land under Wow6432Node.
        public static Microsoft.Win32.RegistryKey Machine() { return Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64); }
        public static bool Needed(int value) { return value != 1 && value != 3; }
        public static int Wanted(int value) { return value == 2 ? 3 : 1; }
        static int Read(Microsoft.Win32.RegistryKey k, string name) { object v = k == null ? null : k.GetValue(name); return v is int ? (int)v : -1; }
        const Microsoft.Win32.RegistryValueKind Dword = Microsoft.Win32.RegistryValueKind.DWord;
        // Installs, services and backstop tasks of different sessions change the record at the same time: one machine-wide
        // mutex orders them. Any signed-in user may create that name first, so one this code did not create is used only
        // when SYSTEM or Administrators own it (issue #22, OwnerCheck). The tests use a Local one.
        // Nothing touches the record without the mutex. When another process still holds it after WaitMs, the work is
        // skipped and the caller gets false: a skipped install shares nothing (send_sas then says Windows refuses it), and
        // a skipped release keeps this session's entry and its backstop task, which releases it at the deadline.
        public static string MutexName = @"Global\SupportMcp-Sas";
        public const string Refused = "Windows does not let this session send Ctrl+Alt+Del (SoftwareSASGeneration); ask the customer to press it";
        public static int WaitMs = 30000;
        static bool Locked(Action work) {
            bool created; string name = MutexName; Mutex opened;
            // A squatter whose access list shuts this caller out makes the open throw: skip as busy, like a squatter we can read.
            try { opened = new Mutex(false, name, out created); } catch (UnauthorizedAccessException) { return false; }
            using (var m = opened) {
                if (!created && !OwnerCheck.Trusted(m, name)) return false; // issue #22: made by someone else, so skip as if busy
                bool own;
                try { own = m.WaitOne(WaitMs); } catch (AbandonedMutexException) { own = true; }
                if (!own) return false;
                try { work(); } finally { m.ReleaseMutex(); }
                return true;
            }
        }
        // False: the mutex was busy and nothing was changed.
        public static bool Acquire(Microsoft.Win32.RegistryKey root, string holder) { return Locked(delegate { AcquireLocked(root, holder); }); }
        public static bool Release(Microsoft.Win32.RegistryKey root, string holder) { return Locked(delegate { ReleaseLocked(root, holder); }); }
        // Whether Windows lets a service send Ctrl+Alt+Del now.
        public static bool Allowed(Microsoft.Win32.RegistryKey root) { using (var policy = root.OpenSubKey(PolicyKey)) return !Needed(Read(policy, Value)); }
        static void AcquireLocked(Microsoft.Win32.RegistryKey root, string holder) {
            using (var top = root.CreateSubKey(RootKey)) if (root.Name == "HKEY_LOCAL_MACHINE") top.SetAccessControl(FullAcl.Registry());
            using (var policy = root.CreateSubKey(PolicyKey)) using (var holders = root.CreateSubKey(HoldersKey)) {
                holders.SetValue(holder, 1, Dword); // first, so a crash after the change below still puts it back
                int current = Read(policy, Value); object written = holders.GetValue("written");
                if (written is int && current == (int)written) return; // another session changed it already
                holders.DeleteValue("written", false); holders.DeleteValue("original", false);
                if (!Needed(current)) return; // services may already send SAS: nothing to change or restore
                holders.SetValue("original", current < 0 ? "absent" : current.ToString(System.Globalization.CultureInfo.InvariantCulture), Microsoft.Win32.RegistryValueKind.String);
                holders.SetValue("written", Wanted(current), Dword);
                policy.SetValue(Value, Wanted(current), Dword);
            }
        }
        static void ReleaseLocked(Microsoft.Win32.RegistryKey root, string holder) {
            using (var holders = root.OpenSubKey(HoldersKey, true)) {
                if (holders == null) return;
                holders.DeleteValue(holder, false);
                foreach (string name in holders.GetValueNames()) if (name.StartsWith("SupportMcp-", StringComparison.Ordinal)) return; // still needed
                string original = holders.GetValue("original") as string; object written = holders.GetValue("written"); int number;
                if (original != null && written is int)
                    using (var policy = root.OpenSubKey(PolicyKey, true))
                        if (policy != null && Read(policy, Value) == (int)written) {
                            if (original == "absent") policy.DeleteValue(Value, false);
                            else if (int.TryParse(original, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out number)) policy.SetValue(Value, number, Dword);
                        }
            }
            root.DeleteSubKey(HoldersKey, false);
            bool empty; using (var top = root.OpenSubKey(RootKey)) empty = top != null && top.SubKeyCount == 0 && top.ValueCount == 0;
            if (empty) root.DeleteSubKey(RootKey, false);
        }
        // The same release in PowerShell for the backstop task, which must not run the app. psRoot is "HKLM:" there.
        // Without the mutex it changes nothing and exits with 1; the holder's entry stays, so the task does not delete
        // itself and runs again an hour later (see Backstop.Xml). A mutex whose owner is not SYSTEM or Administrators
        // (issue #22) counts as not taken; the task runs as SYSTEM, so one it creates itself passes.
        public static string ReleaseScript(string psRoot, string holder) { return ReleaseScript(psRoot, holder, MutexName); }
        public static string ReleaseScript(string psRoot, string holder, string mutex) {
            string r = psRoot + "\\" + RootKey, k = psRoot + "\\" + HoldersKey, p = psRoot + "\\" + PolicyKey;
            string sid = "[System.Security.Principal.SecurityIdentifier]";
            return "$m = New-Object System.Threading.Mutex($false, '" + mutex + "'); $own = $false; try { $o = ''; " +
                "try { $o = $m.GetAccessControl().GetOwner(" + sid + ").Value } catch { try { $q = [System.Threading.Mutex]::OpenExisting('" + mutex + "', [System.Security.AccessControl.MutexRights]::ReadPermissions); $o = $q.GetAccessControl().GetOwner(" + sid + ").Value; $q.Close() } catch { } }; " +
                "if (" + OwnerCheck.PowerShellList() + " -contains $o) { try { $own = $m.WaitOne(" + WaitMs.ToString(System.Globalization.CultureInfo.InvariantCulture) + ") } catch [System.Threading.AbandonedMutexException] { $own = $true } }; " +
                "if ($own) { $r='" + r + "'; $k='" + k + "'; $p='" + p + "'; if (Test-Path $k) { Remove-ItemProperty -Path $k -Name '" + holder + "' -ErrorAction SilentlyContinue; " +
                "$v = Get-ItemProperty -Path $k; if (@($v.PSObject.Properties | Where-Object { $_.Name -like 'SupportMcp-*' }).Count -eq 0) { " +
                "$c = (Get-ItemProperty -Path $p -ErrorAction SilentlyContinue).SoftwareSASGeneration; " +
                "if ($v.written -ne $null -and $v.original -ne $null -and $c -eq $v.written) { if ($v.original -eq 'absent') { Remove-ItemProperty -Path $p -Name SoftwareSASGeneration } elseif ($v.original -match '^[0-9]+$') { Set-ItemProperty -Path $p -Name SoftwareSASGeneration -Value ([int]$v.original) -Type DWord } }; " +
                "Remove-Item -Path $k; $g = Get-Item -Path $r; if ($g.SubKeyCount -eq 0 -and $g.ValueCount -eq 0) { Remove-Item -Path $r } } } } } finally { if ($own) { $m.ReleaseMutex() }; $m.Close() }; if (-not $own) { exit 1 }";
        }
    }

    public enum RunAs { System, User, ElevatedUser, Nobody }
    public static class TokenChoice {
        public const string NobodySignedIn = "nobody is signed in; use as: \"system\"";
        // elevationType of the console user's token: 3 is an administrator's filtered token, whose linked token is elevated.
        public static RunAs Pick(bool system, bool signedIn, int elevationType) { return system ? RunAs.System : !signedIn ? RunAs.Nobody : elevationType == 3 ? RunAs.ElevatedUser : RunAs.User; }
    }

    // block_input lasts 1 to 10 minutes. It ends when the time is up, when the operator turns it off, or when the
    // customer presses Ctrl+Alt+Del: Windows lifts the block and switches to the secure desktop. It then stays off
    // until the operator calls on again.
    public sealed class BlockTimer {
        long until;
        public bool Escaped { get; private set; }
        public void Arm(long now, long minutes) { until = now + Math.Max(1, Math.Min(10, minutes)) * 60000L; Escaped = false; }
        public void Off() { until = 0; }
        public bool On(long now) { return until > now; }
        public long RemainingMs(long now) { return Math.Max(0, until - now); }
        // While the block is held. False means lift it now: the time is up, or Windows already lifted it.
        public bool Check(long now, bool sameDesktop, bool stillBlocked) {
            if (until == 0) return false;
            if (!sameDesktop || !stillBlocked) { until = 0; Escaped = true; return false; }
            if (now >= until) { until = 0; return false; }
            return true;
        }
    }

    static class Shell {
        public static string Output(string tool, string args) {
            using (var p = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, tool), args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, WorkingDirectory = Environment.SystemDirectory })) {
                string text = p.StandardOutput.ReadToEnd(); p.WaitForExit(60000); return text;
            }
        }
        // Runs a Windows tool hidden. Returns its exit code, or -1 when it did not finish within a minute.
        public static int Run(string tool, string args) {
            using (var p = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, tool), args) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Environment.SystemDirectory })) {
                if (!p.WaitForExit(60000)) { try { p.Kill(); } catch (Exception) { } return -1; }
                return p.ExitCode;
            }
        }
    }

    // The backstop: a SYSTEM scheduled task at the deadline that removes the service, its share of the registry value
    // and the folder, then itself, in that order. It runs cmd and PowerShell, never agent.exe, which antivirus may have
    // deleted. The service moves it from connect_by to the session's expiry at the first welcome.
    public static class Backstop {
        public static string Name(string sid8) { return "SupportMcp-" + sid8; }
        // Each install's task has a name of its own, so the late self-delete of an earlier install's task, or of its
        // service's cleanup, can never remove the task of a later install of the same session.
        public static string NewTask(string sid8) { return Name(sid8) + "-" + Guid.NewGuid().ToString("N").Substring(0, 8); }
        // Full paths, from the 64-bit System32 (Task Scheduler resolves them without this process's redirection; the
        // service's own cmd is 32-bit and gets SysWOW64, which has the same tools). No spaces, so no quotes in cmd lines.
        public static string System32(string tool) { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"System32\" + tool); }
        // cmd: delete the folder, retrying while a closing window still holds window.exe.
        public static string RemoveFolder(string folder) {
            return "(for /l %i in (1,1,20) do @(if exist \"" + folder + "\" (rd /s /q \"" + folder + "\" 2>nul & if exist \"" + folder + "\" " + System32("PING.EXE") + " -n 3 127.0.0.1 >nul)))";
        }
        public static string DeleteTask(string task) { return System32("schtasks.exe") + " /delete /tn \"" + task + "\" /f"; }
        // cmd: delete the task only once the session has no entry left in the SoftwareSASGeneration record. An entry
        // stays when the release could not take the mutex; the task then runs again an hour later (Xml).
        public static string DeleteTaskWhenReleased(string sid8, string task) {
            return "(" + System32("reg.exe") + " query \"HKLM\\" + SasShare.HoldersKey + "\" /v \"" + Name(sid8) + "\" /reg:64 >nul 2>&1 || " + DeleteTask(task) + ")";
        }
        // The actions in order, as command and arguments.
        public static string[][] Actions(string sid8, string folder, string task) {
            string name = Name(sid8), sc = System32("sc.exe");
            return new string[][] {
                new string[] { System32("cmd.exe"), "/c " + sc + " stop \"" + name + "\" & " + System32("PING.EXE") + " -n 6 127.0.0.1 >nul & " + System32("taskkill.exe") + " /f /fi \"SERVICES eq " + name + "\" & " + sc + " delete \"" + name + "\"" },
                new string[] { System32(@"WindowsPowerShell\v1.0\powershell.exe"), "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" + SasShare.ReleaseScript("HKLM:", name) + "\"" },
                new string[] { System32("cmd.exe"), "/c " + RemoveFolder(folder) + " & " + DeleteTaskWhenReleased(sid8, task) } };
        }
        public static string Xml(string[][] actions, long deadline) {
            // Whole seconds in UTC, rounded up, so the task never fires before the deadline.
            string at = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(deadline + 999).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", System.Globalization.CultureInfo.InvariantCulture);
            var exec = new StringBuilder();
            foreach (string[] a in actions) exec.Append("<Exec><Command>" + System.Security.SecurityElement.Escape(a[0]) + "</Command><Arguments>" + System.Security.SecurityElement.Escape(a[1]) + "</Arguments></Exec>");
            return "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
                "<RegistrationInfo><Description>Removes a remote support session at its deadline if it is still installed.</Description></RegistrationInfo>" +
                "<Triggers><TimeTrigger><Repetition><Interval>PT1H</Interval></Repetition><StartBoundary>" + at + "</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>" +
                "<Principals><Principal id=\"System\"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>" +
                "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>" +
                "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Enabled>true</Enabled></Settings>" +
                "<Actions Context=\"System\">" + exec + "</Actions></Task>";
        }
        // The XML goes into the session folder, which only SYSTEM and Administrators can write and which was created
        // fresh by this install, so nobody else can change it before schtasks reads it.
        public static void Register(string sid8, string folder, FullState state) {
            string xml = Path.Combine(folder, "backstop.xml");
            File.WriteAllText(xml, Xml(Actions(sid8, folder, state.Task), state.Deadline), Encoding.Unicode);
            try { if (Shell.Run("schtasks.exe", "/create /tn \"" + state.Task + "\" /xml \"" + xml + "\" /f") != 0) throw new IOException("cannot register the backstop task"); }
            finally { File.Delete(xml); }
        }
        public static void Delete(string task) { Shell.Run("schtasks.exe", "/delete /tn \"" + task + "\" /f"); }
        // The tasks of every install of this session that are still registered.
        public static List<string> Tasks(string sid8) {
            var found = new List<string>(); string prefix = "\"\\" + Name(sid8) + "-";
            foreach (string line in Shell.Output("schtasks.exe", "/query /fo csv /nh").Split('\n'))
                if (line.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) { string name = line.Substring(2, line.IndexOf('"', 2) - 2); if (!found.Contains(name)) found.Add(name); }
            return found;
        }
        // Runs the tasks of a leftover install and waits, at most 90 s, until each has deleted itself.
        public static void RunAndWait(string sid8) {
            foreach (string task in Tasks(sid8)) Shell.Run("schtasks.exe", "/run /tn \"" + task + "\"");
            var clock = Stopwatch.StartNew();
            while (Tasks(sid8).Count > 0 && clock.ElapsedMilliseconds < 90000) Thread.Sleep(2000);
        }
    }

    static class Scm {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenSCManager(string machine, string database, uint access);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateService(IntPtr scm, string name, string display, uint access, uint type, uint start, uint error, string path, string group, IntPtr tag, string dependencies, string account, string password);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenService(IntPtr scm, string name, uint access);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DeleteService(IntPtr service);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool CloseServiceHandle(IntPtr h);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Description { public string Text; }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ChangeServiceConfig2(IntPtr service, uint level, ref Description info);
        // SERVICE_FAILURE_ACTIONS (level 2): restart on the first two failures, then leave it. ResetPeriod is a day,
        // so unrelated failures far apart do not count together. The actions array is pinned in memory while the call runs.
        [StructLayout(LayoutKind.Sequential)] struct ScAction { public int Type; public uint Delay; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct FailureActions {
            public uint ResetPeriod; public string RebootMessage, Command; public uint Count; public IntPtr Actions;
        }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ChangeServiceConfig2(IntPtr service, uint level, ref FailureActions info);
        // Own process, auto start, LocalSystem. display and description are the service's text; restartOnFailure adds the
        // level-2 failure actions. The one-off full-control service keeps its exact text (see the single-argument call below).
        public static void Create(string name, string binary) { Create(name, "Remote support session", "Gives remote support full control of this PC for one session, and removes itself when the session ends.", binary, false); }
        public static void Create(string name, string display, string description, string binary, bool restartOnFailure) {
            IntPtr scm = OpenSCManager(null, null, 0x0003); if (scm == IntPtr.Zero) throw new Win32Exception();
            try {
                IntPtr s = CreateService(scm, name, display, 0xF01FF, 0x10, 2, 1, binary, null, IntPtr.Zero, null, null, null);
                if (s == IntPtr.Zero) throw new Win32Exception();
                try {
                    var d = new Description { Text = description };
                    ChangeServiceConfig2(s, 1, ref d);
                    if (restartOnFailure) SetFailureActions(s, null, null);
                } finally { CloseServiceHandle(s); }
            } finally { CloseServiceHandle(scm); }
        }
        // The failure actions. With runCommand null: two restarts after a one-minute wait, then no more (SC_ACTION_RESTART is
        // 1, SC_ACTION_NONE is 0). With a command line: run it on every failure (SC_ACTION_RUN_COMMAND is 3), which an
        // update's trial uses to put the old version back after a crash. command is the lpCommand field: null leaves the
        // stored command as it is, "" deletes it.
        static bool SetFailureActions(IntPtr s, string runCommand, string command) {
            var actions = new ScAction[3];
            for (int i = 0; i < actions.Length; i++) {
                actions[i].Type = runCommand != null ? 3 : i < 2 ? 1 : 0;
                actions[i].Delay = runCommand != null ? 1000u : i < 2 ? 60000u : 0u;
            }
            var pin = GCHandle.Alloc(actions, GCHandleType.Pinned);
            try {
                var fa = new FailureActions { ResetPeriod = 86400, RebootMessage = null, Command = runCommand ?? command, Count = (uint)actions.Length, Actions = pin.AddrOfPinnedObject() };
                return ChangeServiceConfig2(s, 2, ref fa);
            } finally { pin.Free(); }
        }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ChangeServiceConfig(IntPtr service, uint type, uint start, uint error, string binary, string group, IntPtr tag, string dependencies, string account, string password, string display);
        // Opens an existing service with access and runs work on it. Throws when either handle cannot be opened.
        static void With(string name, uint access, Action<IntPtr> work) {
            IntPtr scm = OpenSCManager(null, null, 0x0001); if (scm == IntPtr.Zero) throw new Win32Exception();
            try {
                IntPtr s = OpenService(scm, name, access); if (s == IntPtr.Zero) throw new Win32Exception();
                try { work(s); } finally { CloseServiceHandle(s); }
            } finally { CloseServiceHandle(scm); }
        }
        // Points the service at another command line (SERVICE_CHANGE_CONFIG; 0xFFFFFFFF is SERVICE_NO_CHANGE).
        public static void SetBinary(string name, string binary) {
            With(name, 0x0002, delegate(IntPtr s) { if (!ChangeServiceConfig(s, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, binary, null, IntPtr.Zero, null, null, null, null)) throw new Win32Exception(); });
        }
        // runCommand null puts back the normal restarts and deletes any command; otherwise every failure runs runCommand.
        // With a command, a stop with an error (an exception in OnStart) counts as a failure too, not only a crash
        // (SERVICE_CONFIG_FAILURE_ACTIONS_FLAG, level 4); the normal actions put back the default, crashes only. A restart
        // action needs SERVICE_START on the handle as well as SERVICE_CHANGE_CONFIG.
        [StructLayout(LayoutKind.Sequential)] struct FailureFlag { public int OnNonCrashFailures; }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ChangeServiceConfig2(IntPtr service, uint level, ref FailureFlag info);
        public static void SetFailureActions(string name, string runCommand) {
            With(name, 0x0002 | 0x0010, delegate(IntPtr s) {
                if (!SetFailureActions(s, runCommand, "")) throw new Win32Exception();
                var flag = new FailureFlag { OnNonCrashFailures = runCommand != null ? 1 : 0 };
                if (!ChangeServiceConfig2(s, 4, ref flag)) throw new Win32Exception();
            });
        }
        // The service's command line as stored (readable by every user), or null.
        public static string ImagePath(string name) {
            try {
                using (var hklm = SasShare.Machine())
                using (var k = hklm.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\" + name))
                    return k == null ? null : k.GetValue("ImagePath", null, Microsoft.Win32.RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
            } catch (Exception) { return null; }
        }
        // Stops a service that is not this process and waits up to ms; stopped or stopping already is fine. Never throws.
        public static void StopAndWait(string name, int ms) {
            try {
                using (var c = new ServiceController(name)) {
                    if (c.Status == ServiceControllerStatus.Stopped) return;
                    if (c.Status != ServiceControllerStatus.StopPending) { try { c.Stop(); } catch (InvalidOperationException) { } }
                    c.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromMilliseconds(ms));
                }
            } catch (Exception) { }
        }
        // Starts a service and waits until it runs; running or starting already is fine. Never throws.
        public static void StartTolerant(string name) {
            try {
                using (var c = new ServiceController(name)) {
                    if (c.Status == ServiceControllerStatus.Running || c.Status == ServiceControllerStatus.StartPending) return;
                    if (c.Status == ServiceControllerStatus.StopPending) c.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
                    try { c.Start(); } catch (InvalidOperationException) { } // started meanwhile
                    c.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));
                }
            } catch (Exception) { }
        }
        public static ServiceControllerStatus? Status(string name) { try { using (var c = new ServiceController(name)) return c.Status; } catch (InvalidOperationException) { return null; } }
        public static void Start(string name) { using (var c = new ServiceController(name)) { c.Start(); c.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30)); } }
        // Stops and deletes a service that is not this process.
        public static void Remove(string name) {
            try { using (var c = new ServiceController(name)) if (c.Status != ServiceControllerStatus.Stopped) { c.Stop(); c.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30)); } } catch (Exception) { }
            Delete(name);
        }
        // Marks it for deletion; a running service goes when it stops.
        public static void Delete(string name) {
            IntPtr scm = OpenSCManager(null, null, 0x0001); if (scm == IntPtr.Zero) return;
            try { IntPtr s = OpenService(scm, name, 0x10000); if (s != IntPtr.Zero) { DeleteService(s); CloseServiceHandle(s); } } finally { CloseServiceHandle(scm); }
        }
    }

    // --elevate-install and every cleanup that runs outside the service.
    public static class FullInstall {
        // %ProgramFiles%, from HKLM in the 64-bit view, not from an environment variable the user could set for the
        // elevated process. Users may not create, rename or delete anything in it.
        public static string Root {
            get {
                using (var hklm = SasShare.Machine()) using (var k = hklm.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion"))
                    return Convert.ToString(k.GetValue("ProgramFilesDir"));
            }
        }
        public static string Sid8(Dictionary<string, object> cfg) { return Wire.Text(cfg, "sid").Substring(0, 8); }
        public static string Folder(string sid8) { return Path.Combine(Root, "SupportMCP-" + sid8); }
        // The elevated installer reads its own exe once, through a handle that lets nobody write, rename or delete it
        // while the install runs, and takes the bytes and the configuration from that one read.
        public static byte[] ReadSelf(string exe, out FileStream held) {
            held = new FileStream(exe, FileMode.Open, FileAccess.Read, FileShare.Read);
            var all = new byte[held.Length]; int got = 0, n;
            while (got < all.Length && (n = held.Read(all, got, all.Length - got)) > 0) got += n;
            if (got != all.Length) throw new IOException("short read");
            return all;
        }
        // --elevate-install <deadline, Unix ms> <1 when the session is already connected> <app pid> <attempt nonce>. Exit
        // code 0: installed and running. Anything else: nothing of this install is left.
        public static int Install(byte[] self, Dictionary<string, object> cfg, string[] args) {
            long now = Client.UnixNow(), deadline;
            int appPid;
            if (args.Length != 5 || !long.TryParse(args[1], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out deadline) || deadline <= now
                || !int.TryParse(args[3], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out appPid)
                || !System.Text.RegularExpressions.Regex.IsMatch(args[4], "^[0-9a-f]{32}$")) return 2;
            string sid8 = Sid8(cfg);
            // The app stopped waiting (or exited) before this Yes: install nothing. The event stays open from here on, so
            // the app exiting after the Yes (a sign-out) withdraws nothing; only setting it does.
            var want = Elevation.Wanted(sid8, args[4]);
            if (want == null) return 1;
            using (want) return Install(self, cfg, sid8, deadline, now, args[2] == "1", appPid, want);
        }
        static int Install(byte[] self, Dictionary<string, object> cfg, string sid8, long deadline, long now, bool welcomed, int appPid, EventWaitHandle want) {
            string sid = Wire.Text(cfg, "sid"), name = Backstop.Name(sid8), folder = Folder(sid8);
            if (!System.Text.RegularExpressions.Regex.IsMatch(folder, @"^[A-Za-z]:\\[^%&|<>^""]+$")) return 2; // it goes into cmd lines
            var status = Scm.Status(name);
            if (status != null || Directory.Exists(folder) || File.Exists(folder) || Backstop.Tasks(sid8).Count > 0) {
                // A leftover (a crash in the middle of an install) or a running service. Only this session's is touched:
                // another session whose id starts with the same 8 characters is never adopted or removed.
                var old = FullState.Load(folder);
                if (old != null ? old.Sid != sid : status != null) return 3;
                if (status == ServiceControllerStatus.Running) return 0; // this session has full control already
                // No record to clean up with: the backstop tasks do it, and are waited for so they cannot delete anything new.
                if (old == null) Backstop.RunAndWait(sid8);
                Remove(sid8);
                if (Backstop.Tasks(sid8).Count > 0 || Directory.Exists(folder)) return 3;
            }
            try { Native.CreateLocked(folder, LockedFolder()); } catch (Exception) { return 1; } // not ours: leave it alone
            var state = new FullState { Sid = sid, Task = Backstop.NewTask(sid8), Deadline = FullState.Clamp(deadline, now), Welcomed = welcomed, AppPid = appPid };
            try {
                File.WriteAllBytes(Path.Combine(folder, "agent.exe"), self);
                string window = Path.Combine(folder, "window.exe");
                using (var f = new FileStream(window, FileMode.CreateNew)) f.Write(self, 0, Wire.Payload(self));
                File.SetAccessControl(window, FullAcl.Window());
                state.Save(folder);
                Backstop.Register(sid8, folder, state); // before the registry share, so the backstop covers it from the start
                // False when the mutex stayed busy: full control still works, and send_sas says that Windows refuses it.
                using (var hklm = SasShare.Machine()) SasShare.Acquire(hklm, name);
                Scm.Create(name, "\"" + Path.Combine(folder, "agent.exe") + "\" --service");
                if (want.WaitOne(0)) { Remove(sid8); return 1; } // withdrawn while this install ran
                Scm.Start(name);
                return 0;
            } catch (Exception) { Remove(sid8); return 1; }
        }
        // The service folder: created by an elevated administrator, owned by Administrators.
        static DirectorySecurity LockedFolder() { var s = FullAcl.Folder(); s.SetOwner(FullAcl.AdminsSid); return s; }
        // Layer 1 from outside the service (a failed install, a leftover of this session): the service, the registry
        // share, the folder, and the backstop task last.
        public static void Remove(string sid8) {
            string folder = Folder(sid8);
            Scm.Remove(Backstop.Name(sid8));
            bool released = false;
            try { using (var hklm = SasShare.Machine()) released = SasShare.Release(hklm, Backstop.Name(sid8)); } catch (Exception) { }
            try { if (Directory.Exists(folder)) Directory.Delete(folder, true); else if (File.Exists(folder)) File.Delete(folder); } catch (Exception) { }
            // A share that was not released keeps its backstop task, which releases it at the deadline.
            if (released) foreach (string task in Backstop.Tasks(sid8)) Backstop.Delete(task);
        }
        // A running exe cannot delete itself: a detached cmd removes the folder after the service has exited, then the
        // backstop task, last. When cmd cannot start, Windows deletes the files at the next restart and the task stays
        // as the backstop it is.
        public static void RemoveLater(IList<string> tasks, string folder) {
            try {
                string line = "/c " + Backstop.System32("PING.EXE") + " -n 3 127.0.0.1 >nul & " + Backstop.RemoveFolder(folder);
                foreach (string task in tasks) line += " & " + Backstop.DeleteTask(task);
                using (Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"), line) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Environment.SystemDirectory })) { }
            } catch (Exception) {
                try { foreach (string f in Directory.GetFiles(folder)) Native.MoveFileEx(f, null, 4); Native.MoveFileEx(folder, null, 4); } catch (Exception) { }
            }
        }
    }

    // The customer's side of --elevate-install.
    public static class Elevation {
        public const int Installed = 0, Declined = 1, Failed = 2, NoAnswer = 3;
        // The elevated child runs from a copy in a new folder of its own under the user's Temp, so nothing that sits
        // next to the download (an .exe.config, a DLL) is loaded by the elevated process. The caller deletes the folder.
        public const string StagePrefix = "SupportMcpStage-";
        public static string Stage(string exe) {
            string dir = Path.Combine(Path.GetTempPath(), StagePrefix + Guid.NewGuid().ToString("N")), copy = Path.Combine(dir, Path.GetFileName(exe));
            Directory.CreateDirectory(dir); File.Copy(exe, copy); return copy;
        }
        // Staged copies an earlier run left behind (it exited while UAC still asked), older than an hour: only folders named
        // so directly in temp.
        public static void SweepStaged() { SweepStaged(Path.GetTempPath()); }
        internal static void SweepStaged(string temp) {
            try {
                foreach (string dir in Directory.GetDirectories(temp, StagePrefix + "*"))
                    try { if (Directory.GetCreationTimeUtc(dir) < DateTime.UtcNow.AddHours(-1)) DeleteTree(dir); } catch (Exception) { }
            } catch (Exception) { }
        }
        // Deletes a folder and what is in it, through handles (Native.DeleteTree): a link is removed itself, never followed.
        internal static void DeleteTree(string dir) { Native.DeleteTree(dir); }
        // The app may stop waiting while UAC still asks: the customer ended, the session ended, the request timed out, or
        // the app exited. A Yes after that must install nothing. So each attempt creates a named event with a random nonce,
        // which it passes to the installer, and the installer goes ahead only if the event exists and is not set (Wanted).
        // It keeps the event open and checks it again before it starts the service. The event is gone when the app is,
        // unless the installer holds it. This stops a late Yes; it is no barrier against code that runs as the customer.
        public static string WantName(string sid8, string nonce) { return "Local\\SupportMcpElevate-" + sid8 + "-" + nonce; }
        public static string Nonce() {
            var b = new byte[16]; using (var rng = new System.Security.Cryptography.RNGCryptoServiceProvider()) rng.GetBytes(b);
            return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
        }
        // An installer that runs as another administrator (the credential prompt of a standard user) may only wait on it.
        // Fails when the event exists already: whoever made it first could keep it unset.
        public static EventWaitHandle Want(string sid8, string nonce) {
            var sec = new EventWaitHandleSecurity(); bool created;
            sec.AddAccessRule(new EventWaitHandleAccessRule(WindowsIdentity.GetCurrent().User, EventWaitHandleRights.FullControl, AccessControlType.Allow));
            foreach (var sid in new SecurityIdentifier[] { FullAcl.SystemSid, FullAcl.AdminsSid })
                sec.AddAccessRule(new EventWaitHandleAccessRule(sid, EventWaitHandleRights.Synchronize, AccessControlType.Allow));
            var e = new EventWaitHandle(false, EventResetMode.ManualReset, WantName(sid8, nonce), out created, sec);
            if (!created) { e.Dispose(); throw new IOException("the event of this attempt exists already"); }
            return e;
        }
        // The installer's side: the open event while the attempt still wants the install, else null.
        public static EventWaitHandle Wanted(string sid8, string nonce) {
            EventWaitHandle e;
            if (!EventWaitHandle.TryOpenExisting(WantName(sid8, nonce), EventWaitHandleRights.Synchronize, out e)) return null;
            if (!e.WaitOne(0)) return e;
            e.Dispose(); return null;
        }
        // One UAC request and the install after it, on a fresh STA thread, as ShellExecuteEx wants. Answered: the customer
        // said Yes and the installer runs. Withdraw: install nothing from now on (the installer removes what it made).
        public sealed class Attempt {
            readonly EventWaitHandle want; readonly ManualResetEvent done = new ManualResetEvent(false);
            volatile int outcome = Failed; volatile bool answered; long endedAt;
            public WaitHandle Done { get { return done; } }
            // Declined is a No within DropMs of the prompt. Windows drops an unanswered prompt after about 120 s (measured
            // on 7 and 11) and reports that as a No too; it counts as NoAnswer, which starts no cooldown.
            public int Outcome { get { return outcome; } }
            public const long DropMs = 115000;
            public long EndedAt { get { return Interlocked.Read(ref endedAt); } } // PauseClock time, set before Done
            public bool Answered { get { return answered; } }
            public void Withdraw() { try { want.Set(); } catch (ObjectDisposedException) { } }
            volatile string staged;
            // The app exits while UAC still asks: remove the staged copy (a Yes then starts nothing), as the thread cannot.
            public void Discard() { var s = staged; if (s != null && !answered) try { DeleteTree(Path.GetDirectoryName(s)); } catch (Exception) { } }
            // The app pid: the corner window until the service starts one, which the helper must not click.
            internal Attempt(string exe, string sid8, long deadline, bool connected, IntPtr owner, Action onAnswered) : this(sid8, delegate { return Stage(exe); },
                delegate(string copy, string nonce, Action answered) {
                    return Native.RunElevated(copy, "--elevate-install " + deadline.ToString(System.Globalization.CultureInfo.InvariantCulture) + (connected ? " 1 " : " 0 ")
                        + Process.GetCurrentProcess().Id.ToString(System.Globalization.CultureInfo.InvariantCulture) + " " + nonce, owner, answered);
                }, DropMs, onAnswered) { }
            // stage, run and dropMs: the tests' own.
            internal Attempt(string sid8, Func<string> stage, Func<string, string, Action, int> run, long dropMs, Action onAnswered) {
                string nonce = Nonce(); want = Want(sid8, nonce);
                var t = new Thread(delegate() {
                    try {
                        staged = stage();
                        if (want.WaitOne(0)) { outcome = NoAnswer; return; } // withdrawn while it staged: no prompt at all
                        var asked = Stopwatch.StartNew(); // the prompt's own time, without the staging
                        int code = run(staged, nonce, delegate { answered = true; onAnswered(); });
                        outcome = code == 0 ? Installed : code != -1223 ? Failed : asked.ElapsedMilliseconds >= dropMs ? NoAnswer : Declined;
                    } catch (Exception) { outcome = Failed; }
                    finally {
                        var s = staged; if (s != null) try { DeleteTree(Path.GetDirectoryName(s)); } catch (Exception) { }
                        Interlocked.Exchange(ref endedAt, PauseClock.Now()); done.Set(); want.Dispose();
                    }
                });
                t.SetApartmentState(ApartmentState.STA); t.IsBackground = true; t.Start();
            }
        }
        public static Attempt Start(string exe, string sid8, long deadline, bool connected, IntPtr owner, Action onAnswered) { return new Attempt(exe, sid8, deadline, connected, owner, onAnswered); }
    }

    // The service's side of the helper on the target session (the console session for full control). It starts the
    // helper again when that session changes or the helper exits, keeps it in a kill-on-close Job so it dies with the
    // service, and talks to it over two pipes the helper serves (operations, status), named after pipeBase. Each end
    // checks the other's process id. A Job takes the session of its first process and refuses any other, so every
    // helper gets a Job of its own. Full control runs the helper as SYSTEM; limited support (a saved PC) runs it with
    // the signed-in user's own token (token returns IntPtr.Zero when there is no such user, and then none starts).
    sealed class HelperHost {
        readonly string exe, pipeBase; readonly bool limited; IntPtr job;
        readonly Func<uint> target; readonly Func<uint, IntPtr> tokenFor;
        readonly object gate = new object(), opGate = new object();
        IntPtr process; int pid; uint session = 0xFFFFFFFF; long started;
        NamedPipeClientStream op, status;
        volatile bool stopped;
        volatile Dictionary<string, object> last; long lastAt = long.MinValue / 2;
        // The one-off full-control service: SYSTEM on the console session.
        public HelperHost(string exe, string pipeBase) : this(exe, pipeBase, Native.WTSGetActiveConsoleSessionId, Native.SystemTokenFor, false) { }
        public HelperHost(string exe, string pipeBase, Func<uint> target, Func<uint, IntPtr> tokenFor, bool limited) {
            this.exe = exe; this.pipeBase = pipeBase; this.target = target; this.tokenFor = tokenFor; this.limited = limited;
            var t = new Thread(Poll); t.IsBackground = true; t.Start();
        }
        public void Ensure() {
            uint s = target(); long now = PauseClock.Now();
            lock (gate) {
                if (stopped) return;
                bool alive = process != IntPtr.Zero && CommandJob.WaitForSingleObject(process, 0) != 0;
                if (alive && s == session && (now - Interlocked.Read(ref lastAt) < 15000 || now - started < 15000)) return;
                Kill();
                if (s == 0xFFFFFFFF) return;
                IntPtr token = tokenFor(s);
                if (token == IntPtr.Zero) return;
                try { job = CommandJob.KillOnClose(); var pi = Native.Launch(token, exe, "--helper " + Process.GetCurrentProcess().Id + " " + pipeBase + (limited ? " limited" : ""), limited, job); process = pi.Process; pid = pi.Id; session = s; started = now; }
                finally { Native.CloseHandle(token); }
                try { string name = pipeBase + "-h" + pid; op = Connect(name + "-op"); status = Connect(name + "-st"); }
                catch (Exception) { Kill(); }
            }
        }
        NamedPipeClientStream Connect(string name) {
            var c = Pipes.Client(name);
            try {
                c.Connect(15000); uint server;
                if (!Native.GetNamedPipeServerProcessId(c.SafePipeHandle, out server) || server != pid) throw new IOException("unexpected pipe server");
                return c;
            } catch (Exception) { c.Dispose(); throw; }
        }
        void Kill() { // the caller holds gate
            if (process != IntPtr.Zero) { CommandJob.TerminateProcess(process, 1); Native.CloseHandle(process); process = IntPtr.Zero; }
            if (job != IntPtr.Zero) { Native.CloseHandle(job); job = IntPtr.Zero; }
            if (op != null) { op.Dispose(); op = null; }
            if (status != null) { status.Dispose(); status = null; }
            session = 0xFFFFFFFF; last = null;
        }
        public void Stop() { lock (gate) Kill(); }
        // Stops the helper for good: a saved PC's session ended, and its poll thread ends too.
        public void Close() { lock (gate) { stopped = true; Kill(); } }
        public Dictionary<string, object> Op(Dictionary<string, object> frame) {
            NamedPipeClientStream pipe; IntPtr proc;
            lock (gate) { pipe = op; proc = process; }
            if (pipe == null) { try { Ensure(); } catch (Exception) { } lock (gate) { pipe = op; proc = process; } }
            if (pipe == null) return Wire.Map("ok", false, "error", "the screen cannot be reached right now; try again in a few seconds");
            lock (opGate) {
                // A helper that hangs is stopped, so the lane does not wait for ever. Supervise starts a new one.
                var a = frame.ContainsKey("action") ? frame["action"] as Dictionary<string, object> : null;
                int limit = 40000 + (a == null ? 0 : Wire.Text(a, "text").Length * 60 + (int)Wire.Number(a, "seconds") * 1000);
                using (new System.Threading.Timer(delegate { lock (gate) if (process == proc) Kill(); }, null, limit, Timeout.Infinite)) {
                    try { Pipes.Write(pipe, frame); return Pipes.Read(pipe, Pipes.ResultMax); }
                    catch (Exception) { lock (gate) if (process == proc) Kill(); return Wire.Map("ok", false, "error", "the screen helper stopped; try again"); }
                }
            }
        }
        void Poll() { while (!stopped) { Thread.Sleep(500); PollNow(); } }
        readonly object pollGate = new object();
        // Raised when the desktop or the block changed, so the service reports it to the relay at once.
        public event Action Changed;
        public void PollNow() {
            NamedPipeClientStream pipe; lock (gate) pipe = status;
            if (pipe == null) return;
            Dictionary<string, object> before = last, now;
            lock (pollGate) {
                try { Pipes.Write(pipe, Wire.Map("type", "status")); now = Pipes.Read(pipe, 4096, 5000); } catch (Exception) { return; }
                last = now; Interlocked.Exchange(ref lastAt, PauseClock.Now());
            }
            var changed = Changed;
            if (changed != null && (before == null || Wire.Text(before, "desktop") != Wire.Text(now, "desktop") || (Wire.Number(before, "blocked_ms") > 0) != (Wire.Number(now, "blocked_ms") > 0))) changed();
        }
        // The helper's status if it is under 3 s old: desktop, paused_ms, blocked_ms.
        public Dictionary<string, object> Status { get { var s = last; return s != null && PauseClock.Now() - Interlocked.Read(ref lastAt) < 3000 ? s : null; } }
    }

    // block_input in the helper. Only the thread that blocked input may inject input while the block lasts, and only
    // it can lift it, so one thread holds the block and runs every screen operation until it ends.
    sealed class Blocker {
        sealed class Work { public Func<Dictionary<string, object>> Run; public Dictionary<string, object> Result; public bool Ran; public readonly ManualResetEvent Done = new ManualResetEvent(false); }
        readonly BlockTimer timer = new BlockTimer(); readonly object gate = new object(); readonly Queue<Work> queue = new Queue<Work>(); readonly AutoResetEvent wake = new AutoResetEvent(false);
        Thread thread; IntPtr held; string desktop, startError; volatile bool active, off;
        public bool Active { get { return active; } }
        public long RemainingMs { get { lock (gate) return active ? timer.RemainingMs(PauseClock.Now()) : 0; } }
        public Dictionary<string, object> Set(bool on, long minutes) {
            long m = Math.Max(1, Math.Min(10, minutes));
            if (!on) { Lift(); return Wire.Map("ok", true, "text", "input is not blocked", "desktop", Screen.Desktop()); }
            lock (gate) if (active) { timer.Arm(PauseClock.Now(), m); return Wire.Map("ok", true, "text", "input stays blocked for " + m + " minutes", "desktop", Screen.Desktop()); }
            Lift();
            var ready = new ManualResetEvent(false); off = false; startError = null;
            thread = new Thread(delegate() { Hold(m, ready); }); thread.IsBackground = true; thread.Start();
            ready.WaitOne(5000);
            lock (gate) if (!active) return Wire.Map("ok", false, "error", startError ?? "Windows refused to block input");
            return Wire.Map("ok", true, "text", "input is blocked for " + m + " minutes", "desktop", Screen.Desktop());
        }
        void Lift() {
            off = true; wake.Set();
            var t = thread; if (t != null && t.Join(10000)) { thread = null; if (held != IntPtr.Zero) { Win.CloseDesktop(held); held = IntPtr.Zero; } }
        }
        void Hold(long minutes, ManualResetEvent ready) {
            held = Win.OpenInputDesktop(0, false, 0x10000000);
            try {
                if (held == IntPtr.Zero || !Win.SetThreadDesktop(held) || !Native.BlockInput(true)) { startError = "Windows refused to block input"; return; }
                lock (gate) { timer.Arm(PauseClock.Now(), minutes); desktop = Screen.DesktopName(held); active = true; }
                ready.Set();
                while (Keep()) {
                    Work w = null; lock (gate) if (queue.Count > 0) w = queue.Dequeue();
                    if (w == null) { wake.WaitOne(50); continue; }
                    w.Result = w.Run(); w.Ran = true; w.Done.Set();
                }
            } finally {
                Native.BlockInput(false);
                lock (gate) { active = false; while (queue.Count > 0) queue.Dequeue().Done.Set(); }
                ready.Set();
            }
        }
        // On the block thread: lifts the block when it must end. Ctrl+Alt+Del shows as a desktop switch, or as a
        // BlockInput(TRUE) that succeeds, because it fails while input is still blocked.
        bool Keep() {
            if (Thread.CurrentThread != thread || !active) return active;
            bool same = Screen.InputName() == desktop, still = same && !Native.BlockInput(true);
            if (same && !still) Native.BlockInput(false); // the probe blocked again after Windows had lifted it: undo that
            bool keep;
            lock (gate) { if (off) timer.Off(); keep = timer.Check(PauseClock.Now(), same, still); if (!keep) active = false; }
            if (!keep) Native.BlockInput(false);
            return keep;
        }
        // Screen.Step: between the steps of a long input on the block thread.
        public void Check() { Keep(); }
        // Runs work on the block thread while input is blocked. null when no block is held: the caller runs it.
        public Dictionary<string, object> Invoke(Func<Dictionary<string, object>> run) {
            var w = new Work { Run = run };
            lock (gate) { if (!active) return null; queue.Enqueue(w); }
            wake.Set(); w.Done.WaitOne();
            return w.Ran ? w.Result : null;
        }
        public void Stop() { Lift(); }
    }

    // --helper <service pid> <pipe base> [limited]: SYSTEM on the console session. It serves two pipes that only that
    // service may open and runs every screen operation on a thread that has switched to the input desktop (Default, or
    // Winlogon for UAC, the lock screen and the sign-in screen). It exits when the service goes away. limited: a saved
    // PC with limited support, run with the signed-in user's own token; it works on the Default desktop only, like
    // normal mode, and refuses block_input.
    public static class Helper {
        const string Sddl = "D:P(A;;GA;;;SY)";
        public static void Run(string exe, string[] args) {
            int service; if ((args.Length != 3 && args.Length != 4) || !int.TryParse(args[1], out service)) return;
            if (!System.Text.RegularExpressions.Regex.IsMatch(args[2], @"^SupportMcp[A-Za-z0-9-]{1,64}\z") || (args.Length == 4 && args[3] != "limited")) return;
            bool limited = args.Length == 4;
            string name = args[2] + "-h" + Process.GetCurrentProcess().Id;
            Screen.Full = !limited; if (!limited) Screen.OnShown = delegate(Func<Dictionary<string, object>> f) { return OnInputDesktop(f); };
            var screen = new Screen(); var blocker = new Blocker();
            screen.Blocked = delegate { return blocker.Active; }; screen.Step = blocker.Check;
            NamedPipeServerStream op = Native.PipeServer(name + "-op", Sddl, 1, true), st = Native.PipeServer(name + "-st", Sddl, 1, true);
            using (new System.Threading.Timer(delegate { Environment.Exit(1); }, null, 20000, Timeout.Infinite)) { Accept(op, service); Accept(st, service); }
            var gone = new ManualResetEvent(false);
            var status = new Thread(delegate() {
                try {
                    while (Wire.Text(Pipes.Read(st, 1024), "type") == "status") {
                        Dictionary<string, object> r;
                        try { r = OnInputDesktop(delegate { screen.Rearm(); Screen.Unstick(); long b = blocker.RemainingMs; return Wire.Map("desktop", Screen.Desktop(), "paused_ms", b > 0 ? 0 : screen.PausedForMs, "blocked_ms", b); }); }
                        catch (Exception) { r = Wire.Map("desktop", Screen.Desktop(), "paused_ms", 0, "blocked_ms", blocker.RemainingMs); } // reading the name needs no switch
                        Pipes.Write(st, r);
                    }
                } catch (Exception) { }
                gone.Set(); blocker.Stop(); Environment.Exit(0);
            });
            status.IsBackground = true; status.Start();
            try { while (true) Pipes.Write(op, Dispatch(Pipes.Read(op, 1 << 20), screen, limited ? null : blocker, gone)); } catch (Exception) { }
            gone.Set(); blocker.Stop(); Environment.Exit(0);
        }
        static void Accept(NamedPipeServerStream pipe, int service) {
            pipe.WaitForConnection(); uint pid;
            if (!Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid) || pid != service) Environment.Exit(1);
        }
        static Dictionary<string, object> Dispatch(Dictionary<string, object> frame, Screen screen, Blocker blocker, WaitHandle stop) {
            var pids = new List<int>(); object list;
            if (frame.TryGetValue("own_pids", out list) && list is System.Collections.ArrayList) foreach (object o in (System.Collections.ArrayList)list) if (o is int) pids.Add((int)o);
            Screen.OwnPids = pids.ToArray();
            var a = frame.ContainsKey("action") ? frame["action"] as Dictionary<string, object> : null;
            if (blocker == null) return OnInputDesktop(delegate { screen.Rearm(); return screen.Run(frame, stop); }); // limited: Screen.Run refuses block_input
            if (a != null && Wire.Text(a, "name") == "block_input") return blocker.Set(Wire.Flag(a, "on"), a.ContainsKey("minutes") ? Wire.Number(a, "minutes") : 10);
            return blocker.Invoke(delegate { return screen.Run(frame, stop); }) ?? OnInputDesktop(delegate { screen.Rearm(); return screen.Run(frame, stop); });
        }
        // Runs f on a new thread that has switched to the input desktop. A thread that owns windows or hooks cannot
        // switch, so every operation gets a fresh one.
        internal static T OnInputDesktop<T>(Func<T> f) {
            T result = default(T); Exception error = null; IntPtr d = Win.OpenInputDesktop(0, false, 0x10000000);
            var t = new Thread(delegate() {
                try { if (d == IntPtr.Zero || !Win.SetThreadDesktop(d)) throw new ScreenError("cannot reach the screen right now"); result = f(); }
                catch (Exception e) { error = e; }
            });
            t.IsBackground = true; t.Start(); t.Join();
            if (d != IntPtr.Zero) Win.CloseDesktop(d);
            if (error != null) throw error;
            return result;
        }
    }

    // The corner windows' pipe. Interactive users may open it, the network may not, and nobody but SYSTEM may add a
    // pipe instance (0x12008B: read and write data, read attributes and permissions, synchronize). It serves only
    // clients in the active console session, at most 2 connections per process, so a process of another user (fast
    // user switching, Remote Desktop) cannot take the 8 instances. A request is {"type":"status"} or {"type":"end"};
    // anything else, or nothing for 5 s, closes the connection.
    sealed class UiServer {
        internal const string Sddl = "D:P(A;;GA;;;SY)(A;;0x12008B;;;IU)";
        public const int Instances = 8, ReadMs = 5000, PerProcess = 2;
        // handle takes the parsed request and returns the reply to write, or null to close the connection. The
        // corner-window server (status/end) and the saved PC's server (status/allow_any_time/refresh) are both built on it.
        readonly Func<Dictionary<string, object>, uint, Dictionary<string, object>> handle; readonly Func<uint, bool> allowSession; readonly int readMax;
        readonly Dictionary<uint, long> seen = new Dictionary<uint, long>(); readonly Dictionary<uint, int> open = new Dictionary<uint, int>();
        public UiServer(string name, Func<Dictionary<string, object>> status, Action end) : this(name, status, end, delegate(uint s) { return s == Native.WTSGetActiveConsoleSessionId(); }, Sddl) { }
        // allowSession and sddl: the tests' own. Only the owner of a pipe's ACL may add instances, and the tests do not run as SYSTEM.
        internal UiServer(string name, Func<Dictionary<string, object>> status, Action end, Func<uint, bool> allowSession, string sddl)
            : this(name, StatusEnd(status, end), allowSession, sddl, 1024) { }
        // The general form: a request handler, the session gate and the SDDL.
        internal UiServer(string name, Func<Dictionary<string, object>, Dictionary<string, object>> handle, Func<uint, bool> allowSession, string sddl, int readMax)
            : this(name, delegate(Dictionary<string, object> m, uint session) { return handle(m); }, allowSession, sddl, readMax) { }
        // handle also gets the caller's session id (the saved PC's service: end_session only from the session it runs in).
        internal UiServer(string name, Func<Dictionary<string, object>, uint, Dictionary<string, object>> handle, Func<uint, bool> allowSession, string sddl, int readMax) {
            this.handle = handle; this.allowSession = allowSession; this.readMax = readMax;
            for (int i = 0; i < Instances; i++) { var pipe = Native.PipeServer(name, sddl, Instances, i == 0, true); var t = new Thread(Serve); t.IsBackground = true; t.Start(pipe); }
        }
        // The corner window's vocabulary as a handler: status or end (then status), anything else closes the connection.
        static Func<Dictionary<string, object>, Dictionary<string, object>> StatusEnd(Func<Dictionary<string, object>> status, Action end) {
            return delegate(Dictionary<string, object> m) {
                string request = Pipes.UiRequest(m);
                if (request == null) return null;
                if (request == "end") end();
                return status();
            };
        }
        void Serve(object o) {
            var pipe = (NamedPipeServerStream)o;
            while (true) {
                uint pid = 0; bool counted = false;
                try {
                    pipe.WaitForConnection(); uint session;
                    if (!Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid) || !Native.GetNamedPipeClientSessionId(pipe.SafePipeHandle, out session) || !allowSession(session)) throw new UnauthorizedAccessException();
                    lock (open) { int n; open.TryGetValue(pid, out n); if (n >= PerProcess) throw new UnauthorizedAccessException(); open[pid] = n + 1; counted = true; }
                    while (true) {
                        Dictionary<string, object> reply = handle(Pipes.Read(pipe, readMax, ReadMs), session);
                        if (reply == null) break;
                        lock (seen) seen[session] = PauseClock.Now();
                        Pipes.Write(pipe, reply);
                    }
                } catch (Exception) { }
                if (counted) lock (open) { if (--open[pid] == 0) open.Remove(pid); }
                try { pipe.Disconnect(); } catch (Exception) { return; }
            }
        }
        // A window in that session asked for status within ms.
        public bool SeenWithin(uint session, long ms) { long at; lock (seen) return seen.TryGetValue(session, out at) && PauseClock.Now() - at < ms; }
        public bool AnySeenWithin(long ms) { lock (seen) foreach (long at in seen.Values) if (PauseClock.Now() - at < ms) return true; return false; }
    }

    // The corner window's view of the full-control service, through its pipe: status every 500 ms, "end" for End
    // session. End is sent again until the service reports the session ended. When the service cannot be reached the
    // link finishes as Lost, and the window says so instead of claiming the session ended.
    public sealed class ServiceLink : ISupportLink {
        public static int EndMs = 30000; // tests shorten it
        readonly string pipe; Thread loop, ender; volatile bool finished, lost, ending; bool connected, linkUp = true; int busy;
        volatile bool paused, blocked; long expires; volatile string driver = "", access = "";
        public event Action Connected; public event Action<bool> LinkChanged; public event Action<int> BusyChanged; public event Action Finished;
        public ServiceLink(string sid8) { pipe = Backstop.Name(sid8) + "-ui"; }
        public bool Paused { get { return paused; } }
        public bool Blocked { get { return blocked; } }
        public bool Lost { get { return lost; } }
        public bool SurvivesSignOut { get { return true; } }
        public string Driver { get { return driver; } }
        public string Access { get { return access; } }
        public DateTime ExpiresLocal { get { long ms = Interlocked.Read(ref expires); return ms == 0 ? DateTime.MinValue : new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms).ToLocalTime(); } }
        static Dictionary<string, object> Ask(string name, string type, int ms) {
            using (var c = Pipes.Client(name)) { c.Connect(ms); Pipes.Write(c, Wire.Map("type", type)); return Pipes.Read(c, 4096, UiServer.ReadMs); }
        }
        // True when the service of this session answers and the session is not over.
        public static bool Running(string sid8) { try { return !Wire.Flag(Ask(Backstop.Name(sid8) + "-ui", "status", 1000), "ended"); } catch (Exception) { return false; } }
        // Sends "end" until the service says the session ended, for up to 30 s. False when that never came.
        public static bool End(string sid8) { return EndPipe(Backstop.Name(sid8) + "-ui", delegate { return false; }); }
        static bool EndPipe(string name, Func<bool> done) {
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < EndMs && !done()) {
                try { if (Wire.Flag(Ask(name, "end", 2000), "ended")) return true; } catch (Exception) { }
                Thread.Sleep(500);
            }
            return done();
        }
        public void Start() { if (loop != null) return; loop = new Thread(Loop); loop.IsBackground = true; loop.Start(); }
        void Loop() {
            var clock = Stopwatch.StartNew(); bool reached = false;
            while (!finished) {
                try {
                    using (var c = Pipes.Client(pipe)) {
                        c.Connect(2000); reached = true;
                        while (true) { Pipes.Write(c, Wire.Map("type", ending ? "end" : "status")); if (Apply(Pipes.Read(c, 4096, UiServer.ReadMs))) { Finish(false); return; } Thread.Sleep(ending ? 300 : 500); }
                    }
                } catch (Exception) {
                    // Gone without saying ended, or never there: the service cannot be reached, which is not the same as ended.
                    if (reached || clock.ElapsedMilliseconds > 30000) break;
                    Thread.Sleep(500);
                }
            }
            Finish(true);
        }
        // True when the session is over. Values of the wrong type count as false or zero.
        bool Apply(Dictionary<string, object> s) {
            object v; string a = Wire.Text(s, "access"); if (a == "ask" || a == "any") access = a; // a saved PC's session only; kept once seen, so the last words can use it
            if (Wire.Flag(s, "ended")) return true;
            long now = Client.UnixNow(), at = s.TryGetValue("expires_at", out v) && (v is int || v is long) ? Convert.ToInt64(v) : 0;
            Interlocked.Exchange(ref expires, at > now && at - now <= FullState.DayMs + 60000 ? at : 0);
            paused = Wire.Flag(s, "paused"); blocked = Wire.Flag(s, "blocked");
            driver = Wire.Clean(s.TryGetValue("driver", out v) ? v as string : null, 200); // a saved PC's session only
            int n = s.TryGetValue("busy", out v) && v is int ? Math.Max(0, (int)v) : 0;
            if (n != busy) { busy = n; var e = BusyChanged; if (e != null) e(n); }
            if (Wire.Flag(s, "connected") && !connected) { connected = true; var e = Connected; if (e != null) e(); }
            bool up = Wire.Flag(s, "link");
            if (connected && up != linkUp) { linkUp = up; var e = LinkChanged; if (e != null) e(up); }
            return false;
        }
        void Finish(bool unreachable) { lock (this) { if (finished) return; finished = true; lost = unreachable; } var f = Finished; if (f != null) f(); }
        // End session: the status loop sends "end" instead of "status" on the connection it holds, until the service
        // reports the session ended. Without that within EndMs, the link finishes as Lost.
        public void Stop() {
            if (finished || ender != null) return;
            ending = true;
            ender = new Thread(delegate() { var clock = Stopwatch.StartNew(); while (!finished && clock.ElapsedMilliseconds < EndMs) Thread.Sleep(100); Finish(true); }); ender.IsBackground = true; ender.Start();
        }
        // Before the app exits: wait until the end request is confirmed or given up.
        public void Flush(int ms) { var t = ender; if (t != null) t.Join(ms); }
    }

    // The screen side of a session that a SYSTEM service hosts (SupportService for a one-off link, DeviceService for a
    // saved PC): the helper (HelperHost), the corner window as the signed-in user, and the IFullControl calls the
    // Client makes. Full control follows the console session (or a pinned Remote Desktop session) and runs the helper
    // as SYSTEM. Limited support pins one session and the user who was signed in there when it started; the helper,
    // the corner window and every command run with that user's own token, and nothing works once another user is there.
    sealed class ScreenHost {
        public const string NoUser = "the person this session was started for is no longer signed in here";
        readonly string windowExe, windowId; readonly long windowDelayMs; readonly bool limited, pinned; readonly uint session;
        readonly SecurityIdentifier user; readonly Func<uint, IntPtr> queryUser;
        public readonly HelperHost Helper;
        public UiServer Ui;
        public Func<Client> Client = delegate { return null; };
        public int AppPid; // the one-off app that installed the service: the helper must not click it either
        public volatile bool Ended;
        readonly Stopwatch age = Stopwatch.StartNew();
        IntPtr window; int windowPid; uint windowSession = 0xFFFFFFFF; long windowStarted = long.MinValue / 2;
        // exe runs the helper, windowExe the corner window ("--window <windowId>", windowDelayMs after the start).
        // pinned: always session, not the console. limited: user must be the one signed in. queryUser: the primary
        // token of the user signed in to a session, or IntPtr.Zero (WTSQueryUserToken; the tests pass their own).
        public ScreenHost(string exe, string pipeBase, string windowExe, string windowId, long windowDelayMs, bool limited, bool pinned, uint session, SecurityIdentifier user, Func<uint, IntPtr> queryUser) {
            this.windowExe = windowExe; this.windowId = windowId; this.windowDelayMs = windowDelayMs; this.limited = limited; this.pinned = pinned; this.session = session;
            this.user = user; this.queryUser = queryUser ?? QueryUser;
            Helper = limited ? new HelperHost(exe, pipeBase, Session, UserIn, true) : new HelperHost(exe, pipeBase, Session, Native.SystemTokenFor, false);
        }
        public static IntPtr QueryUser(uint s) { IntPtr token; return s != 0xFFFFFFFF && Native.WTSQueryUserToken(s, out token) ? token : IntPtr.Zero; }
        public uint Session() { return pinned ? session : Native.WTSGetActiveConsoleSessionId(); }
        // The signed-in user's token in s, or IntPtr.Zero. Limited: only while it is still the user the session started for.
        public IntPtr UserIn(uint s) {
            IntPtr token = s == 0xFFFFFFFF ? IntPtr.Zero : queryUser(s);
            if (token == IntPtr.Zero || !limited) return token;
            bool same = false;
            try { using (var id = new WindowsIdentity(token)) same = user != null && user.Equals(id.User); } catch (Exception) { }
            if (same) return token;
            Native.CloseHandle(token); return IntPtr.Zero;
        }
        // The corner window runs as the signed-in user in their session. It starts at each sign-in, and again if it
        // closed or crashed while the session goes on. The one-off app that installed the service is the first window, so
        // that waits windowDelayMs.
        public void EnsureWindow() {
            uint s = Session(); var ui = Ui;
            if (Ended || ui == null || s == 0xFFFFFFFF || age.ElapsedMilliseconds < windowDelayMs || ui.SeenWithin(s, 4000)) return;
            if (window != IntPtr.Zero && CommandJob.WaitForSingleObject(window, 0) != 0 && windowSession == s) return;
            if (PauseClock.Now() - windowStarted < 10000) return;
            IntPtr token = UserIn(s); if (token == IntPtr.Zero) return; // the sign-in screen: nobody to show it to
            try {
                if (window != IntPtr.Zero) { Native.CloseHandle(window); window = IntPtr.Zero; }
                windowStarted = PauseClock.Now();
                var pi = Native.Launch(token, windowExe, "--window " + windowId, true, IntPtr.Zero);
                window = pi.Process; windowPid = pi.Id; windowSession = s;
            } finally { Native.CloseHandle(token); }
        }
        public string UserName {
            get {
                IntPtr token = UserIn(Session());
                if (token == IntPtr.Zero) return "SYSTEM";
                try { using (var id = new WindowsIdentity(token)) { string n = id.Name; return n.Substring(n.LastIndexOf('\\') + 1); } } finally { Native.CloseHandle(token); }
            }
        }
        public Dictionary<string, object> ScreenOp(Dictionary<string, object> frame, WaitHandle stop) {
            var a = frame.ContainsKey("action") ? frame["action"] as Dictionary<string, object> : null;
            if (limited) {
                // Limited support: the user's own helper does the screen; nothing that needs SYSTEM.
                if (Wire.Text(frame, "type") == "control") return Wire.Map("ok", false, "error", "this PC is set to limited support; only the person at the PC can choose full control, in the setup");
                string n = a == null ? "" : Wire.Text(a, "name");
                if (n == "block_input" || n == "send_sas") return Wire.Map("ok", false, "error", Screen.NoFull);
            } else if (Wire.Text(frame, "type") == "control") return Wire.Map("ok", true, "control", "full", "text", "full control is already on");
            // The own-window guard covers the corner window this service started and the app that installed it, nothing else.
            var pids = new List<int>(); if (windowPid != 0) pids.Add(windowPid); if (AppPid != 0) pids.Add(AppPid);
            if (a != null && Wire.Text(a, "name") == "send_sas") {
                // SendSAS works from a service only, with SoftwareSASGeneration allowing it (the install sets it). Windows
                // drops it without an error otherwise, so check first: the install may have skipped the share (SasShare.Locked).
                bool allowed; using (var hklm = SasShare.Machine()) allowed = SasShare.Allowed(hklm);
                if (!allowed) return Wire.Map("ok", false, "error", SasShare.Refused);
                string error = Native.SendSas(); if (error != null) return Wire.Map("ok", false, "error", error);
                stop.WaitOne(1500);
                bool shot = !a.ContainsKey("screenshot") || Wire.Flag(a, "screenshot");
                var sas = Helper.Op(Wire.Map("type", "screen", "own_pids", pids, "action", Wire.Map("name", shot ? "screenshot" : "wait", "seconds", 0.1, "screenshot", false, "display", Wire.Number(a, "display"))));
                Helper.PollNow();
                // Ctrl+Alt+Del went out: a failed screenshot after it does not make the action fail.
                return Wire.Flag(sas, "ok") ? sas : Wire.Map("ok", true, "text", "Ctrl+Alt+Del sent; no screenshot: " + Wire.Text(sas, "error"));
            }
            var forward = new Dictionary<string, object>(frame); forward["own_pids"] = pids;
            var result = Helper.Op(forward);
            Helper.PollNow(); // the desktop and the block as they are now, for the next poll
            if (a != null && Wire.Text(a, "name") == "block_input" && Wire.Flag(result, "ok")) {
                var st = Helper.Status; var c = Client(); long left = st == null ? 0 : Wire.Number(st, "blocked_ms");
                result["input_blocked_until"] = left > 0 && c != null ? global::SupportMcp.Client.UnixNow() + c.ServerOffsetMs + left : (object)null;
            }
            return result;
        }
        // Full control: the signed-in user's token, the elevated one when they are an administrator. Limited: the
        // user's own token as Windows gave it (filtered for an administrator), never the elevated one.
        public IntPtr UserToken(out string profile) {
            uint s = Session(); IntPtr token = UserIn(s);
            if (limited) { if (token == IntPtr.Zero) throw new ArgumentException(NoUser); profile = Native.Profile(token); return token; }
            bool signedIn = token != IntPtr.Zero;
            if (TokenChoice.Pick(false, signedIn, 0) == RunAs.Nobody) throw new ArgumentException(TokenChoice.NobodySignedIn);
            if (TokenChoice.Pick(false, true, Native.ElevationType(token)) == RunAs.ElevatedUser) {
                IntPtr linked = Native.Linked(token);
                if (linked != IntPtr.Zero) { Native.CloseHandle(token); token = linked; }
            }
            profile = Native.Profile(token);
            return token;
        }
        public void Report(Dictionary<string, object> poll, long serverOffsetMs) {
            var s = Helper.Status;
            long now = global::SupportMcp.Client.UnixNow() + serverOffsetMs, paused = s == null ? 0 : Wire.Number(s, "paused_ms"), blocked = s == null ? 0 : Wire.Number(s, "blocked_ms");
            poll["desktop"] = s == null ? "unknown" : Wire.Text(s, "desktop");
            poll["paused_until"] = paused > 0 ? now + paused : (object)null;
            poll["input_blocked_until"] = blocked > 0 ? now + blocked : (object)null;
        }
        // The session is over: the helper stops for good and the corner window is let go (it reads "ended" and closes).
        public void Close() {
            Ended = true; Helper.Close();
            if (window != IntPtr.Zero) { Native.CloseHandle(window); window = IntPtr.Zero; }
        }
    }

    // --service: the temporary LocalSystem service of one full-control session.
    public sealed class SupportService : ServiceBase, IFullControl {
        readonly string exe, sid8, folder; readonly Dictionary<string, object> config;
        readonly object gate = new object(), superviseGate = new object();
        FullState state; Client client; Thread worker; ScreenHost host; UiServer ui; System.Threading.Timer timer;
        volatile bool shutdown, stopping, ended, connected, linkUp = true, backstopDue; int busy, cleaned;
        public SupportService(string exe, Dictionary<string, object> cfg) {
            this.exe = exe; config = cfg; sid8 = FullInstall.Sid8(cfg); folder = Path.GetDirectoryName(exe);
            ServiceName = Backstop.Name(sid8); CanStop = true; CanShutdown = true; CanHandleSessionChangeEvent = true; AutoLog = false;
        }
        protected override void OnStart(string[] args) { worker = new Thread(Work); worker.IsBackground = true; worker.Start(); }
        // An explicit stop (the backstop task, an administrator) ends the session like End session does.
        protected override void OnStop() {
            stopping = true; RequestAdditionalTime(30000);
            var c = client; if (c != null) c.Stop();
            if (worker != null && worker != Thread.CurrentThread) worker.Join(25000);
            Cleanup();
        }
        // Windows shuts down or restarts: keep everything, so the session goes on after the restart.
        protected override void OnShutdown() {
            shutdown = true; var c = client; if (c != null) { c.EndRemote = false; c.Stop(); }
            if (worker != null) worker.Join(5000);
            if (host != null) host.Helper.Stop();
        }
        // Sign-in, sign-out, lock and a console switch: the helper and the window follow the console session.
        protected override void OnSessionChange(SessionChangeDescription change) { ThreadPool.QueueUserWorkItem(delegate { Supervise(); }); }
        void Work() {
            try {
                // Layer 2: the service's own clock. A deadline that passed while the PC was off ends it before it connects.
                state = FullState.Load(folder);
                if (state != null && state.Sid == Wire.Text(config, "sid") && !FullState.Expired(state.Deadline, Client.UnixNow()) && !stopping) {
                    ui = new UiServer(Backstop.Name(sid8) + "-ui", UiStatus, delegate { var c = client; if (c != null) c.Stop(); });
                    host = new ScreenHost(exe, Backstop.Name(sid8), Path.Combine(folder, "window.exe"), sid8, 10000, false, false, 0, null, null) { Ui = ui, AppPid = state.AppPid };
                    host.Client = delegate { return client; };
                    host.Helper.Changed += delegate { var c = client; if (c != null) c.Nudge(); }; // an escape or a desktop switch reaches the relay at once
                    var cfg = new Dictionary<string, object>(config); cfg["startup_ms"] = state.Deadline - Client.UnixNow(); cfg.Remove("startup_expires_at");
                    client = new Client(cfg, FullState.DayMs) { Full = this, WorkRoot = folder };
                    client.Connected += delegate { connected = true; };
                    client.LinkChanged += delegate(bool up) { linkUp = up; };
                    client.BusyChanged += delegate(int n) { Thread.VolatileWrite(ref busy, n); };
                    timer = new System.Threading.Timer(delegate { Supervise(); }, null, 0, 2000);
                    if (!stopping) client.Run();
                }
            } catch (Exception) { }
            if (shutdown) return;
            Cleanup();
            if (!stopping) new Thread(delegate() { try { Stop(); } catch (Exception) { } }).Start();
        }
        void Supervise() {
            if (!Monitor.TryEnter(superviseGate)) return;
            try {
                if (ended || shutdown || host == null) return;
                if (FullState.Expired(state.Deadline, Client.UnixNow())) { var c = client; if (c != null) c.Stop(); return; }
                if (backstopDue) { Backstop.Register(sid8, folder, state); backstopDue = false; }
            } catch (Exception) { } finally { Monitor.Exit(superviseGate); }
            try { host.Helper.Ensure(); } catch (Exception) { }
            try { if (!ended) host.EnsureWindow(); } catch (Exception) { }
        }
        Dictionary<string, object> UiStatus() {
            var s = host == null ? null : host.Helper.Status; var c = client;
            return Wire.Map("connected", connected, "link", linkUp, "busy", Thread.VolatileRead(ref busy), "paused", s != null && Wire.Number(s, "paused_ms") > 0,
                "blocked", s != null && Wire.Number(s, "blocked_ms") > 0, "expires_at", c == null ? 0 : c.ExpiresAtMs, "ended", ended);
        }
        // IFullControl: the screen side is the ScreenHost, on the console session as SYSTEM.
        public bool Limited { get { return false; } }
        public string UserName { get { return host.UserName; } }
        public Dictionary<string, object> ScreenOp(Dictionary<string, object> frame, WaitHandle stop) { return host.ScreenOp(frame, stop); }
        public IntPtr UserToken(out string profile) { return host.UserToken(out profile); }
        public void Report(Dictionary<string, object> poll, long serverOffsetMs) { host.Report(poll, serverOffsetMs); }
        public void Welcomed(long expiresAtMs) {
            lock (gate) {
                long d = FullState.OnWelcome(state.Deadline, state.Welcomed, expiresAtMs, Client.UnixNow());
                if (d == state.Deadline && state.Welcomed) return;
                state.Deadline = d; state.Welcomed = true;
                try { state.Save(folder); } catch (Exception) { }
                backstopDue = true;
            }
            ThreadPool.QueueUserWorkItem(delegate { Supervise(); });
        }
        // Layer 1: the end of the session (operator, customer, relay alarm, expiry). Open windows read "ended" and close
        // themselves; then the helper, this session's share of the registry value and the service registration go, and
        // a detached cmd removes the folder once this process has exited and then the backstop task, last. None of it
        // depends on state.json, so a damaged one cannot stop the registry value from being put back.
        void Cleanup() {
            if (Interlocked.Exchange(ref cleaned, 1) != 0) return;
            ended = true;
            if (timer != null) timer.Dispose();
            if (host != null) host.Ended = true;
            if (ui != null && ui.AnySeenWithin(3000)) Thread.Sleep(1500);
            if (host != null) host.Helper.Stop();
            bool released = false;
            try { using (var hklm = SasShare.Machine()) released = SasShare.Release(hklm, ServiceName); } catch (Exception) { }
            Scm.Delete(ServiceName);
            // A share that was not released keeps the backstop task, which releases it at the deadline.
            FullInstall.RemoveLater(!released ? new List<string>() : state != null ? new List<string> { state.Task } : Backstop.Tasks(sid8), folder);
        }
    }

    // request_full_control's two limits: one prompt at a time, and none within a minute of a declined one, so the operator
    // cannot nag the customer. A decline is UAC No or Don't allow, at the first start or on a request; a failure is not one.
    public sealed class FullRequestGate {
        public const long CooldownMs = 60000;
        public const string Cooling = "the customer declined full control less than a minute ago; ask them first, then try again";
        public const string Waiting = "a request for full control is already waiting for the customer";
        public const string StillOpen = "the Windows permission prompt of an earlier request is still open; ask the customer to answer it, then try again";
        long declinedAt = long.MinValue / 2; int requesting;
        sealed class Open { public WaitHandle Done; public Func<int> Outcome; public Func<long> EndedAt; }
        Open open;
        // Every elevation outcome goes through here, so a decline at the first start counts as much as a later one.
        public void Record(int outcome, long now) { if (outcome == Elevation.Declined) Interlocked.Exchange(ref declinedAt, now); }
        // A UAC prompt the app stopped waiting for stays on screen until the customer answers it or Windows drops it. Until
        // then no new prompt, so there is only ever one; once it ended, its outcome counts first, at the time it ended
        // (endedAt is set before done), so a No on it starts the cooldown before the next request can ask.
        public void Leave(WaitHandle done, Func<int> outcome, Func<long> endedAt) { Interlocked.Exchange(ref open, new Open { Done = done, Outcome = outcome, EndedAt = endedAt }); }
        public Dictionary<string, object> Request(Func<Dictionary<string, object>> ask, long now) {
            var left = Volatile.Read(ref open);
            if (left != null) {
                if (!left.Done.WaitOne(0)) return Wire.Map("ok", false, "error", StillOpen);
                Record(left.Outcome(), left.EndedAt()); Interlocked.CompareExchange(ref open, null, left);
            }
            if (now - Interlocked.Read(ref declinedAt) < CooldownMs) return Wire.Map("ok", false, "error", Cooling);
            if (Interlocked.CompareExchange(ref requesting, 1, 0) != 0) return Wire.Map("ok", false, "error", Waiting);
            try { return ask(); } finally { Interlocked.Exchange(ref requesting, 0); }
        }
    }

    // The customer's app from its first start: full control first, the fallback to normal mode, and the handover of a
    // normal-mode session to the service after request_full_control.
    sealed class StartFlow {
        readonly SupportWindow window; readonly Dictionary<string, object> config; readonly string exe, sid8; readonly long connectBy;
        Thread thread, clientThread, ender; Client client; ServiceLink link; Mutex windowMutex; volatile Elevation.Attempt stale;
        readonly FullRequestGate gate = new FullRequestGate();
        public StartFlow(SupportWindow window, Dictionary<string, object> config, string exe, long connectBy) {
            this.window = window; this.config = config; this.exe = exe; this.connectBy = connectBy; sid8 = FullInstall.Sid8(config);
        }
        // The sweep never runs with administrator rights: an unelevated start removes old staged copies just as well.
        public void Begin() { if (!SupportAccess.IsAdministrator()) Elevation.SweepStaged(); thread = new Thread(Run); thread.IsBackground = true; thread.Start(); }
        // After the window closed: finish an install in progress (it ends the service if the customer ended), stop the client.
        public void Finish() {
            if (thread != null) thread.Join(120000);
            var s = stale; if (s != null) s.Discard();
            if (ender != null) ender.Join(35000);
            if (client != null) { client.Stop(); if (clientThread != null) clientThread.Join(20000); }
            if (link != null) link.Flush(3000);
        }
        // After the window closed these do nothing. Invoke on a dispatcher that shut down throws TaskCanceledException, which
        // would end this thread before it ends a service the customer no longer wants (EndOrWarn).
        T Ui<T>(Func<T> f) { try { return window.Dispatcher.HasShutdownStarted ? default(T) : window.Dispatcher.Invoke(f); } catch (OperationCanceledException) { return default(T); } }
        void Ui(Action a) { try { if (!window.Dispatcher.HasShutdownStarted) window.Dispatcher.Invoke(a); } catch (OperationCanceledException) { } }
        bool Ask(string heading, string text, bool warning) { return !window.EndedByCustomer && Ui(delegate { return ConsentDialog.Ask(heading, text, warning); }); }
        // The customer ended the session while the install ran: end the new service, and say so if that cannot be confirmed.
        void EndOrWarn() {
            if (!ServiceLink.End(sid8)) WF.MessageBox.Show("Cannot reach the support service. Support may still have access until the session ends by itself. Tell support.", "Remote support");
        }
        void Run() {
            try {
                // Opened again while this session has full control: be its window.
                if (ServiceLink.Running(sid8)) { Ui(BecomeWindow); return; }
                Consent path = ConsentPath.Detect();
                int outcome = path == Consent.Unavailable ? Elevation.Declined : Elevate(path, connectBy, false, delegate { return false; });
                if (path != Consent.Unavailable) gate.Record(outcome, PauseClock.Now()); // no request_full_control when Unavailable
                if (window.EndedByCustomer) { if (outcome == Elevation.Installed) EndOrWarn(); return; }
                if (window.Dispatcher.HasShutdownStarted) return; // the window closed (Windows signs out)
                if (outcome == Elevation.Installed) { Ui(BecomeWindow); return; }
                // UAC No, a failure, Don't allow, or a prompt Windows dropped after two minutes (NoAnswer, no cooldown):
                // limited support, if the customer wants it. Don't allow is the default.
                bool admin = SupportAccess.IsAdministrator();
                if (!Ask(SupportAccess.LimitedHeading, SupportAccess.LimitedText + (admin ? SupportAccess.LimitedAdmin : ""), admin)) { Ui(window.CloseQuietly); return; }
                Ui(delegate { StartNormal(admin, path != Consent.Unavailable); });
            } catch (Exception e) { Ui(delegate { WF.MessageBox.Show(e.Message, "Remote support"); window.CloseQuietly(); }); }
        }
        // The full-control question, then --elevate-install. Windows shows its UAC prompt on the secure desktop only when the
        // app that asks is in the foreground; otherwise it parks it as a flashing taskbar button that customers miss. An app in
        // the background cannot take the foreground (request_full_control, or a start from Explorer or a download), but the
        // customer's click on Allow gives it to the dialog. So before UAC the dialog stays open as the prompt's owner, saying
        // that Windows asks now, until UAC is answered. When no prompt will appear, the dialog is the consent and closes.
        // The dialog is modeless, so End session in the corner window works throughout. The wait ends when the customer
        // ended, the window closed or giveUp says so; an unanswered UAC prompt is then withdrawn (NoAnswer). After Yes only
        // End session withdraws, and the install that already runs is waited for, so the caller can end what it made.
        int Elevate(Consent path, long deadline, bool connected, Func<bool> giveUp) { bool withdrew; return Elevate(path, deadline, connected, giveUp, out withdrew); }
        // withdrew: the wait ended early (see above); an install that finished anyway is then not wanted.
        int Elevate(Consent path, long deadline, bool connected, Func<bool> giveUp, out bool withdrew) {
            withdrew = false;
            if (window.EndedByCustomer) return Elevation.Declined;
            var dialog = Ui(delegate { return ConsentDialog.Open(path == Consent.Prompt); });
            if (dialog == null) return Elevation.NoAnswer;
            Func<bool> over = delegate { return window.EndedByCustomer || window.Dispatcher.HasShutdownStarted || giveUp(); };
            Action close = delegate { if (!dialog.Dispatcher.HasShutdownStarted) dialog.Dispatcher.BeginInvoke(new Action(dialog.Finish)); };
            try {
                while (!dialog.Decided.WaitOne(250)) if (over()) return Elevation.NoAnswer;
                if (!dialog.Allowed) return Elevation.Declined;
                if (over()) return Elevation.NoAnswer;
                IntPtr owner = Ui(delegate { return path == Consent.Prompt ? new WindowInteropHelper(dialog).Handle : new WindowInteropHelper(window).Handle; });
                // Once UAC is answered the question has done its work: it goes, and the corner window shows the install.
                Elevation.Attempt attempt;
                try { attempt = Elevation.Start(exe, sid8, deadline, connected, owner, close); } catch (Exception) { return Elevation.Failed; }
                while (!attempt.Done.WaitOne(250)) {
                    // After Yes only the customer's End session withdraws: the old client stops by itself when the new
                    // service says hello, and a sign-out (it ends this app) keeps full control, as a restart does, because
                    // the installer already holds the event.
                    if (withdrew || !(attempt.Answered ? window.EndedByCustomer : over())) continue;
                    attempt.Withdraw(); withdrew = true;
                    if (!attempt.Answered) { stale = attempt; var a = attempt; gate.Leave(a.Done, delegate { return a.Outcome; }, delegate { return a.EndedAt; }); return Elevation.NoAnswer; }
                }
                return attempt.Outcome;
            } finally { close(); }
        }
        void StartNormal(bool admin, bool canElevate) {
            window.SetAccess(admin, admin ? null : SupportAccess.NoAdminNote);
            client = new Client(config) { CanElevate = canElevate };
            if (canElevate) client.RequestFull = RequestFull;
            window.Bind(client);
            clientThread = new Thread(client.Run); clientThread.IsBackground = true; clientThread.Start();
        }
        // request_full_control, on the client's screen lane. On success the service has said hello, which answers the
        // operator; this client then stops without sending anything and the window shows the service.
        Dictionary<string, object> RequestFull() { return gate.Request(AskFull, PauseClock.Now()); }
        // The relay answers the operator after 120 s; the question goes a little before, so a new request finds it gone.
        public const long AnswerMs = 110000;
        Dictionary<string, object> AskFull() {
            Consent path = ConsentPath.Detect();
            if (path == Consent.Unavailable) return Wire.Map("ok", false, "error", "this Windows account cannot get administrator rights, so full control is not possible");
            Ui(delegate { window.Hold(true); });
            int outcome = Elevation.Failed; bool withdrew = false; var asked = Stopwatch.StartNew();
            try { outcome = Elevate(path, client.ExpiresAtMs, true, delegate { return client.Stopped || asked.ElapsedMilliseconds > AnswerMs; }, out withdrew); }
            finally {
                if (outcome == Elevation.Installed) {
                    // The service takes over from this client (whose run ends when the service says hello), unless this app had
                    // already stopped waiting (the session ended, the customer ended, no answer in time): then it is ended again.
                    if (withdrew || window.EndedByCustomer) EndOrWarn();
                    else { client.EndRemote = false; client.Stop(); Ui(BecomeWindow); }
                }
                Ui(delegate { window.Hold(false); });
            }
            if (outcome == Elevation.Installed) return null;
            gate.Record(outcome, PauseClock.Now()); // a decline starts the cooldown, no answer does not
            return Wire.Map("ok", false, "error", outcome == Elevation.Declined ? "the customer declined full control"
                : outcome == Elevation.NoAnswer ? "the customer did not answer the request for full control" : "full control could not be set up on this PC");
        }
        void BecomeWindow() {
            if (window.EndedByCustomer) { ender = new Thread(EndOrWarn); ender.Start(); return; }
            bool mine; windowMutex = new Mutex(true, "Local\\SupportMcpWindow-" + sid8, out mine);
            if (!mine) { window.CloseQuietly(); return; } // the service already started the window
            window.SetAccess(false, null);
            link = new ServiceLink(sid8); window.Bind(link); link.Start();
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
    // A button in a window that never takes the focus (the corner window) must not be focusable: a click would move the keyboard
    // focus into the window and activate it. Buttons of a dialog or confirm that is activated on purpose pass focusable: true,
    // so Tab, Enter and screen readers reach them.
    public sealed class FlatButton : Button {
        readonly Brush rest, hover;
        public FlatButton(object content, Brush foreground, Brush rest, Brush hover, Brush focusRing, double height, double minWidth, double padding, double radius, double fontSize, bool focusable = false) {
            this.rest = rest; this.hover = hover;
            Content = content; Foreground = foreground; Background = rest; Height = height; MinWidth = minWidth;
            Padding = new Thickness(padding, 0, padding, 0); FontSize = fontSize; FontWeight = FontWeights.SemiBold;
            Cursor = Cursors.Hand; Focusable = focusable; FocusVisualStyle = null; BorderThickness = new Thickness(0);
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

    // The window the customer sees while support is connected. Bind gives it the session to show: the normal-mode
    // Client, or the full-control service through ServiceLink.
    public sealed class SupportWindow : Window {
        const double CardWidth = 336, Gap = 12, Pad = 20;
        ISupportLink link;
        readonly Palette p;
        readonly bool preparing;
        public volatile bool Preserve;
        // Set when the customer ended the session, so a full-control install still running can end the service it made.
        public volatile bool EndedByCustomer;
        bool connectedOnce, linkOk = true, busy, paused, blocked, workShown, ended, tucked, confirming, sessionEnding, sweeping, userMoved, placing, held, heldEnd, ending, lostEnd;
        string driver = "", access = ""; // a saved PC's session: who drives it, shown in the heading, and its access setting
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

        public SupportWindow(Palette palette, bool administrator, bool preparing, string note) {
            this.p = palette; this.preparing = preparing;
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
            adminLine = Ui.Label("Running with administrator rights.", 12.5, FontWeights.Normal, p.Stop, Ui.TextFont); adminLine.Margin = new Thickness(0, 6, 0, 0);
            text.Children.Add(adminLine);
            noteLine = Ui.Label("", 12, FontWeights.Normal, p.Muted, Ui.TextFont); noteLine.Margin = new Thickness(0, 6, 0, 0);
            text.Children.Add(noteLine);
            this.administrator = administrator; noteLine.Text = note ?? "";
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
            keep = new FlatButton("Keep connected", p.Ink, Brushes.Transparent, p.Surface2, p.Work, 32, 0, 12, 6, 13, true);
            sure = new FlatButton("End session", Brushes.White, p.StopSolid, p.StopSolidHover, p.Work, 32, 0, 14, 6, 13, true); sure.Margin = new Thickness(8, 0, 0, 0);
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

            collapse.Click += delegate { tucked = true; if (confirming) KeepConnected(); else Render(); };
            expand.Click += delegate { tucked = false; Render(); };
            endButton.Click += delegate { AskToEnd(); };
            tuckEnd.Click += delegate { AskToEnd(); };
            keep.Click += delegate { KeepConnected(); };
            // Full control: the session is over only when the service confirms it (or the window says it cannot reach it).
            sure.Click += delegate {
                EndedByCustomer = true;
                if (link == null || !link.SurvivesSignOut) { if (link != null) link.Stop(); ShowEnded(); return; }
                ending = true; confirming = false; link.Stop(); Render();
            };
            PreviewKeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Escape && confirming) { KeepConnected(); e.Handled = true; } };

            tick.Interval = TimeSpan.FromSeconds(1); tick.Tick += delegate { UpdateTimer(); };
            pause.Interval = TimeSpan.FromMilliseconds(250);
            pause.Tick += delegate {
                bool now = link != null && link.Paused, locked = link != null && link.Blocked; string who = link != null ? link.Driver ?? "" : "", how = link != null ? link.Access ?? "" : "";
                if (how.Length > 0) access = how;
                if (now != paused || locked != blocked || who != driver) { paused = now; blocked = locked; driver = who; Render(); }
            };
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

            // The window never takes the keyboard focus when it appears or changes, so support can type into the app the customer was
            // using. Clicks on its buttons still work without activating it. Only AskToEnd activates it, after the customer asked to end.
            // APPWINDOW keeps its taskbar button, so the taskbar's Close and Alt+F4 still reach OnClosing and ask "End the session?".
            ShowActivated = false;
            SourceInitialized += delegate { IntPtr h = new WindowInteropHelper(this).Handle; Win.SetWindowLong(h, -20, Win.GetWindowLong(h, -20) | unchecked((int)(Win.NoActivate | Win.AppWindow))); };
            // The corner window's buttons are not focusable (FlatButton), so a click cannot activate it. The two buttons of the
            // confirm are, so the customer can answer it from the keyboard. Leaving the window while the confirm is open forgets
            // the window to go back to: a later Keep must not pull the focus to an older window.
            Deactivated += delegate { if (confirming) returnTo = IntPtr.Zero; };
            Closing += OnClosing;
            if (Application.Current != null)
                Application.Current.SessionEnding += delegate(object sender, SessionEndingCancelEventArgs e) { sessionEnding = true; };

        }
        bool administrator;

        // Link threads post to the UI thread only; nothing here shows commands or paths. Events of a link that was
        // replaced (request_full_control hands the session from the Client to the service) are ignored.
        public void Bind(ISupportLink l) {
            link = l; heldEnd = false;
            l.Connected += delegate { Post(delegate { if (link == l) OnConnected(); }); };
            l.LinkChanged += delegate(bool up) { Post(delegate { if (link == l) OnLink(up); }); };
            l.BusyChanged += delegate(int count) { Post(delegate { if (link == l) OnBusy(count > 0); }); };
            l.Finished += delegate { Post(delegate { if (link != l) return; if (held) heldEnd = true; else ShowEnded(); }); };
            Render();
        }
        // While the app asks for full control, an end of the current link waits: the service may be taking over.
        public void Hold(bool on) { held = on; if (!on && heldEnd) { heldEnd = false; ShowEnded(); } }
        public void SetAccess(bool administrator, string note) { this.administrator = administrator; noteLine.Text = note ?? ""; Render(); }
        // A session that never started (Don't allow, or another window already shows it) closes without a message.
        public void CloseQuietly() { ended = true; Close(); }

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
            if (connectedOnce || ended) { Render(); return; }
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

        // The window that had the focus before the confirm took it (never one of ours), with its process and thread ids so
        // KeepConnected can tell that the handle still belongs to the same window.
        IntPtr returnTo; uint returnPid, returnThread;
        internal void AskToEnd() {
            if (ended) return;
            if (!confirming) {
                IntPtr fg = Win.GetForegroundWindow();
                returnTo = FocusReturn.Ours(fg) ? IntPtr.Zero : fg;
                returnThread = returnTo == IntPtr.Zero ? 0 : Win.GetWindowThreadProcessId(returnTo, out returnPid);
            }
            tucked = false; confirming = true; Render();
            UpdateLayout(); Activate(); keep.Focus();
        }
        // Keep connected, Escape, or tucking the window: close the confirm and give the focus back to where it came from.
        internal void KeepConnected() {
            confirming = false; Render();
            uint pid = returnPid, thread = returnThread;
            IntPtr back = FocusReturn.Target(returnTo, Win.GetForegroundWindow(), FocusReturn.Ours, delegate(IntPtr w) { return FocusReturn.Usable(w, pid, thread); });
            returnTo = IntPtr.Zero;
            if (back != IntPtr.Zero) Win.SetForegroundWindow(back);
        }
        // The last words. A one-off link cannot be used again, so support can no longer reach the PC. A saved PC can be
        // reached again later: any time, or only after it asks the person here.
        internal static string EndedText(string clock, string access) {
            string head = "Session ended after " + clock + ". ";
            if (access == "any") return head + "Your support team can connect again later.";
            if (access == "ask") return head + "Your support team will ask you before connecting again.";
            return head + "Support can no longer reach this PC.";
        }
        void ShowEnded() {
            if (ended) return;
            string how = link != null ? link.Access ?? "" : ""; if (how.Length > 0) access = how;
            ended = true; endedAfter = session.Elapsed; session.Stop(); tick.Stop(); pause.Stop(); hold.Stop(); paused = false; blocked = false;
            confirming = false; tucked = false; workShown = false; busy = false;
            lostEnd = link != null && link.Lost;
            Render(); if (!lostEnd) closer.Start();
        }
        void OnClosing(object sender, System.ComponentModel.CancelEventArgs e) {
            // User close (End session, Alt+F4, taskbar Close) asks inline first.
            // Windows shutdown and an already ended session close without asking.
            if (!ended && !sessionEnding) { e.Cancel = true; AskToEnd(); return; }
            if (link == null || (sessionEnding && link.SurvivesSignOut)) return; // full control goes on after a sign-out or restart
            var client = link as Client;
            if (preparing && !ended && sessionEnding && client != null) { Preserve = true; client.EndRemote = false; }
            link.Stop();
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

            head.Text = ended ? (lostEnd ? "Cannot reach the support service." : "Support is disconnected.") : ending ? "Ending the session..." : !connectedOnce ? "Connecting to support..." : !linkOk ? "Reconnecting to support..." : driver.Length > 0 ? driver + " is connected to this PC." : "A remote support agent is connected to your machine.";
            status.Inlines.Clear(); timerRun = null;
            if (ended && lostEnd) {
                status.Inlines.Add(new Run("Support may still have access until the session ends by itself. Tell support."));
            } else if (ended) {
                status.Inlines.Add(new Run(EndedText(Ui.Clock(endedAfter), access)));
            } else if (!connectedOnce) {
                status.Inlines.Add(new Run("This window stays open while support is connected."));
            } else if (blocked && linkOk) {
                status.Inlines.Add(new Run("Support has locked your mouse and keyboard. Press Ctrl+Alt+Del to unlock.") { FontWeight = FontWeights.SemiBold, Foreground = p.Ink });
            } else if (paused && linkOk) {
                status.Inlines.Add(new Run("Paused while you use the PC") { FontWeight = FontWeights.SemiBold, Foreground = p.Ink });
            } else if (working) {
                status.Inlines.Add(new Run("Support is working on your PC") { FontWeight = FontWeights.SemiBold, Foreground = p.Ink });
            } else {
                status.Inlines.Add(new Run(linkOk ? "Connected for " : "Trying again. Session time "));
                timerRun = new Run(Ui.Clock(session.Elapsed)) { Foreground = p.Ink, FontFamily = new FontFamily(Ui.MonoFont), FontSize = 12 };
                status.Inlines.Add(timerRun);
            }
            DateTime expires = link != null ? link.ExpiresLocal : DateTime.MinValue;
            until.Text = connectedOnce && expires != DateTime.MinValue ? "Ends by itself " + expires.ToString("ddd d MMM, HH:mm", System.Globalization.CultureInfo.InvariantCulture) : "";
            tuckTitle.Text = working ? "Support is working" : "Remote support";
            tuckTimer.Text = connectedOnce ? Ui.Clock(session.Elapsed) : "";

            // Once the session has ended these lines would be stale.
            adminLine.Visibility = ended || !administrator ? Visibility.Collapsed : Visibility.Visible;
            noteLine.Visibility = ended || noteLine.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;

            bool small = tucked && !ended;
            card.Width = small ? Double.NaN : CardWidth;
            fullView.Visibility = small ? Visibility.Collapsed : Visibility.Visible;
            tuckView.Visibility = small ? Visibility.Visible : Visibility.Collapsed;
            collapse.Visibility = ended ? Visibility.Hidden : Visibility.Visible;
            normalFoot.Visibility = (!ended && !confirming) || lostEnd ? Visibility.Visible : Visibility.Collapsed;
            endButton.Visibility = ended || ending ? Visibility.Collapsed : Visibility.Visible;
            askBox.Visibility = askFoot.Visibility = !ended && confirming ? Visibility.Visible : Visibility.Collapsed;
        }
    }

    // Consent prompt in the same visual language. "Don't allow" is the default.
    public sealed class ConsentDialog : Window {
        bool allowed, held, finished, closed;
        readonly bool holds;
        // Set when the customer answered: Don't allow (the dialog closed) or Allow (closed, or held open before UAC).
        public readonly ManualResetEvent Decided = new ManualResetEvent(false);
        public bool Allowed { get { return allowed; } }
        public static bool Ask(string message, bool administrator) { return Ask("Allow remote support?", message, administrator); }
        // administrator: the warning look, for a grant of administrator rights or of full control.
        public static bool Ask(string heading, string message, bool administrator) {
            var dialog = new ConsentDialog(Palette.Detect(), heading, message, administrator, false);
            dialog.ShowDialog();
            return dialog.allowed;
        }
        // The full-control question, shown modeless so the corner window (End session) stays usable. beforeUac: Allow keeps
        // it open and says that Windows asks now; Finish closes it.
        public static ConsentDialog Open(bool beforeUac) {
            var d = new ConsentDialog(Palette.Detect(), SupportAccess.FullHeading, SupportAccess.FullText, true, beforeUac); d.Show(); return d;
        }
        // A saved PC's question (DeviceAsk): as Ask, and after ms with no answer it closes as Don't allow.
        public static bool AskTimed(string heading, string message, bool warning, int ms) {
            var dialog = new ConsentDialog(Palette.Detect(), heading, message, warning, false);
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(ms) };
            timer.Tick += delegate { timer.Stop(); if (!dialog.closed) { dialog.allowed = false; dialog.Close(); } };
            dialog.Loaded += delegate { timer.Start(); };
            dialog.ShowDialog(); timer.Stop();
            return dialog.allowed;
        }
        public void Finish() { finished = true; if (!closed) Close(); }
        // Allow does nothing for this long after the question appears, so keys or a click meant for another window cannot
        // answer it. Don't allow works at once.
        public const int ArmMs = 500;
        readonly Stopwatch shown = new Stopwatch();
        ConsentDialog(Palette p, string headingText, string message, bool administrator, bool holds) {
            this.holds = holds;
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
            var heading = Ui.Label(headingText, 15.5, FontWeights.SemiBold, administrator ? p.Stop : p.Ink, Ui.DisplayFont); heading.LineHeight = 21; heading.Margin = new Thickness(0, 0, 0, 6);
            var copy = Ui.Label(message, 12.5, FontWeights.Normal, p.Ink, Ui.TextFont); copy.LineHeight = 18;
            text.Children.Add(heading); text.Children.Add(copy);
            body.Children.Add(text);
            stack.Children.Add(body);

            var foot = new Border { BorderBrush = p.Line, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(8, 10, 12, 12) };
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            var deny = new FlatButton("Don't allow", p.Ink, p.Surface2, p.Line, p.Work, 32, 96, 14, 6, 13, true);
            var allow = administrator
                ? new FlatButton("Allow", p.Stop, p.StopBg, p.StopBgHover, p.Work, 32, 80, 14, 6, 13, true)
                : new FlatButton("Allow", p.Live, p.LiveSoft, p.LiveSoftHover, p.Work, 32, 80, 14, 6, 13, true);
            allow.Margin = new Thickness(8, 0, 0, 0);
            deny.IsDefault = true;
            buttons.Children.Add(deny); buttons.Children.Add(allow);
            foot.Child = buttons; stack.Children.Add(foot);

            deny.Click += delegate { allowed = false; Close(); };
            allow.Click += delegate {
                if (!shown.IsRunning || shown.ElapsedMilliseconds < ArmMs) return;
                allowed = true;
                if (!holds) { Close(); return; }
                held = true; copy.Text = SupportAccess.Asking; foot.Visibility = Visibility.Collapsed; Decided.Set();
            };
            PreviewKeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Escape && !held) { e.Handled = true; allowed = false; Close(); } };
            Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e) { if (held && !finished) e.Cancel = true; }; // UAC's owner stays until UAC is answered
            Closed += delegate { closed = true; Decided.Set(); };
            Loaded += delegate { shown.Start(); Activate(); deny.Focus(); Keyboard.Focus(deny); };
        }
    }

    // --device-ask <answer>: a saved PC's question to the person at it before a session (PR 6). The service starts it as
    // the signed-in user in their session, with who asks and the team as one base64url JSON argument (never the key),
    // and reads the answer from the exit code. The consent dialog's look: Don't allow is the default, Allow does nothing
    // for its first 500 ms, and with no answer after two minutes it closes as Don't allow.
    public static class DeviceAsk {
        public const int Allowed = 10, NotAllowed = 11, AnswerMs = 120000, MaxArg = 2048;
        public static string Encode(string by, string team, bool full) {
            string b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(Wire.Json().Serialize(Wire.Map("by", by ?? "", "team", team ?? "", "control", full ? "full" : "limited"))));
            return b64.TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }
        // The answer back, or null for anything malformed: exactly by, team and control.
        public static Dictionary<string, object> Decode(string arg) {
            if (arg == null || arg.Length == 0 || arg.Length > MaxArg || !System.Text.RegularExpressions.Regex.IsMatch(arg, @"^[A-Za-z0-9_-]+\z")) return null;
            string b64 = arg.Replace('-', '+').Replace('_', '/'); b64 += new string('=', (4 - b64.Length % 4) % 4);
            Dictionary<string, object> m;
            try { m = Wire.Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(Convert.FromBase64String(b64))); } catch (Exception) { return null; }
            object by, team, control;
            if (m == null || m.Count != 3 || !m.TryGetValue("by", out by) || !(by is string) || !m.TryGetValue("team", out team) || !(team is string)
                || !m.TryGetValue("control", out control) || !("full".Equals(control) || "limited".Equals(control))) return null;
            return Wire.Map("by", Wire.Clean((string)by, 200), "team", Wire.Clean((string)team, 200), "control", control);
        }
        public static string Heading(string by) { return (by.Length > 0 ? "Allow " + by : "Allow your support team") + " to connect to this PC?"; }
        public static string Text(string by, string team, bool full) {
            string who = (by.Length > 0 ? by : "Someone") + " from " + (team.Length > 0 ? team : "your support team");
            return who + " wants to connect to this PC. " + (full
                ? "They can see your screen, control your mouse and keyboard, run commands and change files, also as the system and on the Windows sign-in screen."
                : "They can see your screen, control your mouse and keyboard, and run commands and change files as you.")
                + "\n\nA small window stays in the corner while they are connected. End session there, or in the Support icon, ends it at once. It ends by itself after 24 hours.\n\nWith no answer, this says Don't allow by itself after 2 minutes.";
        }
        public static int Run(string[] args) {
            try {
                var m = args.Length == 2 ? Decode(args[1]) : null;
                if (m == null) return NotAllowed;
                string by = Wire.Text(m, "by"), team = Wire.Text(m, "team"); bool full = Wire.Text(m, "control") == "full";
                return ConsentDialog.AskTimed(Heading(by), Text(by, team, full), full, AnswerMs) ? Allowed : NotAllowed;
            } catch (Exception) { return NotAllowed; }
        }
    }

    // ---- Saved PC: setup --------------------------------------------------------------------------------------
    // The rules of the setup wizard, kept apart from its window so the native tests can check them. The wizard runs
    // as the signed-in user and never holds a key. It hands its answers to the elevated install step as one argument
    // (base64url JSON) and reads the outcome from that step's exit code; no file passes between the two.
    public static class DeviceSetup {
        public const string ServiceName = "SupportMcpDevice";
        // The elevated step's exit codes.
        // Blocked: someone else created the setup mutex first (issue #22).
        public const int Active = 0, Pending = 10, CodeInvalid = 20, Network = 21, Refused = 22, AlreadySetUp = 23, Blocked = 24;
        public const int MaxName = 100, MaxAnswers = 1024;
        const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        // The install folder and the app in it, under %ProgramFiles% read from HKLM (FullInstall.Root).
        public static string Folder { get { return Path.Combine(FullInstall.Root, "SupportMCP"); } }
        public static string Exe { get { return Path.Combine(Folder, "support.exe"); } }
        // The installed app as the service runs it. A fresh install writes support.exe; an update (DeviceUpdate) points the
        // service at a version file beside it. So whatever starts or names the installed app reads it from the service's
        // command line, and falls back to support.exe.
        public static string InstalledExe() { return ExeOf(Scm.ImagePath(ServiceName), Folder); }
        // The quoted exe at the start of a service command line, when it is a version file directly in folder; else
        // folder\support.exe.
        public static string ExeOf(string command, string folder) {
            string fallback = Path.Combine(folder, "support.exe");
            if (string.IsNullOrEmpty(command) || command[0] != '"') return fallback;
            int end = command.IndexOf('"', 1);
            if (end < 2) return fallback;
            string exe = command.Substring(1, end - 1);
            return UpdateSwitch.InFolder(exe, folder) && UpdateSwitch.IsVersionFile(Path.GetFileName(exe)) ? exe : fallback;
        }
        // The wizard's screens. Code to Install are steps 1 to 5.
        public enum Screen { Intro, Code, Name, Access, Control, Install, Done, Waiting, Already, Unavailable }
        public static int StepOf(Screen s) { return s >= Screen.Code && s <= Screen.Install ? (int)s : 0; }

        // A typed code in the form the team shows (ABCDE-FGH23), or null. Case, spaces and hyphens do not matter.
        public static string NormalizeCode(string typed) {
            var plain = new StringBuilder();
            foreach (char c in typed ?? "") { if (c == '-' || c == ' ') continue; plain.Append(char.ToUpperInvariant(c)); }
            string code = plain.ToString();
            if (code.Length != 10 || !CodeCharsOk(code)) return null;
            return code.Substring(0, 5) + "-" + code.Substring(5);
        }
        // True while what is typed so far could still become a code: only the code's letters and digits, spaces and
        // hyphens, and at most 10 of the letters and digits.
        public static bool CodeCharsOk(string typed) {
            int n = 0;
            foreach (char c in typed ?? "") {
                if (c == '-' || c == ' ') continue;
                if (Alphabet.IndexOf(char.ToUpperInvariant(c)) < 0) return false;
                n++;
            }
            return n <= 10;
        }
        // An error text for a PC name, or "" when it is good. The relay allows 100 characters with no control characters.
        public static string CheckName(string name) {
            string t = (name ?? "").Trim();
            if (t.Length == 0) return "Give this PC a name your support team will recognise.";
            if (t.Length > MaxName) return "Use at most " + MaxName + " characters.";
            foreach (char c in t) if (char.IsControl(c)) return "Use letters, digits and spaces only.";
            return "";
        }
        // What stops the wizard from leaving a screen, or "" when nothing does. access and control are null until chosen:
        // nothing is preselected.
        public static string Missing(Screen s, string code, bool useWorkspace, string name, string access, string control) {
            if (s == Screen.Code && !useWorkspace && NormalizeCode(code) == null) return "Type the code from your support team, like ABCDE-FGH23.";
            if (s == Screen.Name) return CheckName(name);
            if (s == Screen.Access && access != "ask" && access != "any") return "Choose how support may connect.";
            if (s == Screen.Control && control != "full" && control != "limited") return "Choose how much support can do.";
            return "";
        }

        // The answers argument: base64url of {"name","access","control"} plus "code" (a technician's code) or
        // "workspace": true (an install the owner starts, with the workspace from the install step's own footer). No
        // owner contact: the team keeps it. Nothing secret beyond the code the owner typed.
        public static string EncodeAnswers(string name, string access, string control, string code) {
            var m = Wire.Map("name", (name ?? "").Trim(), "access", access, "control", control);
            if (code == null) m["workspace"] = true; else m["code"] = code;
            string b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(Wire.Json().Serialize(m)));
            return b64.TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }
        // The answers back, checked again, since anyone could start the install step with any argument.
        public static Dictionary<string, object> DecodeAnswers(string arg) {
            if (arg == null || arg.Length == 0 || arg.Length > MaxAnswers || !System.Text.RegularExpressions.Regex.IsMatch(arg, @"^[A-Za-z0-9_-]+\z")) throw new InvalidDataException("Invalid setup answers.");
            string b64 = arg.Replace('-', '+').Replace('_', '/');
            b64 += new string('=', (4 - b64.Length % 4) % 4);
            Dictionary<string, object> m;
            try { m = Wire.Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(Convert.FromBase64String(b64))); }
            catch (Exception) { throw new InvalidDataException("Invalid setup answers."); }
            if (m == null || m.Count != 4) throw new InvalidDataException("Invalid setup answers.");
            object name, access, control, code, workspace;
            bool hasCode = m.TryGetValue("code", out code), hasWorkspace = m.TryGetValue("workspace", out workspace);
            if (!m.TryGetValue("name", out name) || !(name is string) || CheckName((string)name) != "" || ((string)name).Trim() != (string)name
                || !m.TryGetValue("access", out access) || !("ask".Equals(access) || "any".Equals(access))
                || !m.TryGetValue("control", out control) || !("full".Equals(control) || "limited".Equals(control))
                || hasCode == hasWorkspace
                || (hasCode && !(code is string && NormalizeCode((string)code) == (string)code))
                || (hasWorkspace && !true.Equals(workspace))) throw new InvalidDataException("Invalid setup answers.");
            return m;
        }

        // Where the wizard goes after the install step's exit code, and what it says there.
        public static Screen After(int exit) {
            if (exit == Active) return Screen.Done;
            if (exit == Pending) return Screen.Waiting;
            if (exit == CodeInvalid) return Screen.Code;
            if (exit == AlreadySetUp) return Screen.Already;
            return Screen.Install; // network, refused, or anything unknown: try again from the install step
        }
        public static string ExitText(int exit) {
            if (exit == Active || exit == Pending || exit == AlreadySetUp) return "";
            if (exit == CodeInvalid) return "That code didn't work. It may be used or expired. Ask your support team for a new one.";
            if (exit == Network) return "Can't reach your support team right now. Check the internet connection, then try again.";
            if (exit == Blocked) return OwnerCheck.Blocked;
            return "Setup didn't finish. Your support team's server refused it. Try again, or ask your support team for help.";
        }
        public const string DeclinedText = "Windows didn't get permission, so nothing was installed. Click Try again to ask once more.";
        public const string UnavailableText = "This Windows account can't install programs. Ask an administrator of this PC to run the setup.";
        // Six digits as the owner reads them: "482 913".
        public static string ShowConfirm(string digits) {
            return digits != null && System.Text.RegularExpressions.Regex.IsMatch(digits, @"^[0-9]{6}\z") ? digits.Substring(0, 3) + " " + digits.Substring(3) : null;
        }
        public static string ModeText(string access) {
            return access == "any" ? "Your support team can connect to this PC any time, even when nobody is at it." : "Support asks you here, on this PC, before each connection. " + TrayText.AdminsCanChange;
        }
        // Where the owner uninstalls: Settings, then Apps from Windows 10 (build 10240) on; Control Panel before it.
        public static readonly string AppsPlace = HasSettingsApps() ? "Settings, then Apps" : "Control Panel, then Programs and Features";
        public static readonly string UninstallText = "To remove Support, open " + AppsPlace + ", and uninstall Support.";
        static bool HasSettingsApps() {
            try {
                using (var hklm = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64))
                using (var k = hklm.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion")) {
                    int build; if (k != null && Int32.TryParse(k.GetValue("CurrentBuildNumber") as string, out build)) return build >= 10240;
                }
            } catch (Exception) { }
            // Without a manifest Windows 8 to 11 all report 6.2, so an unreadable registry means Control Panel, which every build has.
            return false;
        }

        // A short description of this Windows, reported to the relay. Never fails the install.
        // The Windows name and build from the registry: Environment.OSVersion reports 6.2 on Windows 10 and 11 to an exe
        // that does not declare them, and Windows 11 still names itself "Windows 10" in ProductName.
        public static string Os() {
            try {
                // The 64-bit view: this x86 exe would otherwise read the WOW64 copy, whose ProductName can be stale.
                using (var hklm = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64))
                using (var k = hklm.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion")) {
                    string product = k == null ? null : k.GetValue("ProductName") as string, build = k == null ? null : k.GetValue("CurrentBuildNumber") as string;
                    string release = k == null ? null : k.GetValue("DisplayVersion") as string;
                    if (String.IsNullOrEmpty(release) && k != null) release = k.GetValue("ReleaseId") as string;
                    return OsName(product, build, release);
                }
            } catch (Exception) { }
            try { return Environment.OSVersion.VersionString; } catch (Exception) { return "Windows"; }
        }
        internal static string OsName(string product, string build, string release) {
            if (String.IsNullOrEmpty(product)) return "Windows" + (String.IsNullOrEmpty(build) ? "" : " (build " + build + ")");
            int number; string name = product.Trim();
            if (Int32.TryParse(build, out number) && number >= 22000 && name.StartsWith("Windows 10", StringComparison.Ordinal)) name = "Windows 11" + name.Substring(10);
            if (!String.IsNullOrEmpty(release)) name += " " + release.Trim();
            if (!String.IsNullOrEmpty(build)) name += " (build " + build.Trim() + ")";
            return name.Length > 100 ? name.Substring(0, 100) : name;
        }
        // Starts the tray as the signed-in user, when it is installed. A failure is not an error: it starts at the next sign-in.
        public static void StartTray() {
            try { var start = TrayStart(); if (File.Exists(start.FileName)) using (Process.Start(start)) { } } catch (Exception) { }
        }
        // The tray starts in the system folder: a process's current directory blocks renaming it, and the install folder
        // must stay free to rename aside when the PC is removed.
        internal static ProcessStartInfo TrayStart() { return new ProcessStartInfo(InstalledExe(), "--tray") { UseShellExecute = false, WorkingDirectory = Environment.SystemDirectory }; }
        // The wizard, one per session.
        public static void Run(Application app, Dictionary<string, object> footer, string exe) {
            bool first; using (var mutex = new Mutex(true, "Local\\SupportMcpSetup", out first)) {
                if (!first) return;
                var window = new SetupWindow(Palette.Detect(), footer, exe);
                window.Closed += delegate { app.Shutdown(); };
                app.Run(window);
                window.Finish();
            }
        }
    }

    // The setup wizard, shown as the signed-in user from a /install download. One window, five steps (code, name,
    // access, control, install), in the app's palette. It holds no key: it hands its answers to the elevated install
    // step as one base64url argument and reads the outcome from that step's exit code (DeviceSetup).
    public sealed class SetupWindow : Window {
        const double CardWidth = 460, Pad = 20;
        readonly Palette p;
        readonly Dictionary<string, object> footer;
        readonly string exe, prefilledCode, workspace;
        readonly bool offersWorkspace;
        DeviceSetup.Screen screen;
        volatile bool installing, declined;
        string confirm;
        Thread worker;

        readonly Border bodyHost;
        readonly TextBlock heading, stepLine, error;
        readonly FlatButton back, next, cancel;
        readonly Dictionary<DeviceSetup.Screen, FrameworkElement> panels = new Dictionary<DeviceSetup.Screen, FrameworkElement>();
        TextBox codeBox, nameBox;
        CheckBox noCode;
        RadioButton askRadio, anyRadio, fullRadio, limitedRadio;
        DeviceSetup.Screen? focusedFor;
        readonly TextBlock terminalHead, terminalBody;

        public SetupWindow(Palette palette, Dictionary<string, object> footer, string exe) {
            this.p = palette; this.footer = footer; this.exe = exe;
            prefilledCode = Wire.Text(footer, "code");
            workspace = Wire.Text(footer, "workspace");
            offersWorkspace = workspace.Length > 0;
            screen = Scm.Status(DeviceSetup.ServiceName) != null ? DeviceSetup.Screen.Already : DeviceSetup.Screen.Intro;

            Ui.Transparent(this);
            Topmost = false; ShowInTaskbar = true; Title = "Support setup";
            Width = CardWidth + 2 * Pad; SizeToContent = SizeToContent.Height; WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Foreground = p.Ink;
            Grid inner; var card = Ui.Card(p, CardWidth, out inner);
            var root = new Grid { Margin = new Thickness(Pad) }; root.Children.Add(card); Content = root;
            var stack = new StackPanel(); inner.Children.Add(stack);
            stack.Children.Add(new Border { Height = 3, Background = p.Work });

            var header = new Grid { Height = 36, Margin = new Thickness(14, 0, 14, 0), Background = Brushes.Transparent };
            var title = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            var screenGlyph = Glyph.Screen().Paint(p.Muted).Sized(16); screenGlyph.Margin = new Thickness(0, 0, 8, 0);
            title.Children.Add(screenGlyph);
            title.Children.Add(Lbl("Support setup", 12, FontWeights.SemiBold, p.Muted, Ui.TextFont, VerticalAlignment.Center));
            header.Children.Add(title);
            stepLine = Lbl("", 12, FontWeights.Normal, p.Muted, Ui.TextFont, VerticalAlignment.Center); stepLine.HorizontalAlignment = HorizontalAlignment.Right;
            header.Children.Add(stepLine);
            Ui.Drag(this, header);
            stack.Children.Add(header);

            var bodyWrap = new StackPanel { Margin = new Thickness(20, 6, 20, 4) };
            heading = Lbl("", 17, FontWeights.SemiBold, p.Ink, Ui.DisplayFont, VerticalAlignment.Top); heading.Margin = new Thickness(0, 0, 0, 10); heading.LineHeight = 22;
            bodyWrap.Children.Add(heading);
            bodyHost = new Border(); bodyWrap.Children.Add(bodyHost);
            error = Lbl("", 12.5, FontWeights.Normal, p.Stop, Ui.TextFont, VerticalAlignment.Top); error.Margin = new Thickness(0, 10, 0, 0); error.Visibility = Visibility.Collapsed;
            bodyWrap.Children.Add(error);
            terminalHead = Lbl("", 15.5, FontWeights.SemiBold, p.Ink, Ui.DisplayFont, VerticalAlignment.Top); terminalHead.Margin = new Thickness(0, 0, 0, 8); terminalHead.LineHeight = 21;
            terminalBody = Lbl("", 13, FontWeights.Normal, p.Muted, Ui.TextFont, VerticalAlignment.Top); terminalBody.LineHeight = 19;
            stack.Children.Add(bodyWrap);

            var foot = new Border { BorderBrush = p.Line, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(12, 10, 12, 12), Margin = new Thickness(0, 10, 0, 0) };
            var footGrid = new Grid();
            footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            cancel = new FlatButton("Cancel", p.Ink, p.Surface2, p.Line, p.Work, 34, 88, 14, 6, 13, true);
            cancel.Click += delegate { Close(); };
            footGrid.Children.Add(cancel);
            back = new FlatButton("Back", p.Ink, p.Surface2, p.Line, p.Work, 34, 88, 14, 6, 13, true);
            back.Click += delegate { OnBack(); };
            Grid.SetColumn(back, 0); footGrid.Children.Add(back);
            next = new FlatButton("Next", Brushes.White, p.Work, p.Work, p.Ink, 34, 120, 16, 6, 13, true);
            next.Click += delegate { OnNext(); };
            Grid.SetColumn(next, 2); footGrid.Children.Add(next);
            foot.Child = footGrid; stack.Children.Add(foot);

            BuildPanels();
            PreviewKeyDown += delegate(object sender, KeyEventArgs e) {
                if (e.Key == Key.Escape && !installing) { e.Handled = true; Close(); }
                else if (e.Key == Key.Enter && next.IsEnabled && next.Visibility == Visibility.Visible) { e.Handled = true; OnNext(); }
            };
            Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e) { if (installing) e.Cancel = true; };
            Loaded += delegate { Render(); Activate(); };
        }

        TextBlock Lbl(string text, double size, FontWeight weight, Brush color, string font, VerticalAlignment valign) {
            var t = Ui.Label(text, size, weight, color, font); t.VerticalAlignment = valign; return t;
        }

        void BuildPanels() {
            // Intro.
            panels[DeviceSetup.Screen.Intro] = Para("Support keeps this PC on your support team's list so they can help when you ask. This short setup asks how they may connect. You stay in control: remove Support any time from " + DeviceSetup.AppsPlace + ".");

            // Code.
            var codePanel = new StackPanel();
            codePanel.Children.Add(Para("Enter the code your support team sent you. It looks like ABCDE-FGH23."));
            codeBox = Field(prefilledCode.Length > 0 ? prefilledCode : "", "ABCDE-FGH23");
            codeBox.CharacterCasing = CharacterCasing.Upper;
            codeBox.TextChanged += delegate { if (error.Visibility == Visibility.Visible) { error.Visibility = Visibility.Collapsed; } };
            codePanel.Children.Add(codeBox);
            if (offersWorkspace) {
                noCode = new CheckBox { Content = "I don't have a code", Foreground = p.Ink, Margin = new Thickness(0, 12, 0, 0), FontSize = 13 };
                noCode.Checked += delegate { codeBox.IsEnabled = false; error.Visibility = Visibility.Collapsed; };
                noCode.Unchecked += delegate { codeBox.IsEnabled = true; };
                codePanel.Children.Add(noCode);
                codePanel.Children.Add(Sub("Without a code, this PC joins your team and waits for a technician to approve it. The setup shows a number to read out."));
            }
            panels[DeviceSetup.Screen.Code] = codePanel;

            // Name.
            var namePanel = new StackPanel();
            namePanel.Children.Add(Para("Give this PC a name your support team will recognise."));
            nameBox = Field("", "Front desk"); namePanel.Children.Add(nameBox);
            var chips = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) };
            foreach (string suggestion in Suggestions()) {
                string value = suggestion;
                var chip = new FlatButton(value, p.Ink, p.Surface2, p.Line, p.Work, 28, 0, 12, 14, 12.5, true); chip.Margin = new Thickness(0, 0, 8, 8);
                chip.Click += delegate { nameBox.Text = value; nameBox.CaretIndex = value.Length; error.Visibility = Visibility.Collapsed; };
                chips.Children.Add(chip);
            }
            namePanel.Children.Add(chips);
            panels[DeviceSetup.Screen.Name] = namePanel;

            // Access. Nothing is preselected.
            var accessPanel = new StackPanel();
            askRadio = Choice("access", "Ask me each time", "Support asks you here, on this PC, before each connection. " + TrayText.AdminsCanChange);
            anyRadio = Choice("access", "Connect any time (unattended)", "Your support team can connect even when nobody is at this PC. You can turn this on later, but only your team can turn it back off.");
            accessPanel.Children.Add(askRadio); accessPanel.Children.Add(anyRadio);
            panels[DeviceSetup.Screen.Access] = accessPanel;

            // Control. Nothing is preselected.
            var controlPanel = new StackPanel();
            fullRadio = Choice("control", "Full control", "Also works through Windows security prompts and the sign-in screen.");
            limitedRadio = Choice("control", "Limited support", "Works as the signed-in user only, not Windows security prompts.");
            controlPanel.Children.Add(fullRadio); controlPanel.Children.Add(limitedRadio);
            panels[DeviceSetup.Screen.Control] = controlPanel;

            // Install.
            panels[DeviceSetup.Screen.Install] = Para("Windows will ask for permission to install Support. Click Install, then Yes when Windows asks.");

            // The terminal screens share one message panel.
            var terminal = new StackPanel(); terminal.Children.Add(terminalHead); terminal.Children.Add(terminalBody);
            panels[DeviceSetup.Screen.Done] = terminal;
            panels[DeviceSetup.Screen.Waiting] = terminal;
            panels[DeviceSetup.Screen.Already] = terminal;
            panels[DeviceSetup.Screen.Unavailable] = terminal;
        }

        List<string> Suggestions() {
            var list = new List<string>();
            string machine = Environment.MachineName;
            if (machine.Length > 0 && machine.Length <= DeviceSetup.MaxName) list.Add(machine);
            foreach (string s in Common()) if (!list.Contains(s)) list.Add(s);
            return list;
        }
        static IEnumerable<string> Common() { yield return "Front desk"; yield return "Reception"; yield return "Office PC"; }

        TextBox Field(string text, string hint) {
            var box = new TextBox {
                Text = text, FontSize = 14, FontFamily = new FontFamily(Ui.TextFont), Foreground = p.Ink, CaretBrush = p.Ink,
                Background = p.Surface2, BorderBrush = p.Line, BorderThickness = new Thickness(1), Padding = new Thickness(10, 7, 10, 7),
            };
            // For screen readers only: a tooltip would open on keyboard focus and cover the error line under the field.
            System.Windows.Automation.AutomationProperties.SetHelpText(box, hint);
            return box;
        }
        RadioButton Choice(string group, string title, string detail) {
            var text = new StackPanel();
            text.Children.Add(Ui.Label(title, 13.5, FontWeights.SemiBold, p.Ink, Ui.TextFont));
            var sub = Ui.Label(detail, 12, FontWeights.Normal, p.Muted, Ui.TextFont); sub.Margin = new Thickness(0, 2, 0, 0);
            text.Children.Add(sub);
            var radio = new RadioButton { GroupName = group, Content = text, Foreground = p.Ink, Margin = new Thickness(0, 0, 0, 12), Padding = new Thickness(6, 0, 0, 0) };
            radio.Checked += delegate { error.Visibility = Visibility.Collapsed; };
            return radio;
        }
        StackPanel Para(string text) { var s = new StackPanel(); s.Children.Add(Ui.Label(text, 13, FontWeights.Normal, p.Muted, Ui.TextFont)); return s; }
        FrameworkElement Sub(string text) { var t = Ui.Label(text, 12, FontWeights.Normal, p.Muted, Ui.TextFont); t.Margin = new Thickness(0, 8, 0, 0); return t; }

        string Access() { return anyRadio.IsChecked == true ? "any" : askRadio.IsChecked == true ? "ask" : null; }
        string Control() { return fullRadio.IsChecked == true ? "full" : limitedRadio.IsChecked == true ? "limited" : null; }
        bool UseWorkspace() { return offersWorkspace && noCode != null && noCode.IsChecked == true; }

        void OnNext() {
            if (screen >= DeviceSetup.Screen.Done) { if (screen == DeviceSetup.Screen.Already) DeviceSetup.StartTray(); Close(); return; }
            if (screen == DeviceSetup.Screen.Install) { BeginInstall(); return; }
            string miss = DeviceSetup.Missing(screen, codeBox != null ? codeBox.Text : "", UseWorkspace(), nameBox != null ? nameBox.Text : "", Access(), Control());
            if (miss != "") { error.Text = miss; error.Visibility = Visibility.Visible; return; }
            error.Visibility = Visibility.Collapsed;
            screen = screen + 1; Render();
        }
        void OnBack() {
            if (screen >= DeviceSetup.Screen.Code && screen <= DeviceSetup.Screen.Install) { declined = false; error.Visibility = Visibility.Collapsed; screen = screen - 1; Render(); }
        }

        void BeginInstall() {
            if (installing) return;
            installing = true; declined = false; error.Visibility = Visibility.Collapsed;
            string answers = DeviceSetup.EncodeAnswers(nameBox.Text, Access(), Control(), UseWorkspace() ? null : DeviceSetup.NormalizeCode(codeBox.Text));
            IntPtr owner = new WindowInteropHelper(this).Handle;
            Render();
            worker = new Thread(delegate() {
                int exit = DeviceSetup.Refused; bool unavailable = false, wasDeclined = false;
                try {
                    Consent path = ConsentPath.Detect();
                    if (path == Consent.Unavailable) unavailable = true;
                    else {
                        string nonce = Elevation.Nonce(); string staged = Elevation.Stage(exe);
                        // Want is held open for the whole elevated run; the installer opens it (Wanted) and refuses once it is gone.
                        using (var want = Elevation.Want("device", nonce))
                        try { exit = Native.RunElevated(staged, "--device-install " + nonce + " " + answers, owner, delegate { }); }
                        finally { try { Elevation.DeleteTree(Path.GetDirectoryName(staged)); } catch (Exception) { } }
                        if (exit == -1223) wasDeclined = true;
                    }
                } catch (Exception) { exit = DeviceSetup.Refused; }
                bool un = unavailable, dec = wasDeclined; int code = exit;
                Post(delegate { FinishInstall(un, dec, code); });
            });
            worker.SetApartmentState(ApartmentState.STA); worker.IsBackground = true; worker.Start();
        }
        void FinishInstall(bool unavailable, bool wasDeclined, int exit) {
            ShowOutcome(unavailable, wasDeclined, exit);
            // The permission prompt can hand the foreground to another window, such as the browser the download came
            // from: come back to the front with the outcome.
            Activate();
        }
        void ShowOutcome(bool unavailable, bool wasDeclined, int exit) {
            installing = false;
            if (unavailable) { screen = DeviceSetup.Screen.Unavailable; Render(); return; }
            if (wasDeclined) { declined = true; Render(); return; }
            confirm = null;
            if (exit == DeviceSetup.Active || exit == DeviceSetup.Pending) {
                DeviceSetup.StartTray();
                // Reading the six digits talks to the service pipe for a few seconds, so it runs off the UI thread and
                // updates the Waiting screen when it arrives.
                if (exit == DeviceSetup.Pending) {
                    var t = new Thread(delegate() { string c = DeviceService.ReadConfirm(); Post(delegate { confirm = c; if (screen == DeviceSetup.Screen.Waiting) Render(); }); });
                    t.IsBackground = true; t.Start();
                }
            }
            DeviceSetup.Screen nextScreen = DeviceSetup.After(exit);
            string text = DeviceSetup.ExitText(exit);
            if (nextScreen == DeviceSetup.Screen.Code || nextScreen == DeviceSetup.Screen.Install) { if (text.Length > 0) { error.Text = text; error.Visibility = Visibility.Visible; } }
            screen = nextScreen; Render();
        }

        void Post(Action a) { Dispatcher.BeginInvoke(DispatcherPriority.Normal, a); }

        void Render() {
            bool terminal = screen >= DeviceSetup.Screen.Done;
            int step = DeviceSetup.StepOf(screen);
            stepLine.Text = step > 0 ? "Step " + step + " of 5" : "";
            bodyHost.Child = panels.ContainsKey(screen) ? panels[screen] : null;

            if (screen == DeviceSetup.Screen.Intro) heading.Text = "Set up Support on this PC";
            else if (screen == DeviceSetup.Screen.Code) heading.Text = "Your support code";
            else if (screen == DeviceSetup.Screen.Name) heading.Text = "Name this PC";
            else if (screen == DeviceSetup.Screen.Access) heading.Text = "How may support connect?";
            else if (screen == DeviceSetup.Screen.Control) heading.Text = "How much can support do?";
            else if (screen == DeviceSetup.Screen.Install) heading.Text = installing ? "Setting up..." : "Ready to install";
            heading.Visibility = terminal ? Visibility.Collapsed : Visibility.Visible;

            if (terminal) {
                if (screen == DeviceSetup.Screen.Done) {
                    terminalHead.Text = (nameBox != null ? nameBox.Text.Trim() : "This PC") + " is ready";
                    terminalBody.Text = "Your support team now sees this PC in their list. " + DeviceSetup.ModeText(Access()) + " " + DeviceSetup.UninstallText;
                } else if (screen == DeviceSetup.Screen.Waiting) {
                    string digits = DeviceSetup.ShowConfirm(confirm);
                    terminalHead.Text = "Almost there";
                    terminalBody.Text = (digits != null ? "Read this number to your support team: " + digits + ". " : "Your request is waiting for your support team to approve it. ") + "This PC waits for up to 24 hours. You can close this window; the tray icon shows its state.";
                } else if (screen == DeviceSetup.Screen.Already) {
                    terminalHead.Text = "Support is already set up on this PC";
                    terminalBody.Text = "Open Support to see its state, or remove it from " + DeviceSetup.AppsPlace + ".";
                } else {
                    terminalHead.Text = "Can't install on this account";
                    terminalBody.Text = DeviceSetup.UnavailableText;
                }
            } else if (screen == DeviceSetup.Screen.Install && declined) {
                error.Text = DeviceSetup.DeclinedText; error.Visibility = Visibility.Visible;
            }

            back.Visibility = (!terminal && !installing && screen > DeviceSetup.Screen.Intro) ? Visibility.Visible : Visibility.Collapsed;
            cancel.Visibility = (!terminal && !installing && screen == DeviceSetup.Screen.Intro) ? Visibility.Visible : Visibility.Collapsed;
            next.IsEnabled = !installing;
            next.Visibility = installing ? Visibility.Collapsed : Visibility.Visible;
            if (screen == DeviceSetup.Screen.Already) next.Content = "Open Support";
            else if (terminal) next.Content = screen == DeviceSetup.Screen.Done ? "Finish" : "Close";
            else if (screen == DeviceSetup.Screen.Install) next.Content = declined ? "Try again" : "Install";
            else if (screen == DeviceSetup.Screen.Control) next.Content = "Next";
            else next.Content = "Next";

            // Keyboard: a new step puts the focus on its own field, so typing and the arrow keys work without a mouse.
            // Focusing a choice does not select it: nothing is preselected.
            if (focusedFor != screen) {
                focusedFor = screen;
                UIElement target = screen == DeviceSetup.Screen.Code ? (noCode != null && noCode.IsChecked == true ? (UIElement)noCode : codeBox)
                    : screen == DeviceSetup.Screen.Name ? nameBox
                    : screen == DeviceSetup.Screen.Access ? (anyRadio.IsChecked == true ? anyRadio : askRadio)
                    : screen == DeviceSetup.Screen.Control ? (limitedRadio.IsChecked == true ? limitedRadio : fullRadio)
                    : next.Visibility == Visibility.Visible ? (UIElement)next : null;
                if (target != null) Dispatcher.BeginInvoke(DispatcherPriority.Input, (Action)delegate { target.Focus(); Keyboard.Focus(target); });
            }
        }

        public void Finish() { var t = worker; if (t != null) t.Join(120000); }
    }

    // --device-install <nonce> <answers>: the elevated step of the setup wizard, for a saved PC. It starts like the
    // one-off full-control install: the DLL search is narrowed first (Program.Main), the exe runs from a staged, held
    // copy, and the exe and its device footer are read once through that held handle (FullInstall.ReadSelf). The
    // Want/Wanted nonce means a Yes the customer gives after the wizard has closed installs nothing. The install
    // pairs over the /device/ wire, lays down %ProgramFiles%\SupportMCP, writes support.exe (the exe without its
    // footer) that users may read and run and device.json plus history.json that only SYSTEM and administrators can,
    // registers the SupportMcpDevice service, the tray's startup value and the Apps uninstall entry, and starts the
    // service. On any failure after pairing it leaves the relay with the new key and removes everything it made. It
    // never touches HKLM\SOFTWARE\SupportMCP (the one-off sessions' shared record). Only SYSTEM or an elevated
    // administrator process ever holds the key.
    public static class DeviceInstall {
        public const string DisplayName = "Support", Publisher = "Support-MCP";
        public const string ServiceDisplay = "Support device service";
        public const string ServiceDescription = "Lets this PC's support team see it on their list and connect when you allow it. Uninstalling Support from Windows Settings removes this service.";
        public const string RunKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", TrayValueName = "SupportMcpTray";
        public const string AppsKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\SupportMcpDevice";

        // What to do about what is already on the PC: a running service means Support is set up (exit 23); the folder
        // without a service is a crash leftover to clean before a fresh install; nothing means a clean install.
        public enum Leftover { Proceed, Clean, AlreadySetUp }
        public static Leftover LeftoverAction(bool serviceExists, bool folderExists) {
            if (serviceExists) return Leftover.AlreadySetUp;
            if (folderExists) return Leftover.Clean;
            return Leftover.Proceed;
        }
        // The service's binary path (quoted, because %ProgramFiles% has a space) and the tray's startup command.
        public static string ServiceBinary(string exe) { return "\"" + exe + "\" --device-service"; }
        public static string TrayRunValue(string exe) { return "\"" + exe + "\" --tray"; }
        // The Apps-list entry's values. A string is written as a REG_SZ, a whole number as a REG_DWORD. There is no
        // DisplayIcon: the exe carries no icon (the tray draws its own at run time).
        public static Dictionary<string, object> AppsValues(string version, string folder, string exe, int estimatedSizeKb) {
            return Wire.Map("DisplayName", DisplayName, "DisplayVersion", version, "Publisher", Publisher,
                "InstallLocation", folder, "UninstallString", "\"" + exe + "\" --uninstall",
                "NoModify", 1, "NoRepair", 1, "EstimatedSize", estimatedSizeKb);
        }
        // The install folder: created by an elevated administrator, owned by Administrators, SYSTEM and Administrators
        // full and nothing inherited. device.json and history.json inherit this; support.exe gets its own ACL below.
        public static DirectorySecurity LockedFolder() { var s = FullAcl.Folder(); s.SetOwner(FullAcl.AdminsSid); return s; }

        // One elevated install or remove at a time across the whole PC. A Global mutex, so sessions share it, with an
        // ACL that only Administrators and SYSTEM (who run these elevated steps) may take. Windows ignores that ACL when
        // the name exists already, so an existing one is used only when SYSTEM or Administrators own it (issue #22);
        // otherwise this throws BlockedException, and the caller says OwnerCheck.Blocked.
        public const string SetupMutexName = "Global\\SupportMcpDeviceSetup";
        public static Mutex SetupMutex() { return SetupMutex(SetupMutexName); }
        internal static Mutex SetupMutex(string name) {
            // Owned by Administrators where the token allows it (SYSTEM and an elevated administrator), so the next
            // opener trusts it whatever this account's default owner is; else the default owner (a test account).
            // A name that exists with an access list that shuts this caller out makes the open throw
            // UnauthorizedAccessException before any owner can be read: that is a squatter too.
            bool created; Mutex m = null;
            try {
                if (!SupportAccess.IsAdministrator()) m = new Mutex(false, name, out created, SetupSecurity(false));
                else try { m = new Mutex(false, name, out created, SetupSecurity(true)); }
                    catch (IOException) { m = new Mutex(false, name, out created, SetupSecurity(false)); } // ERROR_INVALID_OWNER
            } catch (UnauthorizedAccessException) { throw new BlockedException(); }
            if (!created && !OwnerCheck.Trusted(m, name)) { m.Dispose(); throw new BlockedException(); }
            return m;
        }
        public sealed class BlockedException : Exception { public BlockedException() : base(OwnerCheck.Blocked) { } }
        static MutexSecurity SetupSecurity(bool adminsOwn) {
            var sec = new MutexSecurity();
            sec.AddAccessRule(new MutexAccessRule(FullAcl.SystemSid, MutexRights.FullControl, AccessControlType.Allow));
            sec.AddAccessRule(new MutexAccessRule(FullAcl.AdminsSid, MutexRights.FullControl, AccessControlType.Allow));
            if (adminsOwn) sec.SetOwner(FullAcl.AdminsSid);
            return sec;
        }
        // Removes the install folder even when a tray still holds support.exe: rename it aside first (a rename works
        // with a running exe, and frees the original path for a fresh install), delete what is not locked with the
        // junction-safe walk, and queue anything that remains for the next restart. Only the top level is listed, so
        // no junction is ever followed.
        public static void RemoveFolderAside(string folder) {
            try { if (Directory.Exists(folder)) Native.DeleteTree(folder); } catch (Exception) { }
            if (!Directory.Exists(folder)) return;
            string moved = folder + ".removed-" + Guid.NewGuid().ToString("N");
            try { Directory.Move(folder, moved); } catch (Exception) { moved = folder; }
            try { Native.DeleteTree(moved); } catch (Exception) { }
            if (!Directory.Exists(moved)) return;
            try {
                foreach (string f in Directory.GetFiles(moved)) try { Native.MoveFileEx(f, null, 4); } catch (Exception) { }
                foreach (string d in Directory.GetDirectories(moved)) try { Native.MoveFileEx(d, null, 4); } catch (Exception) { }
                Native.MoveFileEx(moved, null, 4);
            } catch (Exception) { }
        }

        public static int Install(byte[] self, Dictionary<string, object> footer, string[] args) {
            if (args.Length != 3 || !System.Text.RegularExpressions.Regex.IsMatch(args[1], @"^[0-9a-f]{32}\z")) return DeviceSetup.Refused;
            Dictionary<string, object> answers;
            try { answers = DeviceSetup.DecodeAnswers(args[2]); } catch (Exception) { return DeviceSetup.Refused; }
            // The wizard holds this event open while UAC is asked. Gone means the wizard closed before the Yes: install nothing.
            var want = Elevation.Wanted("device", args[1]);
            if (want == null) return DeviceSetup.Refused;
            using (want) return Install(self, footer, answers, want);
        }
        static int Install(byte[] self, Dictionary<string, object> footer, Dictionary<string, object> answers, EventWaitHandle want) {
            // One install or remove at a time across the PC: a second gets "already set up" and touches nothing. The
            // want handle (Wanted) already refused a late Yes after the wizard closed, so no further want check is needed.
            Mutex only = null; bool held = false;
            try { only = SetupMutex(); try { held = only.WaitOne(0); } catch (AbandonedMutexException) { held = true; } } catch (BlockedException) { return DeviceSetup.Blocked; } catch (Exception) { }
            if (!held) { if (only != null) only.Dispose(); return DeviceSetup.AlreadySetUp; }
            try { return InstallLocked(self, footer, answers); }
            finally { try { only.ReleaseMutex(); } catch (Exception) { } only.Dispose(); }
        }
        static int InstallLocked(byte[] self, Dictionary<string, object> footer, Dictionary<string, object> answers) {
            string origin = Wire.Text(footer, "origin"), folder = DeviceSetup.Folder, exe = DeviceSetup.Exe;
            Leftover action = LeftoverAction(Scm.Status(DeviceSetup.ServiceName) != null, Directory.Exists(folder) || File.Exists(folder));
            if (action == Leftover.AlreadySetUp) return DeviceSetup.AlreadySetUp;
            if (action == Leftover.Clean) CleanLeftover(folder);
            if (Scm.Status(DeviceSetup.ServiceName) != null || Directory.Exists(folder) || File.Exists(folder)) return DeviceSetup.AlreadySetUp;

            string name = Wire.Text(answers, "name"), access = Wire.Text(answers, "access"), control = Wire.Text(answers, "control");
            var body = Wire.Map("name", name, "access", access, "control", control, "os", DeviceSetup.Os(), "machine", Environment.MachineName, "app_version", Wire.Version);
            if (answers.ContainsKey("code")) body["code"] = Wire.Text(answers, "code"); else body["workspace"] = Wire.Text(footer, "workspace");
            DeviceLink.Answer a = new DeviceLink(origin).Pair(body);
            if (a.Result == DeviceLink.DeviceResult.Offline) return DeviceSetup.Network;
            if (a.Result == DeviceLink.DeviceResult.CodeInvalid) return DeviceSetup.CodeInvalid;
            if (!a.Ok) return DeviceSetup.Refused;
            string key = Wire.Text(a.Body, "key"), status = Wire.Text(a.Body, "status");

            // Roll back removes only what this run made, so a concurrent run's artifacts (there are none, under the
            // mutex, but a crash leftover of this session's own is the only thing that could pre-exist) stay untouched.
            bool madeFolder = false, madeService = false, madeRegistry = false;
            try {
                Native.CreateLocked(folder, LockedFolder()); madeFolder = true; // CreateLocked fails if the folder exists, so this run made it
                using (var f = new FileStream(exe, FileMode.CreateNew)) f.Write(self, 0, Wire.Payload(self));
                File.SetAccessControl(exe, FullAcl.Window()); // users may read and run support.exe, like the one-off window copy
                var record = Wire.Map("origin", origin, "workspace", Wire.Text(a.Body, "workspace"), "device_id", Wire.Text(a.Body, "device_id"),
                    "key", key, "status", status, "name", name, "access", access, "control", control, "uninstall_event", Elevation.Nonce());
                if (status == "pending") record["confirm"] = Wire.Text(a.Body, "confirm");
                File.WriteAllText(Path.Combine(folder, "device.json"), Wire.Json().Serialize(record)); // inherits the locked folder ACL
                var history = new System.Collections.ArrayList();
                history.Add(Wire.Map("at", Client.UnixNow(), "text", "Support was set up on this PC."));
                if (status == "pending") history.Add(Wire.Map("at", Client.UnixNow(), "text", "Waiting for your support team to approve this PC."));
                File.WriteAllText(Path.Combine(folder, "history.json"), Wire.Json().Serialize(history));

                Scm.Create(DeviceSetup.ServiceName, ServiceDisplay, ServiceDescription, ServiceBinary(exe), true); madeService = true;
                WriteRegistry(exe, Wire.Version, folder, (Wire.Payload(self) + 1023) / 1024); madeRegistry = true;
                Scm.Start(DeviceSetup.ServiceName);
                return status == "pending" ? DeviceSetup.Pending : DeviceSetup.Active;
            } catch (Exception) {
                RollBack(origin, key, folder, madeService, madeRegistry, madeFolder);
                return DeviceSetup.Refused;
            }
        }

        // A crash leftover: tell the relay to forget the PC with any key still in device.json, then remove the folder
        // through handles, so a junction swapped in is removed and never followed.
        static void CleanLeftover(string folder) {
            try {
                var old = ReadDeviceJson(folder);
                if (old != null) { string key = Wire.Text(old, "key"), origin = Wire.Text(old, "origin"); if (key.Length > 0 && origin.Length > 0) new DeviceLink(origin).Leave(key); }
            } catch (Exception) { }
            RemoveFolderAside(folder);
        }
        static Dictionary<string, object> ReadDeviceJson(string folder) {
            try { return Wire.Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(folder, "device.json"))); }
            catch (Exception) { return null; }
        }
        // Undo a failed install, in order, touching only what this run created: leave the relay with the new key,
        // then the service, the registry entries and the folder it made.
        static void RollBack(string origin, string key, string folder, bool service, bool registry, bool folderMade) {
            try { if (key != null && key.Length > 0 && origin.Length > 0) new DeviceLink(origin).Leave(key); } catch (Exception) { }
            if (service) try { Scm.Remove(DeviceSetup.ServiceName); } catch (Exception) { }
            if (registry) RemoveRegistry();
            if (folderMade) RemoveFolderAside(folder);
        }
        // The tray's startup value and the Apps entry, for the app at exe. An update calls it again for each version file.
        internal static void WriteRegistry(string exe, string version, string folder, int sizeKb) {
            using (var hklm = SasShare.Machine()) {
                using (var run = hklm.CreateSubKey(RunKey)) run.SetValue(TrayValueName, TrayRunValue(exe), Microsoft.Win32.RegistryValueKind.String);
                using (var app = hklm.CreateSubKey(AppsKey))
                    foreach (var kv in AppsValues(version, folder, exe, sizeKb))
                        app.SetValue(kv.Key, kv.Value, kv.Value is int ? Microsoft.Win32.RegistryValueKind.DWord : Microsoft.Win32.RegistryValueKind.String);
            }
        }
        public static void RemoveRegistry() {
            try {
                using (var hklm = SasShare.Machine()) {
                    using (var run = hklm.OpenSubKey(RunKey, true)) if (run != null) run.DeleteValue(TrayValueName, false);
                    hklm.DeleteSubKeyTree(AppsKey, false);
                }
            } catch (Exception) { }
        }
    }

    // The display state of a saved PC, as the tray shows it. active and pending are the server's; the rest are local.
    public static class DeviceState {
        public const string Active = "active", Pending = "pending", Expired = "expired", Removed = "removed", UpdateNeeded = "update_needed", Offline = "offline";
    }

    // --device-service: the saved PC's background service (LocalSystem). It checks in with the relay over the
    // /device/ wire, keeps a short local history, serves a status pipe the tray reads, and keeps the doorbell open
    // (Doorbell) so a ring brings a check-in at once. A check-in answer may carry a session (PR 6): the service then
    // asks the person at the PC when it must, and hosts the session (Session, ScreenHost), as SYSTEM with full control
    // or entirely as the signed-in user with limited support. Besides that it installs releases signed with the
    // project key, and nothing else (Updater, DeviceUpdate), and never while a session is waiting or live. The pure
    // parts (the state map, the timing, the status frame, the history and session rules) are static so the native
    // tests can drive them without a live service.
    public sealed class DeviceService : ServiceBase {
        public const string PipeName = "SupportMcpDevice-ui";
        // The tray's pipe: SYSTEM creates instances, interactive users read and write data, never the network.
        internal const string Sddl = "D:P(A;;GA;;;SY)(A;;0x12008B;;;IU)";
        // The uninstall event of 0.5.0, a fixed name; the uninstaller still sets it for trays of that version. Tests: a Local one.
        internal static string UninstallEvent = "Global\\SupportMcpDeviceUninstall";
        // Every tray watches the event UninstallPrefix + a random part kept in device.json ("uninstall_event"), which the
        // service creates and the uninstaller sets. The tray learns the part from the status frame. The tests use a Local one.
        internal static string UninstallPrefix = "Global\\SupportMcpDeviceUninstall-";
        public const long CheckEveryMs = 300000, JitterMaxMs = 30000, RetryMinMs = 60000, RetryMaxMs = 900000, UpdateEveryMs = 6 * 3600 * 1000L, RefreshMinMs = 30000;
        // While the doorbell is connected: every six hours, with up to ten minutes of jitter.
        public const long DoorbellEveryMs = 6 * 3600 * 1000L, DoorbellJitterMaxMs = 600000;
        public const int HistoryCap = 50, PipeReadMax = 65536;

        // ---- the pure parts --------------------------------------------------------------------------------------
        public enum Schedule { Normal, Backoff, Update, Stopped }
        // The next check-in delay on a network error: one minute, doubling each time, capped at fifteen.
        public static long NextBackoff(long current) { return Math.Min(current <= 0 ? RetryMinMs : current * 2, RetryMaxMs); }
        // Five minutes from the last answer, with up to thirty seconds of jitter on top.
        public static long NextCheckDelay(Random r) { return CheckEveryMs + r.Next(0, (int)JitterMaxMs + 1); }
        // The display state and what to do next, from the status before the call and the wire result. status is the
        // last server-known status ("active" or "pending"), not the display state, so a 401 is read correctly.
        public static string Classify(string status, DeviceLink.DeviceResult result, string bodyStatus, out Schedule schedule) {
            if (result == DeviceLink.DeviceResult.Ok) { schedule = Schedule.Normal; return bodyStatus == DeviceState.Pending ? DeviceState.Pending : DeviceState.Active; }
            if (result == DeviceLink.DeviceResult.Removed) { schedule = Schedule.Stopped; return status == DeviceState.Pending ? DeviceState.Expired : DeviceState.Removed; }
            if (result == DeviceLink.DeviceResult.UpdateNeeded) { schedule = Schedule.Update; return DeviceState.UpdateNeeded; }
            schedule = Schedule.Backoff; return DeviceState.Offline; // offline, or an unexpected refusal: keep trying
        }
        // The history lines a 200 adds: approval, and any change the team made to the access or control mode.
        public static List<string> HistoryFor(string oldStatus, string oldAccess, string oldControl, string newStatus, string newAccess, string newControl) {
            var lines = new List<string>();
            if (oldStatus == DeviceState.Pending && newStatus == DeviceState.Active) lines.Add("Your support team approved this PC.");
            if (oldAccess != newAccess) lines.Add(newAccess == "any" ? "Access set to connect any time." : "Access set to ask each time.");
            if (oldControl != newControl) lines.Add(newControl == "full" ? "Control set to full control." : "Control set to limited support.");
            return lines;
        }
        // The status frame the tray reads. confirm is shown only while pending; version is this service's own.
        public static Dictionary<string, object> StatusFrame(string name, string access, string control, string state, string confirm, long lastOkAt, object history) {
            return StatusFrame(name, access, control, state, confirm, lastOkAt, history, null, 0, "");
        }
        // PR 6: "session" {"by","since"} while a session is live (by: who drives it; since: Unix ms), and "uninstall_event",
        // the random part of the uninstall event's name, which the tray watches.
        public static Dictionary<string, object> StatusFrame(string name, string access, string control, string state, string confirm, long lastOkAt, object history, string sessionBy, long since, string uninstallPart) {
            var m = Wire.Map("name", name, "access", access, "control", control, "state", state, "last_ok_at", lastOkAt, "history", history, "version", Wire.Version);
            if (state == DeviceState.Pending && confirm != null && confirm.Length > 0) m["confirm"] = confirm;
            if (sessionBy != null) m["session"] = Wire.Map("by", sessionBy, "since", since);
            if (!string.IsNullOrEmpty(uninstallPart)) m["uninstall_event"] = uninstallPart;
            return m;
        }
        // The last HistoryCap lines are kept, newest last.
        public static void TrimHistory(System.Collections.ArrayList list) { while (list.Count > HistoryCap) list.RemoveAt(0); }
        // A refresh forces a check-in at most once every thirty seconds.
        public static bool RefreshDue(long lastRefresh, long now) { return now - lastRefresh >= RefreshMinMs; }
        // The time to the next check-in. Backoff and a 426 (Update) keep their own; otherwise six hours plus jitter while the
        // doorbell is connected and the PC is active, and five minutes plus jitter while it is not, or the PC is pending.
        public static long NextDelay(Schedule sched, bool doorbell, string status, long backoff, Random r) {
            if (sched == Schedule.Backoff) return backoff;
            if (sched == Schedule.Update) return UpdateEveryMs;
            if (doorbell && status == DeviceState.Active) return DoorbellEveryMs + r.Next(0, (int)DoorbellJitterMaxMs + 1);
            return NextCheckDelay(r);
        }
        // Call 10: control comes from this PC's own setup. A check-in may lower full control to limited, never raise it.
        public static string NextControl(string own, string offered) { return own == "full" && offered != "limited" ? "full" : "limited"; }

        // ---- the session rules (PR 6) --------------------------------------------------------------------------------
        // A hello answer's "session": {"id","by","team","ask","expires_at"}. by and team are shown, so they are cleaned.
        public sealed class SessionPointer { public string Id = "", By = "", Team = ""; public bool Ask = true; public long ExpiresAt; }
        // The pointer, or null when there is none or it is malformed. An ask that is not exactly false counts as true.
        public static SessionPointer ReadSession(Dictionary<string, object> body) {
            object o; if (body == null || !body.TryGetValue("session", out o)) return null;
            var m = o as Dictionary<string, object>; if (m == null) return null;
            object id, ask, by, team, at;
            if (!m.TryGetValue("id", out id) || !(id is string) || !System.Text.RegularExpressions.Regex.IsMatch((string)id, @"^[0-9a-f]{64}\z")) return null;
            m.TryGetValue("by", out by); m.TryGetValue("team", out team);
            long expires = 0;
            if (m.TryGetValue("expires_at", out at) && (at is int || at is long || at is decimal || at is double)) try { expires = Convert.ToInt64(at); } catch (Exception) { }
            return new SessionPointer { Id = (string)id, By = Wire.Clean(by as string, 200), Team = Wire.Clean(team as string, 200), Ask = !(m.TryGetValue("ask", out ask) && false.Equals(ask)), ExpiresAt = expires };
        }
        // Where a session runs: the console session when someone is signed in there; else the one active Remote Desktop
        // session with a user; several of those is Busy (the PC cannot tell whom to ask); none is Nobody (the console).
        public enum Target { Console, Remote, Nobody, Busy }
        public sealed class TargetChoice { public Target Kind; public uint Session = 0xFFFFFFFF; }
        public static TargetChoice PickTarget(uint console, bool consoleUser, IList<uint> remoteUsers) {
            if (console != 0xFFFFFFFF && consoleUser) return new TargetChoice { Kind = Target.Console, Session = console };
            var others = new List<uint>();
            foreach (uint id in remoteUsers) if (id != 0 && id != console && !others.Contains(id)) others.Add(id);
            if (others.Count == 1) return new TargetChoice { Kind = Target.Remote, Session = others[0] };
            if (others.Count > 1) return new TargetChoice { Kind = Target.Busy };
            return new TargetChoice { Kind = Target.Nobody, Session = console };
        }
        public enum Start { Host, Ask, DeclineNobody, DeclineBusy }
        // What a new session does. It asks when the session says so or this PC's own access is "ask"; with nobody signed
        // in, only a full-control PC set to any time runs (at the sign-in screen), and anything that would ask, or a limited
        // PC, is declined as nobody. accepted: the person already allowed this session (a restarted service rejoins it).
        public static Start Decide(bool sessionAsks, string access, string control, Target target, bool accepted) {
            bool ask = sessionAsks || access != "any";
            if (target == Target.Busy) return Start.DeclineBusy;
            if (target == Target.Nobody) return ask || control != "full" ? Start.DeclineNobody : Start.Host;
            return ask && !accepted ? Start.Ask : Start.Host;
        }

        // ---- the running service ---------------------------------------------------------------------------------
        readonly string exe, folder;
        readonly object gate = new object();
        readonly ManualResetEvent stop = new ManualResetEvent(false);
        readonly AutoResetEvent wake = new AutoResetEvent(false);
        readonly Random jitter = new Random();
        readonly System.Collections.ArrayList history = new System.Collections.ArrayList();
        DeviceLink link;
        string origin = "", key = "", deviceId = "", workspace = "";
        string name = "", access = "ask", control = "limited", status = DeviceState.Active, state = DeviceState.Active, confirm = "";
        // uninstallPart: the random part of the uninstall event's name. accepted: the session the person at the PC
        // allowed (or that needed no question), so a restarted service rejoins it without asking again.
        string uninstallPart = "", accepted = "";
        long lastOkAt, lastRefresh = long.MinValue / 2;
        Doorbell bell;
        // The session of the last check-in answer, and the run that handles it (null: none). Under the gate.
        Session current; bool pointer;
        // The corner windows' pipe, made at the first session: "SupportMcp-<cornerId>-ui", so --window <cornerId> finds it.
        UiServer cornerUi; string cornerId = "";
        // The tests replace these: where a session runs, the signed-in user's token, and the question.
        internal Func<TargetChoice> Targets = LiveTarget;
        internal Func<uint, IntPtr> UserTokens = ScreenHost.QueryUser;
        internal Func<uint, SessionPointer, bool, WaitHandle, bool> Asker;
        internal string CornerSddl = UiServer.Sddl;
        bool updateLogged, terminal;
        int allowing;
        int localChanges; // bumped under the gate by each local access change, so CheckIn can spot a stale answer
        Thread worker; UiServer ui; EventWaitHandle uninstall;
        // Updates, all on the worker thread: the key a release must be signed with and how a process is started (tests
        // replace both), this version's open trial, and the staged version file with the handle that holds it.
        string releaseKey = ReleaseKey.ProjectKey;
        Func<string, string, Process> run = RunHidden;
        bool trial, switching;
        FileStream stagedHold; string stagedFile = "";
        Process switcher;
        string lastTry = ""; long lastTryAt;
        long soonMs; // a trial asks the loop to come back this soon (a hello to retry, or a commit to try again)

        public DeviceService(string exe) {
            this.exe = exe; folder = Path.GetDirectoryName(exe);
            ServiceName = DeviceSetup.ServiceName; CanStop = true; CanShutdown = true; AutoLog = false;
            Asker = AskLive;
        }
        protected override void OnStart(string[] args) { worker = new Thread(Run); worker.IsBackground = true; worker.Start(); }
        // A stop ends a live session (the relay sees an end); Windows shutting down keeps it, so the session goes on
        // after the restart (the accepted id is in device.json).
        protected override void OnStop() {
            try { RequestAdditionalTime(30000); } catch (Exception) { }
            stop.Set(); wake.Set(); StopBell();
            Session c; lock (gate) c = current;
            if (c != null) c.Stop(null, true);
            if (worker != null) worker.Join(10000);
            if (c != null) c.Join(8000);
        }
        protected override void OnShutdown() {
            stop.Set(); wake.Set(); StopBell();
            Session c; lock (gate) c = current;
            if (c != null) { c.Stop(null, false); c.Join(5000); }
        }

        void Run() {
            try {
                if (!Prepare()) return; // no device.json, or a damaged one: nothing to run
                uninstall = CreateUninstall();
                StartPipe();
                if (!terminal) StartBell();
                // A removed or expired PC keeps serving the pipe (so the tray shows it) but never checks in again. The
                // loop still runs while its trial is open, until the commit gets through.
                if (!terminal || trial) Loop();
            } catch (Exception) { }
        }
        void StartPipe() {
            try { ui = new UiServer(PipeName, Handle, delegate(uint s) { return true; }, Sddl, 1024); } // the SDDL limits callers to interactive users
            catch (Exception) { ui = null; } // a squatter took the name: the loop retries, and the service still checks in
        }
        // device.json, written by the install. Returns false when it is missing or damaged. A stored terminal state
        // (removed or expired) is kept, so the service serves it without a fresh check-in.
        bool Load() {
            try {
                var m = Wire.Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(folder, "device.json")));
                if (m == null) return false;
                origin = Wire.Text(m, "origin"); key = Wire.Text(m, "key"); deviceId = Wire.Text(m, "device_id"); workspace = Wire.Text(m, "workspace");
                name = Wire.Text(m, "name"); access = Wire.Text(m, "access"); control = Wire.Text(m, "control") == "full" ? "full" : "limited";
                status = Wire.Text(m, "status"); confirm = Wire.Text(m, "confirm");
                uninstallPart = Wire.Text(m, "uninstall_event"); if (!ValidPart(uninstallPart)) uninstallPart = "";
                accepted = Wire.Text(m, "accepted_session"); if (!System.Text.RegularExpressions.Regex.IsMatch(accepted, @"^[0-9a-f]{64}\z")) accepted = "";
                string stored = Wire.Text(m, "state");
                terminal = stored == DeviceState.Removed || stored == DeviceState.Expired;
                state = terminal ? stored : status;
                if (key.Length == 0 || origin.Length == 0) return false;
            } catch (Exception) { return false; }
            LoadHistory();
            return true;
        }
        // Everything before the loop: an update's open trial first (UpdateSwitch.OnStart), then device.json. A removed or
        // expired PC never checks in, so its trial is committed at once. Outside a trial, old version files go (Tidy).
        bool Prepare() {
            UpdateSwitch.Start start = UpdateSwitch.Start.Normal;
            try { var st = UpdateState.TryLoad(folder); if (st != null) start = UpdateSwitch.OnStart(st, exe, Client.UnixNow()); } catch (Exception) { }
            if (start == UpdateSwitch.Start.Interrupted || start == UpdateSwitch.Start.Stale) {
                var m = DeviceUpdate.Lock(30000);
                if (m != null) {
                    try {
                        if (start == UpdateSwitch.Start.Interrupted) DeviceUpdate.RollBackLocked(folder, false, false);
                        else DeviceUpdate.ClearStale(folder, exe);
                    } catch (Exception) { } finally { DeviceUpdate.Unlock(m); }
                }
            }
            // A rollback was decided and written down, but cut short (a restart midway): finish it.
            if (start == UpdateSwitch.Start.ResumeRollback) StartRollback();
            trial = start == UpdateSwitch.Start.Trial;
            if (trial) BeginTrial();
            if (!Load()) return false;
            link = new DeviceLink(origin);
            if (trial && terminal) FinishTrial(DeviceLink.DeviceResult.Ok, 200);
            if (!trial) Tidy();
            return true;
        }
        // This version starts on trial: it records that it started (so an interrupted trial blames it only if it ran),
        // gives itself a fresh trial window, and starts the old file's deadline watcher, so the trial ends even when the
        // switch that opened it is gone (a restart midway).
        void BeginTrial() {
            var m = DeviceUpdate.Lock(30000);
            if (m != null) {
                try {
                    var st = UpdateState.TryLoad(folder);
                    if (st != null && UpdateSwitch.OnStart(st, exe, Client.UnixNow()) == UpdateSwitch.Start.Trial) {
                        st.Started = true; st.Deadline = Math.Max(st.Deadline, Client.UnixNow() + DeviceUpdate.TrialMs); st.Save(folder);
                    }
                } catch (Exception) { } finally { DeviceUpdate.Unlock(m); }
            }
            Launch(DeviceUpdate.WatchArgs);
        }
        void LoadHistory() {
            try {
                var list = Wire.Json().Deserialize<System.Collections.ArrayList>(File.ReadAllText(Path.Combine(folder, "history.json")));
                if (list != null) lock (gate) { history.Clear(); history.AddRange(list); Trim(); }
            } catch (Exception) { }
        }

        void Loop() {
            long backoff = 0;
            var waits = uninstall == null ? new WaitHandle[] { stop, wake } : new WaitHandle[] { stop, wake, uninstall };
            while (!stop.WaitOne(0)) {
                try {
                    if (ui == null) StartPipe(); // retry a pipe the service could not create (a squatter held the name)
                    // A removed or expired PC sends nothing; it only commits a trial still open.
                    if (!terminal) CheckIn(ref backoff); else if (trial) FinishTrial(DeviceLink.DeviceResult.Ok, 200);
                    if (stop.WaitOne(0)) break;
                    Schedule sched; bool done; string st; lock (gate) { sched = lastSchedule; done = terminal; st = status; }
                    if (done) StopBell();
                    if (done && !trial) break; // removed or expired: stop checking in for good; the pipe keeps serving
                    // Both delays are chosen now; which one counts follows the doorbell while waiting, so a doorbell that
                    // drops during a six-hour wait brings the five-minute check-in back.
                    long slow = NextDelay(sched, true, st, backoff, jitter), fast = NextDelay(sched, false, st, backoff, jitter);
                    // A trial asks to come back sooner: a hello to retry, or a commit that found the lock busy.
                    long soon = soonMs; soonMs = 0;
                    long from = PauseClock.Now(); int which = -1;
                    while (true) {
                        long delay = BellUp() ? slow : fast;
                        if (soon > 0) delay = Math.Min(delay, soon);
                        long left = from + delay - PauseClock.Now();
                        if (left <= 0) break;
                        which = WaitHandle.WaitAny(waits, (int)Math.Min(left, 30000));
                        if (which != WaitHandle.WaitTimeout) break;
                    }
                    if (which == 0 || (uninstall != null && which == 2)) break;
                } catch (Exception) {
                    // One bad pass must never end the worker: wait a minute (or until stop) and try again.
                    if (WaitHandle.WaitAny(waits, (int)RetryMinMs) == 0) break;
                }
            }
        }
        Schedule lastSchedule = Schedule.Normal;
        void CheckIn(ref long backoff) {
            // A local "any time" change made while this hello is in flight is newer than its answer's access.
            int seenLocal; lock (gate) seenLocal = localChanges;
            DeviceLink.Answer a;
            try { a = link.Hello(key, Report()); } catch (Exception) { a = new DeviceLink.Answer(DeviceLink.DeviceResult.Offline, 0, null, ""); }
            // A 200 must carry a device object; a malformed one counts as offline, so one bad answer never ends the loop.
            Dictionary<string, object> dev = ReadDev(a.Body);
            DeviceLink.DeviceResult result = a.Result == DeviceLink.DeviceResult.Ok && dev == null ? DeviceLink.DeviceResult.Offline : a.Result;
            Schedule sched;
            string before; lock (gate) before = status;
            string bodyStatus = dev != null ? Wire.Text(dev, "status") : "";
            string newState = Classify(before, result, bodyStatus, out sched);
            lock (gate) {
                lastSchedule = sched;
                if (result == DeviceLink.DeviceResult.Ok) {
                    backoff = 0; lastOkAt = Client.UnixNow();
                    // Access follows the team both ways; control only ever goes down (call 10).
                    string nn = Wire.Text(dev, "name"), na = Wire.Text(dev, "access"), nc = NextControl(control, Wire.Text(dev, "control")), ns = Wire.Text(dev, "status");
                    if (localChanges != seenLocal) na = access; // a stale answer: the next check-in brings the team's view
                    var lines = HistoryFor(status, access, control, ns, na, nc);
                    bool changed = lines.Count > 0 || state != newState || (nn.Length > 0 && nn != name) || na != access || nc != control || ns != status || (ns == DeviceState.Active && confirm.Length > 0);
                    foreach (string line in lines) AddLine(line);
                    if (nn.Length > 0) name = nn;
                    access = na; control = nc; status = ns; state = newState;
                    if (ns == DeviceState.Active) confirm = "";
                    if (changed) Save(); // write only when something actually changed
                } else if (sched == Schedule.Stopped) {
                    state = newState; terminal = true;
                    AddLine(newState == DeviceState.Expired ? "This PC's request was not approved in time." : "Your support team removed this PC.");
                    Save(); // persist the terminal state, so a reboot serves it without a fresh check-in
                } else if (sched == Schedule.Update) {
                    state = newState; backoff = 0;
                    if (!updateLogged && !trial) { updateLogged = true; AddLine("Support needs an update to keep working with your team."); }
                } else {
                    state = newState; backoff = NextBackoff(backoff);
                }
            }
            // Sessions: an active PC's answer only (a pending PC never gets one).
            if (result == DeviceLink.DeviceResult.Ok && bodyStatus == DeviceState.Active) Sessions(ReadSession(a.Body));
            if (trial) FinishTrial(result, a.Status);
            else if ((result == DeviceLink.DeviceResult.Ok || result == DeviceLink.DeviceResult.UpdateNeeded) && !HoldUpdates()) MaybeUpdate(a.Body);
        }
        // An update never cuts a session: none while a session is waiting or live.
        bool HoldUpdates() { lock (gate) return pointer || (current != null && !current.Finished); }

        // ---- updates (Updater, DeviceUpdate) -----------------------------------------------------------------------
        // A check-in pass of a version on trial (UpdateSwitch.TrialHealth). An answer (200 or 202) or a 401 commits. A 426
        // or any other refusal means this version cannot work with the relay, so the old one comes back. No network or a
        // server error keeps the trial open and tries the hello again about every 30 seconds; still so near the deadline,
        // the trial is committed, since a network failure is not the new version's fault.
        void FinishTrial(DeviceLink.DeviceResult result, int status) {
            var health = UpdateSwitch.TrialHealth(result, status);
            if (health == UpdateSwitch.Health.Unhealthy) { trial = false; StartRollback(); return; }
            if (health == UpdateSwitch.Health.Retry) {
                UpdateState st = null;
                try { st = UpdateState.TryLoad(folder); } catch (Exception) { }
                if (st == null || !UpdateSwitch.DecideNow(Client.UnixNow(), st.Deadline)) { soonMs = UpdateSwitch.RetryHelloMs; return; }
            }
            string version;
            var done = DeviceUpdate.Commit(folder, exe, out version);
            if (done == DeviceUpdate.Committed.Busy) { soonMs = UpdateSwitch.CommitRetryMs; return; } // the lock was held: again in seconds
            trial = false;
            if (done == DeviceUpdate.Committed.Done) { lock (gate) AddLine("Support updated to version " + version + "."); }
            Tidy();
        }
        void StartRollback() { Launch(DeviceUpdate.RollbackArgs); }
        // Starts the rollback or the deadline watcher of the open trial: from the old file, or from this one when the old
        // file is gone (the rollback then closes the trial and keeps this version, as there is nothing to go back to).
        void Launch(string args) {
            try {
                var st = UpdateState.TryLoad(folder);
                if (st == null || !st.InTrial) return;
                var p = run(File.Exists(st.From) ? st.From : exe, args);
                if (p != null) p.Dispose();
            } catch (Exception) { }
        }
        // An offered release (the "update" of a hello or a 426): check its signature, note and version, download it,
        // check the size and SHA-256, write it as its own version file and start the switch. Nothing is shown. A release
        // whose download or checks failed is tried again an hour later at the earliest; a version that failed its trial,
        // never.
        void MaybeUpdate(Dictionary<string, object> body) {
            object offered;
            if (body == null || !body.TryGetValue("update", out offered) || !(offered is Dictionary<string, object>)) return;
            if (switching) {
                // A switch that ended without stopping this service (refused, or busy with an install or uninstall). A
                // switch that never started (no process) counts as ended, so switching cannot stick.
                bool over;
                try { over = switcher == null || switcher.HasExited; } catch (Exception) { over = true; }
                if (!over) return;
                DropStaged();
            }
            try {
                var st = UpdateState.TryLoad(folder);
                if (st == null || st.InTrial) return; // unreadable now, or a trial open: not now
                string reason;
                var note = Updater.Check((Dictionary<string, object>)offered, Wire.Version, st.Failed, releaseKey, out reason);
                if (note == null) return;
                long now = PauseClock.Now();
                if (note.Version == lastTry && now - lastTryAt < UpdateSwitch.RetryMs) return;
                lastTry = note.Version; lastTryAt = now;
                byte[] all = link.Download();
                int n = Updater.CheckDownload(all, note);
                if (n < 0) return;
                string file = Stage(all, n, note);
                if (file == null) return;
                st = UpdateState.TryLoad(folder);
                if (st == null || st.InTrial) { DropStaged(); return; } // never write a record over one that cannot be read
                st.StagedFile = file; st.StagedVersion = note.Version; st.StagedSha = note.Sha256; st.StagedSize = note.Size;
                st.Save(folder);
                switching = true;
                switcher = run(exe, DeviceUpdate.SwitchArgs(file));
            } catch (Exception) { DropStaged(); }
        }
        // Writes the exe as support-<version>-<8 hex>.exe in the install folder, with the app's ACL (FullAcl.Window) from
        // the moment it exists, then reads it back and hashes it through a handle that denies writing. That handle stays
        // open until this service stops for the switch, or DropStaged lets it go. Null when anything fails, and then
        // nothing is left behind and no handle stays open.
        string Stage(byte[] all, int n, ReleaseNote note) {
            string file = Path.Combine(folder, UpdateSwitch.VersionFileName(note.Version, Elevation.Nonce().Substring(0, 8)));
            FileStream hold = null; bool made = false;
            try {
                using (var w = new FileStream(file, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.WriteThrough, FullAcl.Window())) { made = true; w.Write(all, 0, n); w.Flush(true); }
                hold = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (hold.Length != note.Size || ReleaseKey.Sha256Hex(hold) != note.Sha256) throw new InvalidDataException("the written file does not match the note");
                stagedHold = hold; stagedFile = file;
                return file;
            } catch (Exception) {
                if (hold != null) try { hold.Dispose(); } catch (Exception) { }
                if (made) try { File.Delete(file); } catch (Exception) { }
                return null;
            }
        }
        // Lets go of a staged file the switch did not take: the process, the handle, the record and the file.
        void DropStaged() {
            switching = false;
            if (switcher != null) { try { switcher.Dispose(); } catch (Exception) { } switcher = null; }
            if (stagedHold != null) { try { stagedHold.Dispose(); } catch (Exception) { } stagedHold = null; }
            if (stagedFile.Length == 0) return;
            try { var st = UpdateState.TryLoad(folder); if (st != null && !st.InTrial && UpdateSwitch.Same(st.StagedFile, stagedFile)) { st.ClearStaged(); st.Save(folder); } } catch (Exception) { }
            try { File.Delete(stagedFile); } catch (Exception) { }
            stagedFile = "";
        }
        // Outside a trial: forgets a staged file no switch took, and deletes every version file but this one and the
        // previous one. One that a tray still runs is renamed aside first (a running exe can be renamed), and only that
        // new name is queued for removal at the next restart, so a file installed later under the old name is never
        // removed by it. Files set aside earlier and free by now go too.
        void Tidy() {
            try {
                var st = UpdateState.TryLoad(folder);
                if (st == null || st.InTrial) return;
                if (st.StagedFile.Length > 0 && !UpdateSwitch.Same(st.StagedFile, stagedFile)) { st.ClearStaged(); st.Save(folder); }
                foreach (string file in UpdateSwitch.Obsolete(Directory.GetFiles(folder, "support*.exe"), exe, st.Previous)) {
                    if (UpdateSwitch.Same(file, stagedFile)) continue;
                    try { File.Delete(file); continue; } catch (Exception) { }
                    string aside = Path.Combine(folder, UpdateSwitch.AsideName(Path.GetFileName(file), Elevation.Nonce().Substring(0, 8)));
                    try { File.Move(file, aside); } catch (Exception) { continue; } // not even renamed: the next tidy tries again
                    try { Native.MoveFileEx(aside, null, 4); } catch (Exception) { }
                }
                foreach (string file in Directory.GetFiles(folder, "support*" + UpdateSwitch.AsideSuffix))
                    if (UpdateSwitch.IsAside(Path.GetFileName(file))) try { File.Delete(file); } catch (Exception) { }
            } catch (Exception) { }
        }
        // A SYSTEM child in session 0 with no window, started in the system folder.
        static Process RunHidden(string file, string args) {
            return Process.Start(new ProcessStartInfo(file, args) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Environment.SystemDirectory });
        }
        Dictionary<string, object> Report() { return Wire.Map("os", DeviceSetup.Os(), "machine", Environment.MachineName, "app_version", Wire.Version); }
        static Dictionary<string, object> ReadDev(Dictionary<string, object> body) { object o; return body != null && body.TryGetValue("device", out o) ? o as Dictionary<string, object> : null; }

        // The pipe handler. status and refresh answer at once; allow_any_time is accepted at once and its relay call
        // runs in the background (the change shows on the next status read), so the pipe never waits on the network.
        // end_session ends a live session, and only for a tray in the session it runs in (callerSession).
        Dictionary<string, object> Handle(Dictionary<string, object> m, uint callerSession) {
            string request = Pipes.DeviceRequest(m);
            if (request == null) return null;
            if (request == "allow_any_time") QueueAllow();
            else if (request == "refresh") Refresh();
            else if (request == "end_session") EndByOwner(callerSession, true);
            return Snapshot();
        }
        Dictionary<string, object> Snapshot() {
            lock (gate) {
                var copy = new System.Collections.ArrayList(history); var c = current; bool live = c != null && c.Hosting;
                return StatusFrame(name, access, control, state, confirm, lastOkAt, copy, live ? c.Driver : null, live ? c.Since : 0, uninstallPart);
            }
        }
        // Call 3: any interactive user may turn on "any time", and only when it is "ask". Nothing here ever sends "ask".
        void QueueAllow() {
            lock (gate) { if (access != "ask" || terminal) return; }
            if (Interlocked.CompareExchange(ref allowing, 1, 0) != 0) return; // one in flight at a time
            ThreadPool.QueueUserWorkItem(delegate { try { AllowAnyTime(); } finally { Interlocked.Exchange(ref allowing, 0); } });
        }
        void AllowAnyTime() {
            lock (gate) { if (access != "ask" || terminal) return; }
            DeviceLink.Answer a;
            try { a = link.Update(key, Wire.Map("access", "any")); } catch (Exception) { return; }
            if (!a.Ok) return;
            lock (gate) {
                var dev = ReadDev(a.Body);
                string na = dev != null ? Wire.Text(dev, "access") : "any";
                if (na != access) { access = na; localChanges++; AddLine("You turned on connect any time from this PC."); Save(); }
            }
        }
        void Refresh() {
            lock (gate) { long now = PauseClock.Now(); if (!RefreshDue(lastRefresh, now)) return; lastRefresh = now; }
            wake.Set();
        }

        // history.json beside device.json, newest last, the last HistoryCap kept. The caller holds the gate.
        void AddLine(string text) { history.Add(Wire.Map("at", Client.UnixNow(), "text", text)); Trim(); SaveHistory(); }
        void Trim() { TrimHistory(history); }
        void SaveHistory() { WriteAtomic(Path.Combine(folder, "history.json"), Wire.Json().Serialize(history)); }
        void Save() {
            var m = Wire.Map("origin", origin, "workspace", workspace, "device_id", deviceId, "key", key, "status", status, "name", name, "access", access, "control", control);
            if (status == DeviceState.Pending && confirm.Length > 0) m["confirm"] = confirm;
            if (terminal) m["state"] = state; // removed or expired, so a reboot serves it without checking in
            if (uninstallPart.Length > 0) m["uninstall_event"] = uninstallPart;
            if (accepted.Length > 0) m["accepted_session"] = accepted;
            WriteAtomic(Path.Combine(folder, "device.json"), Wire.Json().Serialize(m));
        }
        // A line added to history.json by another process (a rollback), while this service is stopped.
        public static void AppendHistory(string folder, string text) {
            try {
                string file = Path.Combine(folder, "history.json");
                System.Collections.ArrayList list = null;
                string text0 = UpdateState.ReadShared(file); // null when there is no file; throws when it cannot be read now
                try { if (text0 != null) list = Wire.Json().Deserialize<System.Collections.ArrayList>(text0); } catch (Exception) { }
                if (list == null) list = new System.Collections.ArrayList(); // missing or damaged: start a new one
                list.Add(Wire.Map("at", Client.UnixNow(), "text", text)); TrimHistory(list);
                WriteAtomic(file, Wire.Json().Serialize(list));
            } catch (Exception) { }
        }
        // A crash midway must never leave a half-written file: write a sibling temp, flushed to disk, and swap it in.
        static void WriteAtomic(string file, string text) {
            try { UpdateState.WriteReplace(file, text); } catch (Exception) { }
        }

        // The uninstall event, created by the service (SYSTEM) and watched by every tray. Interactive users may wait on it
        // and read its owner (not BUILTIN\Users, which includes guests); SYSTEM and Administrators have full control.
        // Its name has a random part, but any signed-in user can read that from the status frame, so whoever opens it
        // checks its owner first (issue #22). One that someone else made first is never used: the service picks a new part.
        public static bool ValidPart(string part) { return part != null && System.Text.RegularExpressions.Regex.IsMatch(part, @"^[0-9a-f]{32}\z"); }
        internal static EventWaitHandle OwnEvent(string name) {
            var sec = new EventWaitHandleSecurity();
            sec.AddAccessRule(new EventWaitHandleAccessRule(FullAcl.SystemSid, EventWaitHandleRights.FullControl, AccessControlType.Allow));
            sec.AddAccessRule(new EventWaitHandleAccessRule(FullAcl.AdminsSid, EventWaitHandleRights.FullControl, AccessControlType.Allow));
            sec.AddAccessRule(new EventWaitHandleAccessRule(FullAcl.InteractiveSid, EventWaitHandleRights.Synchronize | EventWaitHandleRights.ReadPermissions, AccessControlType.Allow));
            EventWaitHandle e; bool created;
            try { e = new EventWaitHandle(false, EventResetMode.ManualReset, name, out created, sec); } catch (Exception) { return null; }
            if (created || OwnerCheck.Trusted(e)) return e;
            e.Dispose(); return null;
        }
        // This service's event: the part from device.json, or a new one (saved) when there is none or a squatter holds it.
        EventWaitHandle CreateUninstall() {
            for (int i = 0; i < 4; i++) {
                string part; lock (gate) { if (!ValidPart(uninstallPart)) { uninstallPart = Elevation.Nonce(); Save(); } part = uninstallPart; }
                var e = OwnEvent(UninstallPrefix + part);
                if (e != null) return e;
                lock (gate) uninstallPart = "";
            }
            return null;
        }
        // A tray opens this to watch for uninstall, from the part its status frame gave; null when there is none to trust.
        public static EventWaitHandle WatchUninstall(string part) { return ValidPart(part) ? OwnerCheck.OpenEvent(UninstallPrefix + part, EventWaitHandleRights.Synchronize) : null; }
        // The uninstaller sets this PC's event (part from device.json), and the fixed name of 0.5.0 for trays still on it,
        // each only when SYSTEM or Administrators own it. Modify is the right needed to Set; Synchronize lets it also wait.
        public static void SignalUninstall(string part) {
            var names = new List<string>(); if (ValidPart(part)) names.Add(UninstallPrefix + part); names.Add(UninstallEvent);
            foreach (string n in names) { try { var e = OwnerCheck.OpenEvent(n, EventWaitHandleRights.Synchronize | EventWaitHandleRights.Modify); if (e != null) using (e) e.Set(); } catch (Exception) { } }
        }

        // The wizard reads a pending PC's six digits from the status pipe once the service is running. It trusts only a
        // server in session 0 (a service), so a squatter in an interactive session cannot feed it a number.
        public static string ReadConfirm() {
            for (int i = 0; i < 10; i++) {
                try {
                    using (var c = Pipes.Client(PipeName)) {
                        c.Connect(1000);
                        if (Pipes.ServerIsService(c.SafePipeHandle)) {
                            Pipes.Write(c, Wire.Map("type", "status"));
                            var r = Pipes.Read(c, PipeReadMax, UiServer.ReadMs);
                            string s = Wire.Text(r, "state");
                            if (s == DeviceState.Pending) return Wire.Text(r, "confirm");
                            if (s.Length > 0) return null;
                        }
                    }
                } catch (Exception) { }
                Thread.Sleep(500);
            }
            return null;
        }

        // ---- the doorbell -------------------------------------------------------------------------------------------
        void StartBell() {
            Doorbell b;
            lock (gate) {
                if (bell != null || terminal) return;
                try { bell = new Doorbell(origin, key, delegate { wake.Set(); }); } catch (Exception) { return; } // a ring or a (re)connect: check in now
                b = bell;
            }
            b.Start();
        }
        void StopBell() { Doorbell b; lock (gate) { b = bell; bell = null; } if (b != null) b.Stop(); }
        bool BellUp() { var b = bell; return b != null && b.Connected; }

        // ---- sessions (PR 6) ---------------------------------------------------------------------------------------
        // The session of each active check-in answer: a new id starts a run, a run whose id is gone from the answer ends
        // locally (the service only goes back to checking in; nothing is uninstalled). A decline that did not reach the
        // relay is sent again while the answer still carries its id, without asking again.
        void Sessions(SessionPointer p) {
            Session end = null, begin = null;
            lock (gate) {
                pointer = p != null;
                if (p == null) {
                    end = current; current = null;
                    if (accepted.Length > 0) { accepted = ""; Save(); }
                } else if (current == null || current.P.Id != p.Id) {
                    end = current; current = begin = new Session(this, p, accepted == p.Id, null);
                } else if (current.Finished && current.DeclineReason != null && !current.DeclineSent) {
                    current = begin = new Session(this, p, false, current.DeclineReason);
                }
            }
            if (end != null) end.Stop(null, true);
            if (begin != null) begin.Begin();
        }
        void Accept(string id) { lock (gate) { if (accepted == id) return; accepted = id; Save(); } }
        // The person at the PC ended the session: from the corner window, or from the tray in the same session.
        void EndByOwner(uint callerSession, bool checkSession) {
            Session c; lock (gate) c = current;
            if (c != null && c.Hosting && (!checkSession || c.Target == callerSession)) c.Stop("owner", true);
        }
        UiServer CornerUi() {
            lock (gate) {
                if (cornerUi != null) return cornerUi;
                string id = Elevation.Nonce().Substring(0, 8);
                try {
                    cornerUi = new UiServer(Backstop.Name(id) + "-ui", CornerStatus, delegate { EndByOwner(0, false); }, delegate(uint s) { Session c = current; return c != null && c.Hosting && c.Target == s; }, CornerSddl);
                    cornerId = id;
                } catch (Exception) { cornerUi = null; } // a squatter took the name: no corner window this time, the next session tries a new one
                return cornerUi;
            }
        }
        // What the corner window reads (ServiceLink): the live session, or "ended" between sessions.
        Dictionary<string, object> CornerStatus() {
            Session c; lock (gate) c = current;
            string access; lock (gate) access = this.access;
            return c != null && c.Hosting ? c.WindowStatus() : Wire.Map("ended", true, "access", access == "any" ? "any" : "ask");
        }
        // Live: the console session when someone is signed in there, else the active Remote Desktop sessions with a user.
        static TargetChoice LiveTarget() {
            uint console = Native.WTSGetActiveConsoleSessionId();
            IntPtr t = ScreenHost.QueryUser(console); bool user = t != IntPtr.Zero; if (user) Native.CloseHandle(t);
            var remote = new List<uint>();
            if (!user) foreach (uint id in Native.ActiveSessions()) {
                if (id == 0 || id == console) continue;
                IntPtr r = ScreenHost.QueryUser(id); if (r != IntPtr.Zero) { Native.CloseHandle(r); remote.Add(id); }
            }
            return PickTarget(console, user, remote);
        }
        // The question, as the signed-in user in their session: support.exe --device-ask with who asks and the team (never
        // the key). Allow is its exit code DeviceAsk.Allowed; anything else, a crash, no answer in time, or stop, is no.
        bool AskLive(uint session, SessionPointer p, bool full, WaitHandle stopped) {
            IntPtr token = ScreenHost.QueryUser(session); if (token == IntPtr.Zero) return false;
            IntPtr job = IntPtr.Zero, process = IntPtr.Zero;
            try {
                job = CommandJob.KillOnClose();
                process = Native.Launch(token, exe, "--device-ask " + DeviceAsk.Encode(p.By, p.Team, full), true, job).Process;
                var clock = Stopwatch.StartNew();
                while (CommandJob.WaitForSingleObject(process, 250) != 0) {
                    if (stopped.WaitOne(0) || stop.WaitOne(0) || clock.ElapsedMilliseconds > DeviceAsk.AnswerMs + 15000) return false;
                }
                uint code; return Native.ExitCode(process, out code) && code == DeviceAsk.Allowed;
            } catch (Exception) { return false; }
            finally {
                if (process != IntPtr.Zero) Native.CloseHandle(process);
                if (job != IntPtr.Zero) Native.CloseHandle(job); // kill-on-close: a question still open goes with it
                Native.CloseHandle(token);
            }
        }
        // {"type":"decline","reason":...} on POST /agent?sid=<id> with the device key, before any hello. True when the relay
        // took it (200) or the session is gone already (a 4xx); false on no answer or a server error, to send it again.
        bool SendDecline(string id, string reason) {
            try {
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2 on .NET 4.5.2
                var req = (HttpWebRequest)WebRequest.Create(origin + "/agent?sid=" + id);
                req.Method = "POST"; req.ContentType = "application/json"; req.AllowAutoRedirect = false;
                req.Timeout = 30000; req.ReadWriteTimeout = 30000; req.Proxy = WebRequest.DefaultWebProxy;
                req.Headers["Authorization"] = "Bearer " + key;
                byte[] bytes = Encoding.UTF8.GetBytes(Wire.Json().Serialize(Wire.Map("type", "decline", "reason", reason))); req.ContentLength = bytes.Length;
                using (var w = req.GetRequestStream()) w.Write(bytes, 0, bytes.Length);
                using (var r = (HttpWebResponse)req.GetResponse()) return (int)r.StatusCode == 200;
            } catch (WebException e) {
                var r = e.Response as HttpWebResponse;
                if (r == null) return false;
                int code = (int)r.StatusCode; r.Close();
                return code >= 400 && code < 500;
            } catch (Exception) { return false; }
        }

        // One session on this PC, on its own thread: the question when one is needed, a decline, or the session itself
        // through a Client on POST /agent?sid=<id> with the device key as a Bearer header. Full control works as SYSTEM
        // on the console session (the sign-in screen too) or the one Remote Desktop session; limited support pins the
        // session and its signed-in user, and every screen operation, command and file is that user's (ScreenHost).
        sealed class Session : IFullControl {
            public readonly SessionPointer P; readonly DeviceService svc; readonly bool rejoin; readonly string forceDecline;
            readonly ManualResetEvent stopped = new ManualResetEvent(false);
            public volatile bool Hosting, Finished, DeclineSent; public volatile string DeclineReason;
            volatile Client client; volatile ScreenHost host; Thread thread; bool limited;
            volatile bool connected, linkUp = true; int busy; long since; uint target = 0xFFFFFFFF;
            readonly object superviseGate = new object();
            public Session(DeviceService svc, SessionPointer p, bool rejoin, string forceDecline) { this.svc = svc; P = p; this.rejoin = rejoin; this.forceDecline = forceDecline; }
            public void Begin() { thread = new Thread(Run); thread.IsBackground = true; thread.Start(); }
            public void Join(int ms) { var t = thread; if (t != null) t.Join(ms); }
            public long Since { get { return Interlocked.Read(ref since); } }
            public uint Target { get { var h = host; return h != null ? h.Session() : target; } }
            // Who drives it now: the welcome's or the last poll's driver, else who asked for it.
            public string Driver { get { var c = client; string d = c == null ? "" : c.Driver; return d.Length > 0 ? d : P.By; } }
            // This PC's access setting now; the corner window words its last message by it.
            string Access { get { string a; lock (svc.gate) a = svc.access; return a == "any" ? "any" : "ask"; } }
            // reason: "owner" when the person at the PC ended it. endRemote false: Windows shuts down, keep it for the restart.
            public void Stop(string reason, bool endRemote) {
                var c = client;
                if (c != null) { if (reason != null) c.EndReason = reason; if (!endRemote) c.EndRemote = false; }
                stopped.Set();
                if (c != null) c.Stop();
            }
            void Run() {
                try {
                    if (forceDecline != null) { Decline(forceDecline); return; }
                    var t = svc.Targets(); target = t.Session;
                    string access, control; lock (svc.gate) { access = svc.access; control = svc.control; }
                    limited = control != "full";
                    var start = Decide(P.Ask, access, control, t.Kind, rejoin);
                    if (start == Start.DeclineBusy) { Decline("busy"); return; }
                    if (start == Start.DeclineNobody) { Decline("nobody"); return; }
                    if (start == Start.Ask) {
                        bool yes = false;
                        try { var ask = svc.Asker; yes = ask != null && ask(t.Session, P, !limited, stopped); } catch (Exception) { }
                        if (stopped.WaitOne(0)) return;
                        if (!yes) { Decline("declined"); return; }
                    }
                    if (stopped.WaitOne(0)) return;
                    Host(t);
                } catch (Exception) { }
                finally { Hosting = false; Finished = true; var h = host; if (h != null) h.Close(); }
            }
            void Decline(string reason) { DeclineReason = reason; DeclineSent = svc.SendDecline(P.Id, reason); }
            void Host(TargetChoice t) {
                // Limited support belongs to the user signed in now: the session is theirs only, and nobody's once they leave.
                SecurityIdentifier user = null;
                if (limited) {
                    IntPtr token = t.Session == 0xFFFFFFFF ? IntPtr.Zero : svc.UserTokens(t.Session);
                    if (token == IntPtr.Zero) { Decline("nobody"); return; }
                    try { using (var id = new WindowsIdentity(token)) user = id.User; } finally { Native.CloseHandle(token); }
                }
                svc.Accept(P.Id);
                var ui = svc.CornerUi(); string corner; lock (svc.gate) corner = svc.cornerId;
                var h = new ScreenHost(svc.exe, "SupportMcpDevice-" + P.Id.Substring(0, 8), svc.exe, corner, 0, limited, limited || t.Kind == DeviceService.Target.Remote, t.Session, user, svc.UserTokens) { Ui = ui };
                // The first connection may take until the session's own end; the relay's welcome then sets the real deadline.
                long left = P.ExpiresAt > 0 ? P.ExpiresAt - global::SupportMcp.Client.UnixNow() : FullState.DayMs;
                var cfg = Wire.Map("origin", svc.origin, "sid", P.Id, "key", "", "startup_ms", Math.Max(600000, Math.Min(FullState.DayMs, left)));
                var c = new Client(cfg, FullState.DayMs) { Full = this, WorkRoot = svc.folder, Bearer = svc.key };
                c.Connected += delegate { connected = true; };
                c.LinkChanged += delegate(bool up) { linkUp = up; };
                c.BusyChanged += delegate(int n) { Thread.VolatileWrite(ref busy, n); };
                h.Client = delegate { return c; };
                h.Helper.Changed += delegate { c.Nudge(); }; // an escape or a desktop switch reaches the relay at once
                host = h; client = c;
                Interlocked.Exchange(ref since, global::SupportMcp.Client.UnixNow()); Hosting = true;
                if (stopped.WaitOne(0)) { c.Dispose(); return; }
                using (new System.Threading.Timer(delegate { Supervise(); }, null, 0, 2000)) { try { c.Run(); } finally { c.Dispose(); } }
            }
            void Supervise() {
                if (!Monitor.TryEnter(superviseGate)) return;
                try {
                    var h = host; if (h == null || !Hosting) return;
                    try { h.Helper.Ensure(); } catch (Exception) { }
                    try { h.EnsureWindow(); } catch (Exception) { }
                } finally { Monitor.Exit(superviseGate); }
            }
            public Dictionary<string, object> WindowStatus() {
                var h = host; var s = h == null ? null : h.Helper.Status; var c = client;
                return Wire.Map("connected", connected, "link", linkUp, "busy", Thread.VolatileRead(ref busy), "paused", s != null && Wire.Number(s, "paused_ms") > 0,
                    "blocked", s != null && Wire.Number(s, "blocked_ms") > 0, "expires_at", c == null ? 0 : c.ExpiresAtMs, "ended", false, "driver", Driver, "access", Access);
            }
            // IFullControl: the ScreenHost does the screen and the user's token.
            public bool Limited { get { return limited; } }
            public string UserName { get { return host.UserName; } }
            public Dictionary<string, object> ScreenOp(Dictionary<string, object> frame, WaitHandle stop) { return host.ScreenOp(frame, stop); }
            public IntPtr UserToken(out string profile) { return host.UserToken(out profile); }
            public void Report(Dictionary<string, object> poll, long serverOffsetMs) { host.Report(poll, serverOffsetMs); }
            public void Welcomed(long expiresAtMs) { }
        }

        // ---- test surface: the native tests drive the real CheckIn, Handle and persistence ----
        internal bool TestInit() { if (!Load()) return false; link = new DeviceLink(origin); return true; }
        long testBackoff;
        internal void TestCheckInOnce() { long b = testBackoff; CheckIn(ref b); testBackoff = b; }
        internal Dictionary<string, object> TestHandle(Dictionary<string, object> m) { return Handle(m, 0); }
        internal Dictionary<string, object> TestHandle(Dictionary<string, object> m, uint callerSession) { return Handle(m, callerSession); }
        internal EventWaitHandle TestCreateUninstall() { return CreateUninstall(); }
        // The current session run: hosting, finished, the decline it sent, and the corner window's status.
        internal bool TestSessionHosting { get { Session c; lock (gate) c = current; return c != null && c.Hosting; } }
        internal bool TestSessionFinished { get { Session c; lock (gate) c = current; return c == null || c.Finished; } }
        internal string TestDeclined { get { Session c; lock (gate) c = current; return c == null ? null : c.DeclineReason; } }
        internal string TestAccepted { get { lock (gate) return accepted; } }
        internal bool TestHoldUpdates { get { return HoldUpdates(); } }
        internal void TestStopSession() { Session c; lock (gate) { c = current; current = null; pointer = false; } if (c != null) { c.Stop(null, true); c.Join(15000); } }
        internal Dictionary<string, object> TestStatus() { return Snapshot(); }
        internal bool TestTerminal { get { return terminal; } }
        // Updates: the key releases are checked against and what starts a process (null: start nothing), then the start
        // as Run does it, the staged file, and letting it go.
        internal void TestUpdates(string key, Func<string, string, Process> runner) { releaseKey = key; run = runner; }
        internal bool TestPrepare() { return Prepare(); }
        internal string TestStaged { get { return stagedFile; } }
        internal bool TestTrial { get { return trial; } }
        internal void TestDropStaged() { DropStaged(); }
        internal static EventWaitHandle TestCreateEvent(string name) {
            var sec = new EventWaitHandleSecurity();
            sec.AddAccessRule(new EventWaitHandleAccessRule(WindowsIdentity.GetCurrent().User, EventWaitHandleRights.FullControl, AccessControlType.Allow));
            bool created; return new EventWaitHandle(false, EventResetMode.ManualReset, name, out created, sec);
        }
        internal static EventWaitHandle TestOpenEvent(string name, EventWaitHandleRights rights) { EventWaitHandle e; return EventWaitHandle.TryOpenExisting(name, rights, out e) ? e : null; }
    }


    // ---- Signed updates ---------------------------------------------------------------------------------------------
    // A saved PC installs a new version of this app by itself, but only a release signed with the project's offline
    // release key (docs/security-model.md). The relay offers a release in a hello's answer or a 426 (src/release.js):
    // the note (ReleaseNote) and its signature. The PC checks the signature against the key built in here, the note,
    // and that the version is newer and has not failed before (Updater), downloads the app, checks its size and SHA-256
    // against the note, writes it as its own version file (DeviceService) and switches to it with a trial and an
    // automatic rollback (DeviceUpdate). One-off session apps never update themselves.

    // The release key: ECDSA P-256, the 64-byte public key X||Y in base64, the same line as release-key.pub at the repo
    // root (test/release.test.js checks they are equal). Self-hosters who build their own app put their own key in both.
    // A base64 string, not a byte array: a constant array initializer would break the reproducible build.
    public static class ReleaseKey {
        public const string ProjectKey = "6oEnKHINMEr2HVlmklxxL9XEcvq1439e1rdY004x54yOw0fVCqNn+OPrtWpENnHQ+blljSYk+GCVIavvxiH5DA==";
        public static bool Verify(byte[] data, byte[] signature) { return Verify(data, signature, ProjectKey); }
        // ECDSA over SHA-256 of data. The signature must be exactly 64 bytes r||s (IEEE P1363): .NET 4.5.2's ECDsaCng takes
        // only that form, and never a DER one (checked on Windows 7 SP1 x86 and Windows 11 x64). xyBase64 is the key.
        public static bool Verify(byte[] data, byte[] signature, string xyBase64) {
            if (data == null || signature == null || signature.Length != 64 || xyBase64 == null) return false;
            try {
                byte[] xy = Convert.FromBase64String(xyBase64);
                if (xy.Length != 64) return false;
                // BCRYPT_ECCKEY_BLOB: the magic "ECS1" (a P-256 public key), the key length 32, then X and Y.
                byte[] blob = new byte[72];
                blob[0] = 0x45; blob[1] = 0x43; blob[2] = 0x53; blob[3] = 0x31;
                blob[4] = 32;
                Buffer.BlockCopy(xy, 0, blob, 8, 64);
                using (System.Security.Cryptography.CngKey key = System.Security.Cryptography.CngKey.Import(blob, System.Security.Cryptography.CngKeyBlobFormat.EccPublicBlob))
                using (var ecdsa = new System.Security.Cryptography.ECDsaCng(key)) {
                    ecdsa.HashAlgorithm = System.Security.Cryptography.CngAlgorithm.Sha256;
                    return ecdsa.VerifyData(data, signature);
                }
            } catch (System.Security.Cryptography.CryptographicException) { return false; }
            catch (FormatException) { return false; }
        }
        public static string Hex(byte[] hash) { return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant(); }
        public static string Sha256Hex(byte[] data, int offset, int count) {
            using (var h = new System.Security.Cryptography.SHA256Cng()) return Hex(h.ComputeHash(data, offset, count));
        }
        public static string Sha256Hex(Stream stream) {
            using (var h = new System.Security.Cryptography.SHA256Cng()) return Hex(h.ComputeHash(stream));
        }
    }

    // A release version: strict SemVer, the pattern of src/version.js (no leading zeros), at most 32 characters.
    public static class SemVer {
        const string Id = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
        static readonly System.Text.RegularExpressions.Regex Pattern = new System.Text.RegularExpressions.Regex(
            @"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-" + Id + @"(?:\." + Id + @")*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z",
            System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        public static bool Valid(string v) { return v != null && v.Length <= 32 && Pattern.IsMatch(v); }
        // SemVer precedence, build metadata ignored: -1, 0 or 1. Throws unless both are Valid.
        public static int Compare(string a, string b) {
            if (!Valid(a) || !Valid(b)) throw new ArgumentException("not a version");
            string[] ca = Core(a).Split('.'), cb = Core(b).Split('.');
            for (int i = 0; i < 3; i++) { int c = Number(ca[i], cb[i]); if (c != 0) return c; }
            string pa = Pre(a), pb = Pre(b);
            if (pa == null || pb == null) return pa == pb ? 0 : pa == null ? 1 : -1;
            string[] ia = pa.Split('.'), ib = pb.Split('.');
            for (int i = 0; i < Math.Min(ia.Length, ib.Length); i++) {
                bool na = Numeric(ia[i]), nb = Numeric(ib[i]); int c;
                if (na && nb) c = Number(ia[i], ib[i]);
                else if (na != nb) c = na ? -1 : 1;
                else c = Math.Sign(string.CompareOrdinal(ia[i], ib[i]));
                if (c != 0) return c;
            }
            return Math.Sign(ia.Length - ib.Length);
        }
        static string NoBuild(string v) { int plus = v.IndexOf('+'); return plus < 0 ? v : v.Substring(0, plus); }
        static string Core(string v) { string s = NoBuild(v); int dash = s.IndexOf('-'); return dash < 0 ? s : s.Substring(0, dash); }
        static string Pre(string v) { string s = NoBuild(v); int dash = s.IndexOf('-'); return dash < 0 ? null : s.Substring(dash + 1); }
        // Digits without leading zeros: the longer is larger, equal lengths compare as text.
        static int Number(string x, string y) { return x.Length != y.Length ? Math.Sign(x.Length - y.Length) : Math.Sign(string.CompareOrdinal(x, y)); }
        static bool Numeric(string s) { if (s.Length == 0) return false; foreach (char c in s) if (c < '0' || c > '9') return false; return true; }
    }

    // The signed release note: exactly five lines, each ending in LF, in this order and nothing else.
    //   support-mcp-release 1 / version <x.y.z> / sha256 <64 lowercase hex> / size <bytes> / released <unix seconds>
    // sha256 and size are those of the exe without a footer. Parse refuses any other text: an extra or missing line,
    // another order, uppercase hex, a CR, a leading zero, a character outside printable ASCII.
    public sealed class ReleaseNote {
        public const string Header = "support-mcp-release 1";
        public string Version, Sha256; public long Size, Released;
        public static ReleaseNote Parse(string text) {
            if (text == null || text.Length == 0 || text.Length > 512 || text[text.Length - 1] != '\n') return null;
            foreach (char c in text) if (c != '\n' && (c < ' ' || c > '~')) return null;
            string[] lines = text.Substring(0, text.Length - 1).Split('\n');
            if (lines.Length != 5 || lines[0] != Header) return null;
            string version = Value(lines[1], "version"), sha = Value(lines[2], "sha256"), size = Value(lines[3], "size"), released = Value(lines[4], "released");
            if (!SemVer.Valid(version) || sha == null || !System.Text.RegularExpressions.Regex.IsMatch(sha, @"^[0-9a-f]{64}\z") || !Whole(size) || !Whole(released)) return null;
            return new ReleaseNote { Version = version, Sha256 = sha, Size = long.Parse(size, System.Globalization.CultureInfo.InvariantCulture), Released = long.Parse(released, System.Globalization.CultureInfo.InvariantCulture) };
        }
        static string Value(string line, string name) { return line.StartsWith(name + " ", StringComparison.Ordinal) ? line.Substring(name.Length + 1) : null; }
        static bool Whole(string s) { return s != null && System.Text.RegularExpressions.Regex.IsMatch(s, @"^[1-9][0-9]{0,15}\z"); }
    }

    // Whether an offered update is taken, as pure functions the native tests drive.
    public static class Updater {
        // The update object of an answer ({"version","note","signature"}) checked against the key: the signature over the
        // note's exact bytes, the note's form, the outer version (when present) equal to the note's, a version newer than
        // current that has not failed its trial before, and a size the download can carry. Returns the note, or null and
        // why not.
        public static ReleaseNote Check(Dictionary<string, object> update, string current, ICollection<string> failed, string keyXy, out string reason) {
            object o;
            string note = update != null && update.TryGetValue("note", out o) ? o as string : null;
            string sig = update != null && update.TryGetValue("signature", out o) ? o as string : null;
            reason = "no release";
            if (note == null || sig == null) return null;
            byte[] signature;
            try { signature = Convert.FromBase64String(sig); } catch (FormatException) { reason = "bad signature"; return null; }
            reason = "bad signature";
            if (!ReleaseKey.Verify(Encoding.UTF8.GetBytes(note), signature, keyXy)) return null;
            var parsed = ReleaseNote.Parse(note);
            reason = "bad note";
            if (parsed == null) return null;
            reason = "version mismatch";
            if (update.TryGetValue("version", out o) && !(o is string && (string)o == parsed.Version)) return null;
            reason = "not newer";
            if (!SemVer.Valid(current) || SemVer.Compare(parsed.Version, current) <= 0) return null;
            reason = "failed before";
            if (failed != null && failed.Contains(parsed.Version)) return null;
            reason = "too large";
            if (parsed.Size > DeviceLink.DownloadCap) return null;
            reason = "";
            return parsed;
        }
        // The exe in a download, after its footer is stripped, checked against the note's size and SHA-256. Returns the
        // exe's length, or -1.
        public static int CheckDownload(byte[] all, ReleaseNote note) {
            if (all == null || note == null) return -1;
            int n;
            try { n = Wire.Payload(all); } catch (InvalidDataException) { return -1; }
            if (n != note.Size || n < 2 || all[0] != 77 || all[1] != 90) return -1;
            return ReleaseKey.Sha256Hex(all, 0, n) == note.Sha256 ? n : -1;
        }
    }

    // update.json beside device.json, with the locked folder's ACL: the versions that failed their trial (never taken
    // again), the file of the version before the current one (kept as the last good one), the version file the service
    // staged for the switch with its size and SHA-256, and an open trial. Written whole through a temp file flushed to
    // disk, and read with every sharing mode, so a reader never blocks a writer. A read-modify-write that cannot read
    // the file (TryLoad null) writes nothing, so an unreadable record is never replaced by an empty one.
    //   {"failed":[...],"previous":"<exe>","staged":{"file","version","sha256","size"},
    //    "trial":{"phase":"trial"|"rollback","from","from_version","to","version","deadline","started"}}
    // started: the new version's service has run (DeviceService.BeginTrial), so an interrupted trial may blame it.
    public sealed class UpdateState {
        public const string FileName = "update.json", Trial = "trial", RollingBack = "rollback";
        public const int FailedCap = 20, SaveTries = 5;
        public readonly List<string> Failed = new List<string>();
        public string Previous = "";
        public string StagedFile = "", StagedVersion = "", StagedSha = ""; public long StagedSize;
        public string Phase = "", From = "", FromVersion = "", To = "", Version = ""; public long Deadline; public bool Started;
        public bool InTrial { get { return Phase == Trial || Phase == RollingBack; } }
        public void AddFailed(string version) { if (!Failed.Contains(version)) Failed.Add(version); while (Failed.Count > FailedCap) Failed.RemoveAt(0); }
        public void ClearStaged() { StagedFile = StagedVersion = StagedSha = ""; StagedSize = 0; }
        public void ClearTrial() { Phase = From = FromVersion = To = Version = ""; Deadline = 0; Started = false; }
        // A missing file is an empty state; a damaged one too, so a bad file never blocks the service. Read-only checks
        // only: a caller that saves uses TryLoad.
        public static UpdateState Load(string folder) { return TryLoad(folder) ?? new UpdateState(); }
        // null when the file exists but cannot be read now, after a few short tries (a watcher then keeps watching, and
        // a read-modify-write does nothing).
        public static UpdateState TryLoad(string folder) {
            var st = new UpdateState();
            string file = Path.Combine(folder, FileName), text = null;
            for (int i = 0; ; i++) {
                try { text = ReadShared(file); break; }
                catch (IOException) { if (i >= 2) return null; }
                catch (UnauthorizedAccessException) { if (i >= 2) return null; }
                Thread.Sleep(50);
            }
            if (text == null) return st;
            Dictionary<string, object> m;
            try { m = Wire.Json().Deserialize<Dictionary<string, object>>(text); } catch (Exception) { return st; }
            if (m == null) return st;
            object o;
            if (m.TryGetValue("failed", out o) && o is System.Collections.ArrayList)
                foreach (object v in (System.Collections.ArrayList)o) if (v is string && SemVer.Valid((string)v)) st.AddFailed((string)v);
            st.Previous = Wire.Text(m, "previous");
            try {
                if (m.TryGetValue("staged", out o) && o is Dictionary<string, object>) {
                    var s = (Dictionary<string, object>)o;
                    st.StagedFile = Wire.Text(s, "file"); st.StagedVersion = Wire.Text(s, "version"); st.StagedSha = Wire.Text(s, "sha256"); st.StagedSize = Wire.Number(s, "size");
                }
                if (m.TryGetValue("trial", out o) && o is Dictionary<string, object>) {
                    var t = (Dictionary<string, object>)o;
                    st.Phase = Wire.Text(t, "phase"); st.From = Wire.Text(t, "from"); st.FromVersion = Wire.Text(t, "from_version");
                    st.To = Wire.Text(t, "to"); st.Version = Wire.Text(t, "version"); st.Deadline = Wire.Number(t, "deadline");
                    object started; st.Started = t.TryGetValue("started", out started) && started is bool && (bool)started;
                    if (!st.InTrial) st.ClearTrial();
                }
            } catch (Exception) { st.ClearStaged(); st.ClearTrial(); }
            return st;
        }
        // Throws when update.json cannot be written after a few short tries; the caller then changes nothing more.
        public void Save(string folder) {
            var m = Wire.Map("failed", Failed.ToArray(), "previous", Previous);
            if (StagedFile.Length > 0) m["staged"] = Wire.Map("file", StagedFile, "version", StagedVersion, "sha256", StagedSha, "size", StagedSize);
            if (InTrial) {
                var t = Wire.Map("phase", Phase, "from", From, "from_version", FromVersion, "to", To, "version", Version, "deadline", Deadline);
                if (Started) t["started"] = true;
                m["trial"] = t;
            }
            WriteReplace(Path.Combine(folder, FileName), Wire.Json().Serialize(m));
        }
        // The whole text of file, read with every sharing mode (a writer may replace or delete it meanwhile). null when
        // there is no file. Throws IOException or UnauthorizedAccessException when it cannot be read now.
        internal static string ReadShared(string file) {
            try {
                using (var f = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var r = new StreamReader(f, Encoding.UTF8)) return r.ReadToEnd();
            } catch (FileNotFoundException) { return null; } catch (DirectoryNotFoundException) { return null; }
        }
        // Writes text to a sibling temp file, flushed to disk, and swaps it in for file. A few short tries, as a reader
        // or a virus scanner may hold the file for a moment; the last failure is thrown.
        internal static void WriteReplace(string file, string text) {
            byte[] data = new UTF8Encoding(false).GetBytes(text);
            string temp = file + ".new";
            for (int i = 1; ; i++) {
                try {
                    using (var f = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { f.Write(data, 0, data.Length); f.Flush(true); }
                    if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file);
                    return;
                } catch (IOException) { if (i >= SaveTries) throw; }
                catch (UnauthorizedAccessException) { if (i >= SaveTries) throw; }
                Thread.Sleep(100 * i);
            }
        }
    }

    // The switch's rules, as pure functions the native tests drive.
    public static class UpdateSwitch {
        // TrialMs: how long a new version has to finish a healthy check-in pass. StaleMs: past its deadline by this much,
        // an open trial no longer makes uninstall wait, and a service it does not name clears it. RetryMs: a release whose
        // download or checks failed is tried again after this long at the earliest. RetryHelloMs: a trial with no network
        // (or a server error) tries its hello again this often. DecideBeforeMs: that close to the deadline, a trial still
        // without a network commits, before the watcher would roll it back (a hello can itself take a minute to fail).
        // CommitRetryMs: a commit that found the lock busy tries again this soon.
        public const long TrialMs = 240000, StaleMs = 600000, RetryMs = 3600000, RetryHelloMs = 30000, DecideBeforeMs = 90000, CommitRetryMs = 5000;
        // --device-update and --device-update-rollback exit codes.
        public const int Ok = 0, Busy = 30, Refused = 31, RolledBack = 32;
        public enum Start { Normal, Trial, Interrupted, Waiting, ResumeRollback, Stale }
        public enum Health { Healthy, Unhealthy, Retry }
        static readonly System.Text.RegularExpressions.Regex VersionName = new System.Text.RegularExpressions.Regex(@"^support-(.+)-[0-9a-f]{8}\.exe\z",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        public static string VersionFileName(string version, string hex8) { return "support-" + version + "-" + hex8 + ".exe"; }
        // An obsolete version file still in use is renamed to this before it is queued for removal at the next restart.
        public const string AsideSuffix = ".del";
        static readonly System.Text.RegularExpressions.Regex AsidePattern = new System.Text.RegularExpressions.Regex(@"^support[^\\/]*\.exe\.[0-9a-f]{8}\.del\z",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        public static string AsideName(string name, string hex8) { return name + "." + hex8 + AsideSuffix; }
        public static bool IsAside(string name) { return name != null && AsidePattern.IsMatch(name); }
        // support.exe (a fresh install) or support-<version>-<8 hex>.exe (an update).
        public static bool IsVersionFile(string name) {
            if (name == null) return false;
            if (string.Equals(name, "support.exe", StringComparison.OrdinalIgnoreCase)) return true;
            var m = VersionName.Match(name);
            return m.Success && SemVer.Valid(m.Groups[1].Value);
        }
        public static bool Same(string a, string b) {
            if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return false;
            try { return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase); } catch (Exception) { return false; }
        }
        // The file sits directly in folder.
        public static bool InFolder(string file, string folder) {
            try {
                string dir = Path.GetDirectoryName(Path.GetFullPath(file));
                return dir != null && string.Equals(dir.TrimEnd('\\'), Path.GetFullPath(folder).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
            } catch (Exception) { return false; }
        }
        // What the service at self does at start about update.json, at now (Unix ms). Trial: this version is on trial, and
        // its check-ins decide. Interrupted: the trial away from this version never finished (a restart or a crash
        // midway), so this version puts itself back. ResumeRollback: the rollback away from this version was decided and
        // written down but cut short, so this version starts it again. Stale: the record names other files and is past its
        // deadline by StaleMs, so it is cleared (the failed versions and the previous file stay). Waiting: a rollback is
        // under way, or a recent record names other files: touch nothing.
        public static Start OnStart(UpdateState st, string self, long now) {
            if (!st.InTrial) return Start.Normal;
            if (st.Phase == UpdateState.Trial && Same(st.To, self)) return Start.Trial;
            if (Same(st.From, self)) return Start.Interrupted;
            if (st.Phase == UpdateState.RollingBack && Same(st.To, self)) return Start.ResumeRollback;
            if (now >= st.Deadline + StaleMs) return Start.Stale;
            return Start.Waiting;
        }
        // A check-in pass of a version on trial. Healthy: an answer (200 or 202) or a 401 (the PC was removed, which is
        // not the version's fault). Retry: no network or a server error (5xx): try again, and decide at the deadline.
        // Unhealthy: a 426 or any other refusal (a 4xx), so the old version comes back.
        public static Health TrialHealth(DeviceLink.DeviceResult result, int status) {
            if (result == DeviceLink.DeviceResult.Ok || result == DeviceLink.DeviceResult.Pending || result == DeviceLink.DeviceResult.Removed) return Health.Healthy;
            if (result == DeviceLink.DeviceResult.Offline || status == 0 || status >= 500) return Health.Retry;
            return Health.Unhealthy;
        }
        // A trial still without a network commits from DecideBeforeMs before its deadline on.
        public static bool DecideNow(long now, long deadline) { return now >= deadline - DecideBeforeMs; }
        // The switch stops watching once the trial of file is committed, or someone else rolls it back.
        public static bool WatchOver(UpdateState st, string file) { return !(st.Phase == UpdateState.Trial && Same(st.To, file)); }
        // Uninstall waits for an open trial, but not for one long past its deadline: a stuck record must not block it.
        public static bool UninstallBusy(UpdateState st, long now) { return st.InTrial && now < st.Deadline + StaleMs; }
        // The version files to remove: every one but the current and the previous.
        public static List<string> Obsolete(IEnumerable<string> files, string current, string previous) {
            var list = new List<string>();
            foreach (string f in files) if (IsVersionFile(Path.GetFileName(f)) && !Same(f, current) && !Same(f, previous)) list.Add(f);
            return list;
        }
    }

    // --device-update <file> and --device-update-rollback [--at-deadline], all SYSTEM with no window, and started only by
    // the service (or, for the rollback, by its failure action). The service, having staged a checked version file,
    // starts its own exe with --device-update and that file. The switch takes the setup lock, records the trial in
    // update.json, makes every failure of the service run the old exe with --device-update-rollback, stops the service,
    // points the service, the tray's startup value and the Apps entry at the new file, and starts it. The new service
    // commits the trial after a healthy check-in pass or, on a refusal, starts the rollback. It also starts the old exe
    // with --device-update-rollback --at-deadline, a watcher that outlives a restart: the switch's own watch ends with a
    // restart, so after one the new service starts a new watcher at its own start. Either watcher rolls back when the
    // trial is still open at its deadline. A rollback points everything at the old file again, puts the normal restarts
    // back and records the version as failed, so it is never taken again.
    public static class DeviceUpdate {
        // Tests: Dry records the service and registry changes in DryLog instead of making them; LockName is the lock (a
        // Local one in tests); TrialMs and PollMs time the watch.
        internal static bool Dry = false;
        internal static readonly List<string> DryLog = new List<string>();
        internal static string LockName = DeviceInstall.SetupMutexName;
        internal static long TrialMs = UpdateSwitch.TrialMs;
        internal static int PollMs = 2000;
        // A rollback starts the old service again for this long (with a growing wait between tries) when it will not start,
        // for example while a user holds the old file open without sharing.
        internal static long StartRetryMs = 300000;
        // How long a service-configuration change keeps retrying. While Windows starts its automatic services at boot the
        // service database is locked (ERROR_SERVICE_DATABASE_LOCKED), and a rollback the failure action runs then would
        // otherwise fail to point the service back.
        internal static long ConfigRetryMs = 300000;

        public static string SwitchArgs(string file) { return "--device-update \"" + file + "\""; }
        public static string RollbackCommand(string exe) { return "\"" + exe + "\" --device-update-rollback"; }
        public const string RollbackArgs = "--device-update-rollback", AtDeadline = "--at-deadline", WatchArgs = RollbackArgs + " " + AtDeadline;

        // The setup lock (DeviceInstall.SetupMutex): one install, uninstall, switch, commit or rollback at a time. null
        // when another still holds it after ms.
        internal static Mutex Lock(int ms) {
            Mutex m = null;
            try {
                m = DeviceInstall.SetupMutex(LockName);
                bool held; try { held = m.WaitOne(ms); } catch (AbandonedMutexException) { held = true; }
                if (held) return m;
            } catch (Exception) { }
            if (m != null) m.Dispose();
            return null;
        }
        internal static void Unlock(Mutex m) { try { m.ReleaseMutex(); } catch (Exception) { } m.Dispose(); }

        // --device-update <file>. self is this exe, the one the service runs now; folder is the install folder.
        public static int Switch(string self, string file, string folder) {
            try { file = Path.GetFullPath(file); } catch (Exception) { return UpdateSwitch.Refused; }
            if (!UpdateSwitch.InFolder(file, folder) || !UpdateSwitch.IsVersionFile(Path.GetFileName(file)) || UpdateSwitch.Same(file, self)) return UpdateSwitch.Refused;
            var m = Lock(0);
            if (m == null) return UpdateSwitch.Busy;
            try {
                var st = UpdateState.TryLoad(folder);
                if (st == null) return UpdateSwitch.Busy; // unreadable now: change nothing
                if (st.InTrial || !UpdateSwitch.Same(st.StagedFile, file)) return UpdateSwitch.Refused;
                // Still what the service checked: hashed again through a handle that denies writing, held until the new
                // service runs. The using closes it on every path, before the watch below.
                using (var hold = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                    if (hold.Length != st.StagedSize || ReleaseKey.Sha256Hex(hold) != st.StagedSha) return UpdateSwitch.Refused;
                    string version = st.StagedVersion;
                    st.ClearStaged();
                    st.Phase = UpdateState.Trial; st.From = self; st.FromVersion = Wire.Version; st.To = file; st.Version = version;
                    st.Deadline = Client.UnixNow() + TrialMs; st.Started = false;
                    st.Save(folder);
                    try {
                        SetActions(RollbackCommand(self));
                        Stop();
                        Repoint(file, version, folder);
                        Start(false); // the new version: its failure action, not a retry here, handles a start that fails
                    } catch (Exception) {
                        // The switch itself failed, so the new version is failed only if its service ever ran.
                        try { RollBackLocked(folder, true, false); } catch (Exception) { Start(true); }
                        return UpdateSwitch.RolledBack;
                    }
                }
            } catch (Exception) {
                return UpdateSwitch.Refused;
            } finally { Unlock(m); }
            return Watch(folder, file);
        }

        // Watches the open trial of file until it is committed or rolled back by someone else (Ok), or rolls it back once
        // it is still open at its deadline, and at least TrialMs after the watch began (RolledBack). The deadline is read
        // from update.json each time, so a trial window the new version renewed at its start counts. A deadline further
        // away than twice TrialMs (a damaged record) is not waited for.
        static int Watch(string folder, string file) {
            var clock = Stopwatch.StartNew();
            while (true) {
                Thread.Sleep(PollMs);
                var now = UpdateState.TryLoad(folder);
                if (now == null) continue;
                if (UpdateSwitch.WatchOver(now, file)) return UpdateSwitch.Ok;
                if (!Due(now, clock)) continue;
                var again = Lock(60000);
                if (again == null) continue;
                try {
                    var st = UpdateState.TryLoad(folder);
                    if (st == null) continue;
                    if (UpdateSwitch.WatchOver(st, file)) return UpdateSwitch.Ok;
                    if (!Due(st, clock)) continue;
                    try { RollBackLocked(folder, true, true); } catch (IOException) { continue; } // update.json unreadable now: look again
                    return UpdateSwitch.RolledBack;
                } finally { Unlock(again); }
            }
        }
        static bool Due(UpdateState st, Stopwatch clock) {
            long ran = clock.ElapsedMilliseconds;
            return ran >= TrialMs && (Client.UnixNow() >= st.Deadline || ran >= 2 * TrialMs);
        }

        // --device-update-rollback --at-deadline: the new service starts this from the old exe when it starts on trial. It
        // renews the deadline to a fresh trial window from now (never shortening it), then watches like the switch, so a
        // trial whose switch was ended by a restart still ends: committed by the new version, or rolled back at the
        // deadline. Ok when there is no trial to watch.
        public static int WatchDeadline(string folder) {
            string to;
            var m = Lock(120000);
            if (m == null) return UpdateSwitch.Busy;
            try {
                var st = UpdateState.TryLoad(folder);
                if (st == null) return UpdateSwitch.Busy;
                if (st.Phase != UpdateState.Trial) return UpdateSwitch.Ok;
                to = st.To;
                long fresh = Client.UnixNow() + TrialMs;
                if (st.Deadline < fresh) { st.Deadline = fresh; st.Save(folder); }
            } finally { Unlock(m); }
            return Watch(folder, to);
        }

        // --device-update-rollback: the service's failure action during a trial, or the new service on a refusal. With no
        // trial open (a crash after the commit raced it), it only puts the normal restarts back and starts the service.
        // With update.json unreadable it changes nothing and only starts the service, so a next failure tries again.
        public static int RollBack(string folder) {
            var m = Lock(120000);
            if (m == null) return UpdateSwitch.Busy;
            try {
                bool rolled;
                try { rolled = RollBackLocked(folder, true, true); }
                catch (IOException) { Start(false); return UpdateSwitch.Busy; }
                if (rolled) return UpdateSwitch.RolledBack;
                try { SetActions(null); } catch (Exception) { }
                Start(true);
                return UpdateSwitch.Ok;
            } finally { Unlock(m); }
        }

        // Puts the old version back; the caller holds the lock. restart stops the service first and starts it after,
        // in a finally, so an exception midway never leaves it stopped; the old version finishing an interrupted trial
        // at its own start passes false. blame records the version as failed; without it (an interrupted switch) the
        // version is failed only if update.json says its service started. The version is recorded first, so even a
        // rollback cut short never takes it again. False when no trial was open; IOException when update.json cannot be
        // read (nothing changed).
        internal static bool RollBackLocked(string folder, bool restart, bool blame) {
            var st = UpdateState.TryLoad(folder);
            if (st == null) throw new IOException("update.json cannot be read now");
            if (!st.InTrial) return false;
            try {
                string from = st.From, fromVersion = st.FromVersion, version = st.Version;
                if (st.Phase == UpdateState.Trial) { st.Phase = UpdateState.RollingBack; if (blame || st.Started) st.AddFailed(version); st.Save(folder); }
                if (restart) Stop();
                // Only a rollback that pointed everything back finishes. Otherwise the trial stays in its rollback phase and the
                // rollback command stays the failure action, so the new version's next failure (or the old version's next
                // start) runs it again; nothing claims a rollback that did not happen.
                // With the old file gone there is nothing to go back to: the trial ends on the new version.
                bool gone = !File.Exists(from), pointed = gone;
                if (!gone) { try { Repoint(from, fromVersion, folder); pointed = true; } catch (Exception) { } }
                if (!pointed) return true;
                try { SetActions(null); } catch (Exception) { }
                DeviceService.AppendHistory(folder, gone ? "Support couldn't update to version " + version + "." : "Support couldn't update to version " + version + ", so it went back to version " + fromVersion + ".");
                st = UpdateState.TryLoad(folder);
                if (st == null) throw new IOException("update.json cannot be read now"); // the next start of the old version finishes it
                st.ClearTrial(); st.Save(folder);
                return true;
            } finally { if (restart) Start(true); }
        }
        // The service at self found a trial record about other files, long past its deadline: it is cleared, keeping the
        // failed versions and the previous file. The caller holds the lock.
        internal static void ClearStale(string folder, string self) {
            var st = UpdateState.TryLoad(folder);
            if (st == null || UpdateSwitch.OnStart(st, self, Client.UnixNow()) != UpdateSwitch.Start.Stale) return;
            st.ClearTrial(); st.Save(folder);
        }

        public enum Committed { Done, NoTrial, Busy }
        // The new service at self after a healthy pass: the normal restarts come back and the trial closes; the old file
        // stays as the previous one. Busy: the lock was held, or update.json could not be read or written; try again soon.
        internal static Committed Commit(string folder, string self, out string version) {
            version = "";
            var m = Lock(60000);
            if (m == null) return Committed.Busy;
            try {
                var st = UpdateState.TryLoad(folder);
                if (st == null) return Committed.Busy;
                if (UpdateSwitch.OnStart(st, self, Client.UnixNow()) != UpdateSwitch.Start.Trial) return Committed.NoTrial;
                try { SetActions(null); } catch (Exception) { }
                version = st.Version; st.Previous = st.From; st.ClearTrial(); st.Save(folder);
                return Committed.Done;
            } catch (Exception) { return Committed.Busy; }
            finally { Unlock(m); }
        }

        // The service's command line, the tray's startup value and the Apps entry (64-bit view), all for exe.
        static void Repoint(string exe, string version, string folder) {
            if (Dry) { if (DryRepointFails) throw new Win32Exception(1055); Log("point " + exe + " " + version); return; }
            Retrying(delegate { Scm.SetBinary(DeviceSetup.ServiceName, DeviceInstall.ServiceBinary(exe)); });
            // The service's command line is what counts; the tray's startup value and the Apps entry are best effort.
            try { DeviceInstall.WriteRegistry(exe, version, folder, (int)((new System.IO.FileInfo(exe).Length + 1023) / 1024)); } catch (Exception) { }
        }
        static void SetActions(string rollbackCommand) {
            if (Dry) { Log(rollbackCommand == null ? "actions restart" : "actions " + rollbackCommand); return; }
            Retrying(delegate { Scm.SetFailureActions(DeviceSetup.ServiceName, rollbackCommand); });
        }
        // Runs a configuration change, retrying only while the service database is locked (1055) for ConfigRetryMs
        // (waiting 1 s, then 2, 4 and so on up to 15 s). Any other error, and the last one, is thrown.
        static void Retrying(Action change) {
            var clock = Stopwatch.StartNew(); int wait = 1000;
            while (true) {
                try { change(); return; }
                catch (Win32Exception e) { if (e.NativeErrorCode != 1055 || clock.ElapsedMilliseconds >= ConfigRetryMs) throw; }
                Thread.Sleep(wait); wait = Math.Min(wait * 2, 15000);
            }
        }
        // Tests only: makes the dry repoint fail, as a locked service database would.
        internal static bool DryRepointFails = false;
        static void Stop() { if (Dry) Log("stop"); else Scm.StopAndWait(DeviceSetup.ServiceName, 60000); }
        // Starts the service. retry: keep trying for StartRetryMs, waiting 1 s, then 2, 4 and so on up to 30 s between tries,
        // so a user who holds the old file open without sharing only delays the rollback. Never throws.
        static void Start(bool retry) {
            if (Dry) { Log("start"); return; }
            var clock = Stopwatch.StartNew(); int wait = 1000;
            while (true) {
                Scm.StartTolerant(DeviceSetup.ServiceName);
                if (!retry) return;
                var status = Scm.Status(DeviceSetup.ServiceName);
                if (status == null || status == ServiceControllerStatus.Running || status == ServiceControllerStatus.StartPending) return; // running, or gone
                if (clock.ElapsedMilliseconds >= StartRetryMs) return;
                try { Thread.Sleep(wait); } catch (Exception) { return; }
                wait = Math.Min(wait * 2, 30000);
            }
        }
        static void Log(string line) { lock (DryLog) DryLog.Add(line); }
    }

    // The tray's words and choices, kept apart from its windows so the native tests can check them. The one-way rule
    // (call 3): the only access action is turning on "any time", shown only while the PC is active and asks first.
    // There is no action that sets "ask"; only the support team can switch back.
    public static class TrayText {
        public const string NoOne = "No one is connected.";
        public const string NotRunning = "Support's background service isn't running.";
        public const string TeamOnly = "Only your support team can change this.";
        public const string AllowAction = "Allow support to connect any time";
        public const string AllowConfirm = "Allow support to connect any time? You can't undo this from this PC. Only your support team can turn it back to asking first.";
        public const string Uninstall = "Uninstall Support…";
        public const string AdminsCanChange = "Your support team's admins can change this.";
        public const string EndSession = "End session";
        public static readonly string UninstallMissing = DeviceSetup.UninstallText;
        public static string Mode(string access) { return access == "any" ? "Support can connect any time." : "Support asks you before each connection. " + AdminsCanChange; }
        // While a session is live: who is connected (the status frame's session.by).
        public static string SessionLine(string by) { return "Connected: " + (string.IsNullOrEmpty(by) ? "your support team" : by); }
        public static string State(string state, string confirm) {
            if (state == DeviceState.Active) return "Your support team can see this PC.";
            if (state == DeviceState.Pending) { string d = DeviceSetup.ShowConfirm(confirm); return d != null ? "Waiting for approval: read them " + d + "." : "Waiting for approval."; }
            if (state == DeviceState.Expired) return "This PC's request wasn't approved, or was removed. Set up again with a new code.";
            if (state == DeviceState.Removed) return "Your support team removed this PC.";
            if (state == DeviceState.UpdateNeeded) return "Support needs an update.";
            if (state == DeviceState.Offline) return "Can't reach your support team right now.";
            return NotRunning;
        }
        // The panel's actions for a state and mode. "allow_any_time" only while active and asking first; "uninstall"
        // always. Nothing here ever sets "ask".
        public static List<string> Actions(string state, string access) { return Actions(state, access, false); }
        // live: a session is connected now, so "end_session" shows too.
        public static List<string> Actions(string state, string access, bool live) {
            var list = new List<string>();
            if (state == DeviceState.Active && access == "ask") list.Add("allow_any_time");
            if (live) list.Add("end_session");
            list.Add("uninstall");
            return list;
        }
        public static bool ShowTeamOnly(string state, string access) { return access == "any" && ShowMode(state); }
        // A removed or unapproved PC has no access left, so it shows no mode line.
        public static bool ShowMode(string state) { return state != DeviceState.Removed && state != DeviceState.Expired; }
        // The newest few history lines, newest first.
        public static List<string> Recent(System.Collections.ArrayList history, int n) {
            var lines = new List<string>();
            if (history == null) return lines;
            for (int i = history.Count - 1; i >= 0 && lines.Count < n; i--) {
                var d = history[i] as Dictionary<string, object>;
                if (d == null) continue;
                long at = Wire.Number(d, "at");
                string when = at > 0 ? new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(at).ToLocalTime().ToString("d MMM, HH:mm", System.Globalization.CultureInfo.InvariantCulture) + "  " : "";
                lines.Add(when + Wire.Text(d, "text"));
            }
            return lines;
        }
        // The panel's version line, from the status frame: "Version 0.5.1", or "" (hidden) for no valid version.
        public static string VersionLine(string version) { return SemVer.Valid(version) ? "Version " + version : ""; }
        // The tray tooltip: at most 63 characters, as NotifyIcon allows.
        public static string Tip(string name) { string t = "Support" + (string.IsNullOrEmpty(name) ? "" : ": " + name); return t.Length > 63 ? t.Substring(0, 60) + "..." : t; }
    }

    // The tray icon, drawn at run time from the app's headset shape (the exe carries no icon). Create returns an icon
    // handle the caller frees with Native.DestroyIcon.
    public static class TrayIcon {
        public static IntPtr Create(int size, Gdi.Color color) {
            using (var bmp = new Gdi.Bitmap(size, size, Img.PixelFormat.Format32bppArgb))
            using (var g = Gdi.Graphics.FromImage(bmp)) {
                g.SmoothingMode = Gdi.Drawing2D.SmoothingMode.AntiAlias;
                g.Clear(Gdi.Color.Transparent);
                float k = size / 20f;
                using (var pen = new Gdi.Pen(color, Math.Max(1.5f, 1.8f * k)))
                using (var brush = new Gdi.SolidBrush(color)) {
                    g.DrawArc(pen, 3.5f * k, 3f * k, 13f * k, 13f * k, 180, 180);
                    g.FillRectangle(brush, 2.5f * k, 9.5f * k, 3.5f * k, 6f * k);
                    g.FillRectangle(brush, 14f * k, 9.5f * k, 3.5f * k, 6f * k);
                }
                return bmp.GetHicon();
            }
        }
        public static Gdi.Color ColorFor(string state) {
            if (state == DeviceState.Active) return Gdi.Color.FromArgb(0x1F, 0x9D, 0x55);
            if (state == DeviceState.Pending) return Gdi.Color.FromArgb(0x25, 0x63, 0xEB);
            return Gdi.Color.FromArgb(0x5B, 0x64, 0x72);
        }
    }

    // --tray: one per signed-in session. The icon opens a small panel near the clock with the PC's name, its mode,
    // its state and a short local history. It reads everything from the service's status pipe, polling every few
    // seconds while the panel is open and every minute otherwise, and exits when the uninstall event is set.
    public sealed class TrayPanel : Window {
        const double CardWidth = 340, Pad = 16;
        readonly Palette p;
        readonly TextBlock nameLine, modeLine, teamOnly, stateLine, noOne, note, versionLine;
        readonly StackPanel historyBox, confirmBox;
        readonly FlatButton allow, confirmYes, confirmNo, uninstall, endSession;
        public event Action AllowConfirmed;
        public event Action UninstallClicked;
        public event Action EndSessionClicked;

        public TrayPanel(Palette palette) {
            p = palette;
            Ui.Transparent(this);
            Title = "Support"; ShowInTaskbar = false; Topmost = true;
            Width = CardWidth + 2 * Pad; SizeToContent = SizeToContent.Height; WindowStartupLocation = WindowStartupLocation.Manual;
            Foreground = p.Ink;
            Grid inner; var card = Ui.Card(p, CardWidth, out inner);
            var root = new Grid { Margin = new Thickness(Pad) }; root.Children.Add(card); Content = root;
            var stack = new StackPanel(); inner.Children.Add(stack);
            stack.Children.Add(new Border { Height = 3, Background = p.Live });
            var body = new StackPanel { Margin = new Thickness(16, 12, 16, 14) };
            var head = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 8) };
            var glyph = Glyph.Headset().Paint(p.Muted).Sized(16); glyph.Margin = new Thickness(0, 0, 8, 0); head.Children.Add(glyph);
            head.Children.Add(Ui.Label("Support", 12, FontWeights.SemiBold, p.Muted, Ui.TextFont));
            body.Children.Add(head);
            nameLine = Ui.Label("", 15.5, FontWeights.SemiBold, p.Ink, Ui.DisplayFont); body.Children.Add(nameLine);
            modeLine = Line(13, p.Ink, 6); body.Children.Add(modeLine);
            teamOnly = Line(12, p.Muted, 2); teamOnly.Text = TrayText.TeamOnly; body.Children.Add(teamOnly);
            allow = new FlatButton(TrayText.AllowAction, p.Work, p.WorkSoft, p.WorkSoft, p.Work, 30, 0, 12, 6, 12.5, true); allow.Margin = new Thickness(0, 8, 0, 0); allow.HorizontalAlignment = HorizontalAlignment.Left;
            body.Children.Add(allow);
            confirmBox = new StackPanel { Margin = new Thickness(0, 8, 0, 0), Visibility = Visibility.Collapsed };
            confirmBox.Children.Add(Ui.Label(TrayText.AllowConfirm, 12.5, FontWeights.Normal, p.Ink, Ui.TextFont));
            var confirmButtons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 0) };
            confirmNo = new FlatButton("Cancel", p.Ink, p.Surface2, p.Line, p.Work, 30, 72, 12, 6, 12.5, true);
            confirmYes = new FlatButton("Allow any time", p.Stop, p.StopBg, p.StopBgHover, p.Work, 30, 0, 12, 6, 12.5, true); confirmYes.Margin = new Thickness(8, 0, 0, 0);
            confirmButtons.Children.Add(confirmNo); confirmButtons.Children.Add(confirmYes);
            confirmBox.Children.Add(confirmButtons);
            body.Children.Add(confirmBox);
            stateLine = Line(13, p.Ink, 10); body.Children.Add(stateLine);
            noOne = Line(12.5, p.Muted, 4); noOne.Text = TrayText.NoOne; body.Children.Add(noOne);
            endSession = new FlatButton(TrayText.EndSession, p.Stop, p.StopBg, p.StopBgHover, p.Work, 30, 0, 12, 6, 12.5, true); endSession.Margin = new Thickness(0, 8, 0, 0); endSession.HorizontalAlignment = HorizontalAlignment.Left;
            endSession.Visibility = Visibility.Collapsed; body.Children.Add(endSession);
            historyBox = new StackPanel { Margin = new Thickness(0, 10, 0, 0) }; body.Children.Add(historyBox);
            note = Line(12, p.Stop, 8); note.Visibility = Visibility.Collapsed; body.Children.Add(note);
            uninstall = new FlatButton(TrayText.Uninstall, p.Muted, Brushes.Transparent, p.Surface2, p.Work, 28, 0, 8, 6, 12.5, true); uninstall.Margin = new Thickness(-8, 10, 0, 0); uninstall.HorizontalAlignment = HorizontalAlignment.Left;
            body.Children.Add(uninstall);
            versionLine = Line(11, p.Muted, 6); versionLine.Visibility = Visibility.Collapsed; body.Children.Add(versionLine);
            stack.Children.Add(body);

            allow.Click += delegate { allow.Visibility = Visibility.Collapsed; confirmBox.Visibility = Visibility.Visible; confirmNo.Focus(); };
            confirmNo.Click += delegate { confirmBox.Visibility = Visibility.Collapsed; allow.Visibility = Visibility.Visible; };
            confirmYes.Click += delegate { confirmBox.Visibility = Visibility.Collapsed; var a = AllowConfirmed; if (a != null) a(); };
            uninstall.Click += delegate { var u = UninstallClicked; if (u != null) u(); };
            endSession.Click += delegate { var e = EndSessionClicked; if (e != null) e(); };
            Deactivated += delegate { Hide(); };
            PreviewKeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Escape) { e.Handled = true; Hide(); } };
            Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e) { if (!quitting) { e.Cancel = true; Hide(); } };
        }
        bool quitting;
        public void Quit() { quitting = true; Close(); }
        TextBlock Line(double size, Brush color, double top) { var t = Ui.Label("", size, FontWeights.Normal, color, Ui.TextFont); t.Margin = new Thickness(0, top, 0, 0); return t; }

        // Shows a status frame, or null when the service did not answer.
        public void Render(Dictionary<string, object> status) {
            if (status == null) {
                nameLine.Text = "Support"; modeLine.Text = ""; stateLine.Text = TrayText.NotRunning;
                teamOnly.Visibility = Visibility.Collapsed; allow.Visibility = Visibility.Collapsed; confirmBox.Visibility = Visibility.Collapsed;
                noOne.Visibility = Visibility.Collapsed; historyBox.Children.Clear(); versionLine.Visibility = Visibility.Collapsed;
                endSession.Visibility = Visibility.Collapsed;
                return;
            }
            // An older service sends no version, and then the line stays hidden.
            versionLine.Text = TrayText.VersionLine(Wire.Text(status, "version"));
            versionLine.Visibility = versionLine.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            string state = Wire.Text(status, "state"), access = Wire.Text(status, "access");
            nameLine.Text = Wire.Text(status, "name");
            modeLine.Text = TrayText.Mode(access);
            modeLine.Visibility = TrayText.ShowMode(state) ? Visibility.Visible : Visibility.Collapsed;
            stateLine.Text = TrayText.State(state, Wire.Text(status, "confirm"));
            teamOnly.Visibility = TrayText.ShowTeamOnly(state, access) ? Visibility.Visible : Visibility.Collapsed;
            bool canAllow = TrayText.Actions(state, access).Contains("allow_any_time");
            if (!canAllow) { allow.Visibility = Visibility.Collapsed; confirmBox.Visibility = Visibility.Collapsed; }
            else if (confirmBox.Visibility != Visibility.Visible) allow.Visibility = Visibility.Visible;
            // A live session: who is connected, and End session. Otherwise "No one is connected."
            object live; var session = status.TryGetValue("session", out live) ? live as Dictionary<string, object> : null;
            noOne.Text = session != null ? TrayText.SessionLine(Wire.Clean(Wire.Text(session, "by"), 200)) : TrayText.NoOne;
            noOne.Foreground = session != null ? p.Ink : p.Muted;
            noOne.Visibility = Visibility.Visible;
            endSession.Visibility = TrayText.Actions(state, access, session != null).Contains("end_session") ? Visibility.Visible : Visibility.Collapsed;
            historyBox.Children.Clear();
            object h; status.TryGetValue("history", out h);
            foreach (string line in TrayText.Recent(h as System.Collections.ArrayList, 4)) {
                var t = Ui.Label(line, 11.5, FontWeights.Normal, p.Muted, Ui.TextFont); t.Margin = new Thickness(0, 2, 0, 0); historyBox.Children.Add(t);
            }
        }
        public void Note(string text) { note.Text = text ?? ""; note.Visibility = string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible; }
        // Bottom right of the work area, by the clock.
        public void Place() {
            UpdateLayout();
            Rect area = SystemParameters.WorkArea;
            Left = area.Right - Width + Pad - 8; Top = area.Bottom - ActualHeight + Pad - 8;
        }
    }

    public static class Tray {
        // The service's pipe takes UiServer.PerProcess connections from one process. The refresh, the uninstall watcher
        // and a button's request run on three threads, so they pass through this gate and never hold more than that.
        static readonly SemaphoreSlim pipeSlots = new SemaphoreSlim(UiServer.PerProcess, UiServer.PerProcess);
        internal static T Gated<T>(Func<T> work) { pipeSlots.Wait(); try { return work(); } finally { pipeSlots.Release(); } }
        // One status request to the service. null when it does not answer.
        public static Dictionary<string, object> Ask(string type) { return Gated(delegate { return AskNow(type); }); }
        static Dictionary<string, object> AskNow(string type) {
            try {
                using (var c = Pipes.Client(DeviceService.PipeName)) {
                    c.Connect(1500);
                    // Trust only a server in session 0 (the service), so a squatter in this session cannot answer.
                    if (!Pipes.ServerIsService(c.SafePipeHandle)) return null;
                    Pipes.Write(c, Wire.Map("type", type));
                    return Pipes.Read(c, DeviceService.PipeReadMax, UiServer.ReadMs);
                }
            } catch (Exception) { return null; }
        }
        // A second start in the session (the setup's Open Support) asks the running tray to open its panel.
        const string ShowEvent = "Local\\SupportMcpTrayShow";
        public static void Run(Application app) {
            bool first; using (var mutex = new Mutex(true, "Local\\SupportMcpTray", out first)) {
                if (!first) { try { using (var show = EventWaitHandle.OpenExisting(ShowEvent)) { Native.AllowSetForegroundWindow(-1); show.Set(); } } catch (Exception) { } return; }
                // Created first, so a second start during the icon and panel setup is not dropped. It stays null when another object holds the name.
                EventWaitHandle showRequests = null;
                try { showRequests = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEvent); } catch (Exception) { }
                var panel = new TrayPanel(Palette.Detect());
                string state = ""; IntPtr handle = IntPtr.Zero; Gdi.Icon icon = null;
                var notify = new WF.NotifyIcon { Text = "Support", Visible = false };
                Action<string> paint = delegate(string s) {
                    IntPtr fresh = TrayIcon.Create(16, TrayIcon.ColorFor(s));
                    var shown = Gdi.Icon.FromHandle(fresh);
                    notify.Icon = shown;
                    if (icon != null) icon.Dispose();
                    if (handle != IntPtr.Zero) Native.DestroyIcon(handle);
                    icon = shown; handle = fresh;
                };
                paint(""); notify.Visible = true;
                var poll = new DispatcherTimer { Interval = TimeSpan.FromMinutes(1) };
                var busy = new Busy();
                Action refresh = delegate {
                    if (busy.Set) return; busy.Set = true;
                    ThreadPool.QueueUserWorkItem(delegate {
                        var st = Ask("status");
                        panel.Dispatcher.BeginInvoke(new Action(delegate {
                            busy.Set = false;
                            panel.Render(st);
                            string s = st == null ? "" : Wire.Text(st, "state");
                            notify.Text = TrayText.Tip(st == null ? "" : Wire.Text(st, "name"));
                            if (s != state) { state = s; paint(s); }
                        }));
                    });
                };
                poll.Tick += delegate { refresh(); };
                Action open = delegate {
                    panel.Note(null); panel.Show(); panel.Place(); panel.Activate();
                    poll.Interval = TimeSpan.FromSeconds(4); refresh();
                };
                notify.MouseClick += delegate(object sender, WF.MouseEventArgs e) {
                    if (e.Button != WF.MouseButtons.Left) return;
                    if (panel.IsVisible) { panel.Hide(); return; }
                    open();
                };
                if (showRequests != null) {
                    var shower = new Thread(delegate() {
                        while (true) { showRequests.WaitOne(); try { panel.Dispatcher.BeginInvoke(new Action(delegate { if (!panel.IsVisible) open(); })); } catch (Exception) { return; } }
                    });
                    shower.IsBackground = true; shower.Start();
                }
                panel.IsVisibleChanged += delegate { if (!panel.IsVisible) poll.Interval = TimeSpan.FromMinutes(1); };
                panel.AllowConfirmed += delegate {
                    ThreadPool.QueueUserWorkItem(delegate {
                        var st = Ask("allow_any_time");
                        panel.Dispatcher.BeginInvoke(new Action(delegate { if (st == null) panel.Note(TrayText.NotRunning); else panel.Render(st); }));
                    });
                };
                panel.EndSessionClicked += delegate {
                    ThreadPool.QueueUserWorkItem(delegate {
                        var st = Ask("end_session");
                        panel.Dispatcher.BeginInvoke(new Action(delegate { if (st == null) panel.Note(TrayText.NotRunning); else panel.Render(st); }));
                    });
                };
                panel.UninstallClicked += delegate {
                    bool started = false;
                    try { string installed = DeviceSetup.InstalledExe(); if (File.Exists(installed)) using (Process.Start(new ProcessStartInfo(installed, "--uninstall") { UseShellExecute = false, WorkingDirectory = Path.GetTempPath() })) { started = true; } } catch (Exception) { }
                    if (!started) panel.Note(TrayText.UninstallMissing);
                    else panel.Hide();
                };
                // The uninstall event: its name from the service's status, opened only when SYSTEM or Administrators own it
                // (issue #22); set means quit at once. The name is read again every minute, as the service picks a new one
                // when someone else holds it.
                var watcher = new Thread(delegate() {
                    while (true) {
                        var st = Ask("status");
                        var e = st == null ? null : DeviceService.WatchUninstall(Wire.Text(st, "uninstall_event"));
                        if (e != null) { bool set; using (e) set = e.WaitOne(60000); if (set) break; continue; }
                        Thread.Sleep(30000);
                    }
                    try { panel.Dispatcher.BeginInvoke(new Action(delegate { app.Shutdown(); })); } catch (Exception) { }
                });
                watcher.IsBackground = true; watcher.Start();
                poll.Start(); refresh();
                app.Run();
                poll.Stop();
                notify.Visible = false; notify.Dispose();
                if (icon != null) icon.Dispose();
                if (handle != IntPtr.Zero) Native.DestroyIcon(handle);
                panel.Quit();
            }
        }
        // A flag the poll's worker and the UI share; only the UI thread sets it back.
        sealed class Busy { public volatile bool Set; }
    }

    // Uninstall. The unelevated --uninstall (run by the Apps entry and the tray) copies itself to a fresh Temp folder
    // and re-runs from there, so nothing in the install folder stays open; it shows a confirm, then runs the elevated
    // --device-remove. The pure parts (the removal plan, the exit-code map, the Temp-copy rule, and what counts as a
    // reached relay) are static so the native tests can check them. --device-remove never touches
    // HKLM\SOFTWARE\SupportMCP or anything of the one-off sessions.
    public static class DeviceUninstall {
        // Busy: another install, uninstall or update holds the setup lock, or an update's trial is open. Nothing changed.
        // Blocked: someone else created the setup mutex first (issue #22). Nothing changed.
        public const int Removed = 0, Unreachable = 10, Fail = 20, Busy = 21, Blocked = 22;
        public enum Outcome { Removed, RemovedUnreachable, Declined, Failed, Busy, Blocked }
        public static Outcome Map(int exit) {
            if (exit == Removed) return Outcome.Removed;
            if (exit == Unreachable) return Outcome.RemovedUnreachable;
            if (exit == -1223) return Outcome.Declined;
            if (exit == Busy) return Outcome.Busy;
            if (exit == Blocked) return Outcome.Blocked;
            return Outcome.Failed;
        }
        public const string BusyText = "Support is finishing an update. Try again in a few minutes.";
        // --uninstall must run from a copy, not from the install folder. True for any file in it: support.exe or a version
        // file an update left there.
        public static bool NeedsRestage(string exePath) { return UpdateSwitch.InFolder(exePath, DeviceSetup.Folder); }
        // Leave counts as done whether the relay answered 200 or 401; only a network failure leaves the PC on the list.
        // Only a 200 (forgotten now) or a 401 (already gone) means the relay no longer holds this PC. Anything else, a
        // refusal or a server error included, removes locally but tells the owner the team must remove it.
        public static bool LeaveReachedRelay(DeviceLink.DeviceResult result) { return result == DeviceLink.DeviceResult.Ok || result == DeviceLink.DeviceResult.Removed; }
        // Everything an uninstall removes, by exact name. The native test checks the list names only our artifacts and
        // never the one-off sessions' shared record (HKLM\SOFTWARE\SupportMCP).
        public static List<string> RemovalPlan() {
            var list = new List<string>();
            list.Add("service " + DeviceSetup.ServiceName);
            list.Add("hklm64 " + DeviceInstall.RunKey + "\\" + DeviceInstall.TrayValueName);
            list.Add("hklm64 " + DeviceInstall.AppsKey);
            list.Add("folder " + DeviceSetup.Folder);
            return list;
        }

        // --device-remove <nonce>, elevated. Reads device.json, leaves the relay, signals the trays and ends any that
        // stay, stops and deletes the service, drops the registry entries, and removes the folder (locked leftovers go
        // at the next restart). Returns Removed, Unreachable, or Fail when the attempt was withdrawn.
        public static int Remove(string[] args) {
            if (args.Length != 2 || !System.Text.RegularExpressions.Regex.IsMatch(args[1], @"^[0-9a-f]{32}\z")) return Fail;
            var want = Elevation.Wanted("device-remove", args[1]);
            if (want == null) return Fail;
            // One install, remove or update switch at a time across the PC; a second gets Busy and touches nothing.
            Mutex only = null; bool held = false;
            try { only = DeviceInstall.SetupMutex(); try { held = only.WaitOne(0); } catch (AbandonedMutexException) { held = true; } } catch (DeviceInstall.BlockedException) { want.Dispose(); return Blocked; } catch (Exception) { }
            if (!held) { if (only != null) only.Dispose(); want.Dispose(); return Busy; }
            using (want)
            try {
                string folder = DeviceSetup.Folder;
                // An update's trial decides within minutes which version stays; removing the PC meanwhile would race it.
                // update.json that cannot be read at this moment counts as busy too: try again in a few minutes.
                var upd = UpdateState.TryLoad(folder);
                if (upd == null || UpdateSwitch.UninstallBusy(upd, Client.UnixNow())) return Busy;
                // Only an actual leave call counts as reaching the relay; a missing or damaged device.json leaves the
                // PC on the team's list, so the final window says so.
                bool reached = false; string part = "";
                try {
                    var dev = Wire.Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(folder, "device.json")));
                    if (dev != null) {
                        part = Wire.Text(dev, "uninstall_event");
                        string origin = Wire.Text(dev, "origin"), key = Wire.Text(dev, "key");
                        if (key.Length > 0 && origin.Length > 0) reached = LeaveReachedRelay(new DeviceLink(origin).Leave(key).Result);
                    }
                } catch (Exception) { }
                DeviceService.SignalUninstall(part);     // every tray watches this and exits
                try { Thread.Sleep(3000); } catch (Exception) { } // give the trays a few seconds to close themselves
                EndTrays(folder);                        // best effort for any that remain
                try { Scm.Remove(DeviceSetup.ServiceName); } catch (Exception) { }
                DeviceInstall.RemoveRegistry();
                RemoveFolder(folder);
                return reached ? Removed : Unreachable;
            } finally { try { only.ReleaseMutex(); } catch (Exception) { } only.Dispose(); }
        }
        // Ends every tray started from any exe in folder: support.exe or any version file, whatever an update renamed. Only
        // processes in a signed-in session (never session 0, where the service and the update switch run), and only those
        // whose name starts with "support", are looked at.
        internal static void EndTrays(string folder) {
            try {
                foreach (var pr in Process.GetProcesses()) {
                    try { if (pr.SessionId != 0 && pr.ProcessName.StartsWith("support", StringComparison.OrdinalIgnoreCase) && UpdateSwitch.InFolder(pr.MainModule.FileName, folder)) pr.Kill(); }
                    catch (Exception) { }
                    finally { pr.Dispose(); }
                }
            } catch (Exception) { }
        }
        // Rename the folder aside so a fresh install at the original path is never blocked, then delete it or queue it
        // for the next restart (DeviceInstall.RemoveFolderAside, junction-safe and shared with the install's rollback).
        static void RemoveFolder(string folder) { DeviceInstall.RemoveFolderAside(folder); }
        internal static void TestRemoveFolder(string folder) { RemoveFolder(folder); }

        public static void Run(Application app, string exe) {
            // Run from a Temp copy, so the install folder (support.exe) is not held open while it is removed.
            if (NeedsRestage(exe)) {
                try { string staged = Elevation.Stage(exe); using (Process.Start(new ProcessStartInfo(staged, "--uninstall") { UseShellExecute = false, WorkingDirectory = Path.GetTempPath() })) { } } catch (Exception) { }
                return;
            }
            bool first; using (var mutex = new Mutex(true, "Local\\SupportMcpUninstall", out first)) {
                if (!first) return;
                Elevation.SweepStaged(); // clear old SupportMcpStage-* copies, including earlier uninstall runs
                var window = new UninstallWindow(Palette.Detect(), exe);
                window.Closed += delegate { app.Shutdown(); };
                app.Run(window);
                window.Finish();
                string stage = StagedFolder(exe); if (stage != null) FullInstall.RemoveLater(new List<string>(), stage);
            }
        }
        // The folder to remove after this run: the folder of a staged copy (SupportMcpStage-* directly under Temp), else
        // null. Anything else, the install folder included, is never a candidate.
        internal static string StagedFolder(string exePath) { return StagedFolder(exePath, Path.GetTempPath()); }
        internal static string StagedFolder(string exePath, string temp) {
            try {
                string dir = Path.GetDirectoryName(Path.GetFullPath(exePath)), parent = Path.GetDirectoryName(dir);
                if (dir == null || parent == null || NeedsRestage(exePath)) return null;
                bool direct = string.Equals(parent.TrimEnd('\\'), Path.GetFullPath(temp).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
                return direct && Path.GetFileName(dir).StartsWith(Elevation.StagePrefix, StringComparison.OrdinalIgnoreCase) ? dir : null;
            } catch (Exception) { return null; }
        }
    }

    // The confirm-and-result window for --uninstall. Cancel/Uninstall, then the elevated removal and a final message.
    public sealed class UninstallWindow : Window {
        const double CardWidth = 440, Pad = 20;
        readonly Palette p;
        readonly string exe;
        enum Screen { Confirm, Removing, Unavailable, Done, DoneUnreachable }
        Screen screen = Screen.Confirm;
        string note = "";
        Thread worker;

        readonly Border bodyHost;
        readonly TextBlock heading, body, noteLine;
        readonly FlatButton cancel, go;

        public UninstallWindow(Palette palette, string exe) {
            p = palette; this.exe = exe;
            Ui.Transparent(this);
            Topmost = false; ShowInTaskbar = true; Title = "Uninstall Support";
            Width = CardWidth + 2 * Pad; SizeToContent = SizeToContent.Height; WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Foreground = p.Ink;
            Grid inner; var card = Ui.Card(p, CardWidth, out inner);
            var root = new Grid { Margin = new Thickness(Pad) }; root.Children.Add(card); Content = root;
            var stack = new StackPanel(); inner.Children.Add(stack);
            stack.Children.Add(new Border { Height = 3, Background = p.Stop });
            var head = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(16, 12, 16, 0) };
            var glyph = Glyph.Headset().Paint(p.Muted).Sized(16); glyph.Margin = new Thickness(0, 0, 8, 0); head.Children.Add(glyph);
            head.Children.Add(Ui.Label("Support", 12, FontWeights.SemiBold, p.Muted, Ui.TextFont));
            stack.Children.Add(head);
            var wrap = new StackPanel { Margin = new Thickness(16, 8, 16, 4) };
            heading = Ui.Label("", 17, FontWeights.SemiBold, p.Ink, Ui.DisplayFont); heading.Margin = new Thickness(0, 0, 0, 8); heading.LineHeight = 22;
            wrap.Children.Add(heading);
            bodyHost = new Border(); wrap.Children.Add(bodyHost);
            body = Ui.Label("", 13, FontWeights.Normal, p.Muted, Ui.TextFont); body.LineHeight = 19; bodyHost.Child = body;
            noteLine = Ui.Label("", 12.5, FontWeights.Normal, p.Stop, Ui.TextFont); noteLine.Margin = new Thickness(0, 10, 0, 0); noteLine.Visibility = Visibility.Collapsed;
            wrap.Children.Add(noteLine);
            stack.Children.Add(wrap);
            var foot = new Border { BorderBrush = p.Line, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(12, 10, 12, 12), Margin = new Thickness(0, 12, 0, 0) };
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            cancel = new FlatButton("Cancel", p.Ink, p.Surface2, p.Line, p.Work, 34, 96, 14, 6, 13, true);
            go = new FlatButton("Uninstall", Brushes.White, p.StopSolid, p.StopSolidHover, p.Work, 34, 120, 16, 6, 13, true); go.Margin = new Thickness(8, 0, 0, 0);
            buttons.Children.Add(cancel); buttons.Children.Add(go);
            foot.Child = buttons; stack.Children.Add(foot);

            cancel.Click += delegate { if (screen == Screen.Done || screen == Screen.DoneUnreachable || screen == Screen.Unavailable) Close(); else if (screen != Screen.Removing) Close(); };
            go.Click += delegate { OnGo(); };
            PreviewKeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Escape && screen != Screen.Removing) { e.Handled = true; Close(); } };
            Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e) { if (screen == Screen.Removing) e.Cancel = true; };
            Loaded += delegate { Render(); Activate(); };
        }

        void OnGo() {
            if (screen == Screen.Done || screen == Screen.DoneUnreachable || screen == Screen.Unavailable) { Close(); return; }
            if (screen == Screen.Removing) return;
            BeginRemove();
        }
        void BeginRemove() {
            screen = Screen.Removing; note = ""; Render();
            IntPtr owner = new WindowInteropHelper(this).Handle;
            worker = new Thread(delegate() {
                int exit = DeviceUninstall.Fail; bool unavailable = false, declined = false;
                try {
                    Consent path = ConsentPath.Detect();
                    if (path == Consent.Unavailable) unavailable = true;
                    else {
                        string nonce = Elevation.Nonce(); string staged = Elevation.Stage(exe);
                        using (var want = Elevation.Want("device-remove", nonce))
                        try { exit = Native.RunElevated(staged, "--device-remove " + nonce, owner, delegate { }); }
                        finally { try { Elevation.DeleteTree(Path.GetDirectoryName(staged)); } catch (Exception) { } }
                        if (exit == -1223) declined = true;
                    }
                } catch (Exception) { exit = DeviceUninstall.Fail; }
                bool un = unavailable, dec = declined; int code = exit;
                Post(delegate { Finish(un, dec, code); });
            });
            worker.SetApartmentState(ApartmentState.STA); worker.IsBackground = true; worker.Start();
        }
        void Finish(bool unavailable, bool declined, int exit) {
            // The elevated step leaves another window in front (on Windows 7 the result sat behind Programs and Features), so each outcome takes focus back.
            if (unavailable) { screen = Screen.Unavailable; Render(); Activate(); return; }
            if (declined) { screen = Screen.Confirm; note = "Windows didn't get permission, so nothing was removed. Click Uninstall to try again."; Render(); Activate(); return; }
            DeviceUninstall.Outcome outcome = DeviceUninstall.Map(exit);
            if (outcome == DeviceUninstall.Outcome.Removed) screen = Screen.Done;
            else if (outcome == DeviceUninstall.Outcome.RemovedUnreachable) screen = Screen.DoneUnreachable;
            else if (outcome == DeviceUninstall.Outcome.Busy) { screen = Screen.Confirm; note = DeviceUninstall.BusyText; }
            else if (outcome == DeviceUninstall.Outcome.Blocked) { screen = Screen.Confirm; note = OwnerCheck.Blocked; }
            else { screen = Screen.Confirm; note = "Support couldn't be removed. Try again, or ask your support team for help."; }
            Render(); Activate();
        }
        void Post(Action a) { Dispatcher.BeginInvoke(DispatcherPriority.Normal, a); }

        void Render() {
            if (screen == Screen.Confirm) {
                heading.Text = "Uninstall Support?";
                body.Text = "This removes the app, the background service that lets your support team see this PC, and this PC's saved access. Your support team can no longer connect.";
            } else if (screen == Screen.Removing) {
                heading.Text = "Removing Support…"; body.Text = "This takes a moment.";
            } else if (screen == Screen.Unavailable) {
                heading.Text = "Can't remove on this account"; body.Text = DeviceSetup.UnavailableText;
            } else if (screen == Screen.Done) {
                heading.Text = "Support was removed"; body.Text = "Support is no longer on this PC.";
            } else {
                heading.Text = "Support was removed"; body.Text = "Support is no longer on this PC. Your support team will still see this PC in their list until they remove it.";
            }
            bool terminal = screen == Screen.Done || screen == Screen.DoneUnreachable || screen == Screen.Unavailable;
            noteLine.Text = note; noteLine.Visibility = note.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            cancel.Visibility = (screen == Screen.Confirm) ? Visibility.Visible : Visibility.Collapsed;
            go.Visibility = screen == Screen.Removing ? Visibility.Collapsed : Visibility.Visible;
            go.Content = terminal ? "Close" : "Uninstall";
            // Keyboard: the safe choice has the focus while it asks, Close once it is done.
            FlatButton target = screen == Screen.Confirm ? cancel : terminal ? go : null;
            if (target != null) Dispatcher.BeginInvoke(DispatcherPriority.Input, (Action)delegate { target.Focus(); Keyboard.Focus(target); });
        }
        public void Finish() { var t = worker; if (t != null) t.Join(120000); }
    }

    public static class Program {
        [STAThread] public static void Main(string[] args) {
            string role = args.Length > 0 ? args[0] : "", executable = System.Reflection.Assembly.GetExecutingAssembly().Location;
            // The roles that run elevated or as SYSTEM show nothing at all: no window, no message box.
            if (role == "--service") { try { ServiceBase.Run(new SupportService(executable, Wire.ReadConfig(executable))); } catch (Exception) { } return; }
            if (role == "--device-service") { try { ServiceBase.Run(new DeviceService(executable)); } catch (Exception) { } return; }
            // A saved PC's update switch and rollback (DeviceUpdate), SYSTEM children of the service or its failure action.
            // The installed exe carries no footer, so they are routed before any footer is read.
            if (role == "--device-update") {
                Native.SafeDllSearch(); int code = UpdateSwitch.Refused;
                try { if (args.Length == 2) code = DeviceUpdate.Switch(executable, args[1], DeviceSetup.Folder); } catch (Exception) { }
                Environment.Exit(code);
            }
            if (role == "--device-update-rollback") {
                Native.SafeDllSearch(); int code = UpdateSwitch.Refused;
                try {
                    if (args.Length == 1) code = DeviceUpdate.RollBack(DeviceSetup.Folder);
                    else if (args.Length == 2 && args[1] == DeviceUpdate.AtDeadline) code = DeviceUpdate.WatchDeadline(DeviceSetup.Folder);
                } catch (Exception) { }
                Environment.Exit(code);
            }
            if (role == "--helper") { try { Helper.Run(executable, args); } catch (Exception) { } Environment.Exit(0); }
            if (role == "--elevate-install") {
                Native.SafeDllSearch(); int code = 1; FileStream held = null;
                try { byte[] self = FullInstall.ReadSelf(executable, out held); code = FullInstall.Install(self, Wire.ReadConfig(self), args); } catch (Exception) { }
                finally { if (held != null) held.Dispose(); }
                Environment.Exit(code);
            }
            // The elevated install step of a saved PC: reads its own exe and device footer once through a held handle,
            // like --elevate-install, then installs. Anything other than exit 0 or 10 leaves nothing of this run.
            if (role == "--device-install") {
                Native.SafeDllSearch(); int code = DeviceSetup.Refused; FileStream held = null;
                try { byte[] self = FullInstall.ReadSelf(executable, out held); code = DeviceInstall.Install(self, Wire.ReadDevice(self), args); } catch (Exception) { }
                finally { if (held != null) held.Dispose(); }
                Environment.Exit(code);
            }
            // The elevated remove step: run from the staged copy the uninstaller launched; it reads device.json from
            // the install folder, not a footer, so the staged exe needs none.
            if (role == "--device-remove") {
                Native.SafeDllSearch(); int code = DeviceUninstall.Fail;
                try { code = DeviceUninstall.Remove(args); } catch (Exception) { }
                Environment.Exit(code);
            }
            WF.Application.EnableVisualStyles();
            try {
                var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                if (role == "--window") { RunWindow(app, args); return; }
                // A saved PC's question, started by its service as the signed-in user; the installed exe has no footer.
                if (role == "--device-ask") Environment.Exit(DeviceAsk.Run(args));
                // The installed support.exe carries no footer, so its roles are routed before any footer is read.
                if (role == "--tray") { Tray.Run(app); return; }
                if (role == "--uninstall") { DeviceUninstall.Run(app, executable); return; }
                // A setup download carries a device footer (kind "device"). It runs the wizard, and is checked before
                // any session footer is read, so no session role ever runs on it (Wire.ReadConfig refuses it too).
                byte[] self = File.ReadAllBytes(executable);
                if (Wire.Kind(self) == "device") { DeviceSetup.Run(app, Wire.ReadDevice(self), executable); return; }
                bool administrator = SupportAccess.IsAdministrator();
                var config = Wire.ReadConfig(executable);
                bool requestedResume = args.Length == 1 && (args[0] == "--prepare-restart" || args[0] == "--resume");
                if (!requestedResume) { RunStart(app, config); return; }
                // A prepared reconnect after a restart: normal mode, as before full control existed.
                bool resume = RestartResume.Valid(config, executable);
                if (!resume) {
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
                    // Read before Disarm clears it. A normal start and the prepare prompt show the screen control text themselves.
                    bool screenAllowed = !resume || preparing || RestartResume.HasScreenConsent(config);
                    if (!approvedAdministratorResume && !SupportAccess.Confirm(administrator, resume && !preparing, screenAllowed, delegate(string message) {
                        if (preparing) message += "\n\nAlso allow ONE automatic reconnect at the next Windows sign-in with these same rights, without another prompt? It keeps this session's original expiry. End session cancels it.";
                        return ConsentDialog.Ask(message, administrator) ? WF.DialogResult.Yes : WF.DialogResult.No;
                    })) return;
                    if (preparing) RestartResume.Arm(config, administrator);
                    else if (resume) RestartResume.Disarm(config); // one restart only
                    SupportWindow window = null;
                    try {
                        using (var client = new Client(config)) {
                            client.ScreenAllowed = screenAllowed;
                            string note = preparing ? "One automatic reconnect is enabled at the next sign-in. End session cancels it."
                                : resume ? "Reconnected after restart. No further automatic reconnect is installed." + (screenAllowed ? "" : " Screen control stays off, because this reconnect was approved before it existed.") : null;
                            window = new SupportWindow(Palette.Detect(), administrator, preparing, note);
                            var win = window; win.Bind(client);
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
        // A fresh start: the corner window, then full control or the fallback (StartFlow).
        static void RunStart(Application app, Dictionary<string, object> config) {
            bool first; using (var mutex = new Mutex(true, "Local\\SupportMcp-" + Wire.Text(config, "sid"), out first)) {
                if (!first) { WF.MessageBox.Show("This support session is already open.", "Remote support"); return; }
                // connect_by on this PC's clock, as the Client counts it: what was left of the first-connection window at download.
                long left = config.ContainsKey("startup_ms") ? Wire.Number(config, "startup_ms") : Wire.Number(config, "startup_expires_at") - Client.UnixNow();
                var window = new SupportWindow(Palette.Detect(), false, false, null);
                var flow = new StartFlow(window, config, System.Reflection.Assembly.GetExecutingAssembly().Location, Client.UnixNow() + Math.Max(0, Math.Min(7200000, left)));
                bool started = false;
                window.Loaded += delegate { if (!started) { started = true; flow.Begin(); } };
                window.Closed += delegate { app.Shutdown(); };
                app.Run(window);
                flow.Finish();
            }
        }
        // --window <sid8>: the corner window of a full-control session, as the signed-in user. It holds no session key.
        static void RunWindow(Application app, string[] args) {
            if (args.Length != 2 || !System.Text.RegularExpressions.Regex.IsMatch(args[1], "^[0-9a-f]{8}$")) return;
            bool first; using (var mutex = new Mutex(true, "Local\\SupportMcpWindow-" + args[1], out first)) {
                if (!first) return;
                var link = new ServiceLink(args[1]); var window = new SupportWindow(Palette.Detect(), false, false, null);
                window.Bind(link);
                window.Loaded += delegate { link.Start(); };
                window.Closed += delegate { app.Shutdown(); };
                app.Run(window);
                link.Flush(3000);
            }
        }
    }
}
