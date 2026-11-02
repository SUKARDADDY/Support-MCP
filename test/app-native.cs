// Compile with src/agent-app.cs, /main:AppTests and the same v4 references.
// Runs the real HTTP client and native Job containment on a Windows test host.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using SupportMcp;
using Screen = SupportMcp.Screen;

public sealed class FakeRelay : IDisposable {
    readonly HttpListener listener = new HttpListener();
    readonly object gate = new object();
    readonly Thread server;
    public readonly string Origin;
    public volatile bool End, FailFirstResult;
    public int Results, Polls;
    public bool? Elevated;
    public int Lifetime = 30000;
    // One pending frame per lane and the results by id, like the relay.
    readonly Dictionary<string, Dictionary<string, object>> frames = new Dictionary<string, Dictionary<string, object>>(), results = new Dictionary<string, Dictionary<string, object>>();
    string lastQueued = "";
    public volatile bool Closed;
    public int Park = 25000; // how long a poll waits for a frame, like the relay's 25 s
    public Dictionary<string, object> Hello;
    public volatile string[] LastBusy = new string[0];
    public volatile Dictionary<string, object> LastPoll;
    public readonly Client Agent;
    readonly Thread agentThread;
    public readonly ManualResetEvent Connected = new ManualResetEvent(false);
    // Simulates a PC clock that runs ahead of the relay by this many milliseconds.
    public long ClockSkew;
    public volatile bool Refuse; // drop every request, so the client can never complete a handshake
    public volatile int RejectOk; // answer every result with ok:true with this status (400, 413), like a relay that refuses it
    public readonly Dictionary<string, int> ResultCounts = new Dictionary<string, int>();
    public FakeRelay() : this(null) { }
    public FakeRelay(Dictionary<string, object> config) {
        var tcp = new TcpListener(IPAddress.Loopback, 0); tcp.Start(); int port = ((IPEndPoint)tcp.LocalEndpoint).Port; tcp.Stop();
        Origin = "http://127.0.0.1:" + port;
        listener.Prefixes.Add(Origin + "/"); listener.Start();
        server = new Thread(Serve); server.IsBackground = true; server.Start();
        if (config != null) config["origin"] = Origin;
        Agent = new Client(config ?? Wire.Map("origin", Origin, "sid", new string('a', 64), "key", new string('b', 64), "startup_expires_at", Client.UnixNow() + 60000));
        agentThread = new Thread(Agent.Run); agentThread.IsBackground = true;
    }
    public void Launch() { agentThread.Start(); }
    public void Start() { agentThread.Start(); if (!Connected.WaitOne(10000)) throw new Exception("Client did not attach: " + Agent.LastError); }
    void Serve() {
        try { while (listener.IsListening) { var ctx = listener.GetContext(); ThreadPool.QueueUserWorkItem(delegate { Reply(ctx); }); } }
        catch (HttpListenerException) { } catch (ObjectDisposedException) { }
    }
    void Reply(HttpListenerContext ctx) {
        try {
            if (Refuse) { ctx.Response.Abort(); return; }
            if (ctx.Request.Headers["X-Attach-Key"] != new string('b', 64)) throw new Exception("Wrong auth header");
            string raw; using (var r = new StreamReader(ctx.Request.InputStream)) raw = r.ReadToEnd();
            var b = Wire.Json().Deserialize<Dictionary<string, object>>(raw);
            Dictionary<string, object> reply;
            lock (gate) {
                if (End) reply = Wire.Map("type", "end");
                else if (Wire.Text(b, "type") == "hello") { Hello = b; Elevated = Wire.Flag(b, "elevated"); long serverNow = Client.UnixNow() - ClockSkew; reply = Wire.Map("type", "welcome", "generation", 1, "server_time", serverNow, "expires_at", serverNow + Lifetime); Connected.Set(); }
                else if (Wire.Text(b, "type") == "end") { End = true; reply = Wire.Map("type", "end"); }
                else if (Wire.Text(b, "type") == "result") {
                    Results++;
                    { string seen = Wire.Text(b, "id"); int n; ResultCounts[seen] = ResultCounts.TryGetValue(seen, out n) ? n + 1 : 1; }
                    if (RejectOk != 0 && Wire.Flag(b, "ok")) { ctx.Response.StatusCode = RejectOk; ctx.Response.Close(); return; }
                    if (FailFirstResult) { FailFirstResult = false; ctx.Response.StatusCode = 500; ctx.Response.Close(); return; }
                    string rid = Wire.Text(b, "id"); results[rid] = b;
                    foreach (string lane in new List<string>(frames.Keys)) if (Wire.Text(frames[lane], "id") == rid) frames.Remove(lane);
                    reply = Wire.Map("type", "ack"); Monitor.PulseAll(gate);
                } else {
                    Polls++; var busy = new List<string>();
                    if (b.ContainsKey("busy_lanes")) foreach (object l in (System.Collections.ArrayList)b["busy_lanes"]) busy.Add((string)l); else if (Wire.Flag(b, "busy")) busy.Add("cmd");
                    LastBusy = busy.ToArray(); LastPoll = b; var until = DateTime.UtcNow.AddMilliseconds(Park); reply = null;
                    while (reply == null) {
                        if (End) reply = Wire.Map("type", "end");
                        foreach (var kv in frames) if (reply == null && !busy.Contains(kv.Key)) reply = kv.Value;
                        if (reply == null && (busy.Count >= 2 || Closed || DateTime.UtcNow >= until)) reply = Wire.Map("type", "idle");
                        if (reply == null) Monitor.Wait(gate, 50);
                    }
                }
            }
            if (Wire.Text(reply, "type") == "idle") Thread.Sleep(50);
            byte[] bytes = Encoding.UTF8.GetBytes(Wire.Json().Serialize(reply));
            ctx.Response.ContentType = "application/json"; ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length); ctx.Response.Close();
        } catch (Exception) { try { ctx.Response.Abort(); } catch { } }
    }
    public string Queue(Dictionary<string, object> b) {
        string type = Wire.Text(b, "type"), lane = type == "screen" || type == "control" ? "screen" : "cmd";
        lock (gate) { b["id"] = lastQueued = Guid.NewGuid().ToString(); b["lane"] = lane; frames[lane] = b; Monitor.PulseAll(gate); return lastQueued; }
    }
    public Dictionary<string, object> WaitResult(int seconds = 15) { return WaitResult(lastQueued, seconds); }
    public Dictionary<string, object> WaitResult(string id, int seconds) {
        lock (gate) { var until = DateTime.UtcNow.AddSeconds(seconds); while (!results.ContainsKey(id) && DateTime.UtcNow < until) Monitor.Wait(gate, 100); if (!results.ContainsKey(id)) throw new Exception("No result: " + Agent.LastError); return results[id]; }
    }
    public bool HasResult(string id) { lock (gate) return results.ContainsKey(id); }
    public bool WaitBusy(Func<string[], bool> test, int ms) { var until = DateTime.UtcNow.AddMilliseconds(ms); while (DateTime.UtcNow < until) { if (test(LastBusy)) return true; Thread.Sleep(20); } return test(LastBusy); }
    public Dictionary<string, object> Call(Dictionary<string, object> b) { long t = Wire.Number(b, "timeout_s"); Queue(b); return WaitResult((int)Math.Max(15, t + 10)); }
    public void WaitExit() { if (!agentThread.Join(20000)) throw new Exception("Client failed to stop"); if (Agent.LastError != "") throw new Exception(Agent.LastError); }
    public void Dispose() { Closed = true; Agent.Stop(); if (agentThread.ThreadState != System.Threading.ThreadState.Unstarted) agentThread.Join(20000); Agent.Dispose(); listener.Close(); server.Join(1000); }
}

public static class AppTests {
    static void Assert(bool ok, string detail) { if (!ok) throw new Exception(detail); }
    static string Decode(Dictionary<string, object> r, string key) { return Encoding.UTF8.GetString(Convert.FromBase64String(Wire.Text(r, key))); }
    static Dictionary<string, object> Run(string command, int timeout) { return Wire.Map("type", "run", "command", command, "timeout_s", timeout); }
    static void WaitFile(string path) { var end = DateTime.UtcNow.AddSeconds(10); while (!File.Exists(path) && DateTime.UtcNow < end) Thread.Sleep(50); Assert(File.Exists(path), "Command did not start"); }
    static string ChildCommand(string sentinel, string started) {
        string script = "Start-Sleep -Seconds 3; Set-Content -LiteralPath '" + sentinel.Replace("'", "''") + "' -Value late";
        return "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) + "'; Set-Content -LiteralPath '" + started.Replace("'", "''") + "' -Value started; Start-Sleep -Seconds 20";
    }

    static int[] Vks(string keys, int index) { return KeySpec.Parse(keys)[index]; }
    static void Throws(Action action, string part) {
        try { action(); } catch (ArgumentException e) { Assert(e.Message.Contains(part), "Wrong message: " + e.Message); return; }
        throw new Exception("Expected an error containing: " + part);
    }
    static void ScreenPureTests(string dir) {
        int w, h;
        foreach (int[] c in new int[][] { new int[] { 1920, 1080, 1280, 720 }, new int[] { 2560, 1600, 1280, 800 }, new int[] { 3840, 2160, 1280, 720 }, new int[] { 1280, 1024, 1000, 800 },
            new int[] { 1024, 768, 1024, 768 }, new int[] { 800, 600, 800, 600 }, new int[] { 1366, 768, 1280, 720 }, new int[] { 1, 1, 1, 1 } }) {
            ScreenMath.Fit(c[0], c[1], out w, out h);
            Assert(w == c[2] && h == c[3], "Fit " + c[0] + "x" + c[1] + " gave " + w + "x" + h);
        }
        // Screenshot pixels to physical pixels and back, on a scaled display and on one left of the primary.
        Assert(ScreenMath.ToPhysical(640, 1280, 1920) == 960 && ScreenMath.ToPhysical(0, 1280, 1920) == 0 && ScreenMath.ToPhysical(1279, 1280, 1920) == 1919, "Scaled point mapping");
        Assert(ScreenMath.ToPhysical(500, 1024, 1024) == 500 && ScreenMath.ToPhysical(5000, 1280, 1920) == 1919 && ScreenMath.ToPhysical(-4, 1280, 1920) == 0, "Unscaled mapping and clamping");
        Assert(ScreenMath.EdgeToPhysical(1280, 1280, 1920) == 1920 && ScreenMath.EdgeToPhysical(640, 1280, 1920) == 960, "Region edges");
        foreach (int[] d in new int[][] { new int[] { 1920, 1080 }, new int[] { 2560, 1600 }, new int[] { 3840, 2160 }, new int[] { 2113, 1182 }, new int[] { 1366, 768 }, new int[] { 1024, 768 } }) {
            ScreenMath.Fit(d[0], d[1], out w, out h);
            for (int x = 0; x < w; x += 7) {
                int p = ScreenMath.ToPhysical(x, w, d[0]);
                Assert(p >= 0 && p < d[0] && ScreenMath.ToImage(p, w, d[0]) == x, "Round trip x " + x + " on " + d[0] + " gave " + ScreenMath.ToImage(p, w, d[0]));
            }
            for (int y = 0; y < h; y += 7) Assert(ScreenMath.ToImage(ScreenMath.ToPhysical(y, h, d[1]), h, d[1]) == y, "Round trip y " + y + " on " + d[1]);
        }
        Assert(Marshal.SizeOf(typeof(Win.In)) == (IntPtr.Size == 4 ? 28 : 40), "SendInput structure size");
        Console.WriteLine("PASS screenshot scaling and coordinate mapping, both ways");
        Assert(Vks("ctrl+s", 0).Length == 2 && Vks("ctrl+s", 0)[0] == 0x11 && Vks("ctrl+s", 0)[1] == 0x53, "ctrl+s");
        Assert(Vks("alt+Tab", 0)[0] == 0x12 && Vks("alt+Tab", 0)[1] == 0x09, "alt+Tab");
        Assert(Vks("Return", 0)[0] == 0x0D && Vks("F5", 0)[0] == 0x74 && Vks("f12", 0)[0] == 0x7B && Vks("F24", 0)[0] == 0x87, "Return and function keys");
        Assert(Vks("shift+ctrl+Escape", 0)[0] == 0x10 && Vks("shift+ctrl+Escape", 0)[1] == 0x11 && Vks("Escape+ctrl", 0)[0] == 0x11 && Vks("Escape+ctrl", 0)[1] == 0x1B, "Modifiers come first");
        Assert(Vks("super+r", 0)[0] == 0x5B && Vks("Page_Down", 0)[0] == 0x22 && Vks("5", 0)[0] == 0x35 && Vks("A", 0)[0] == 0x41, "super, page_down, digits, letters");
        var seq = KeySpec.Parse("ctrl+a  Delete"); Assert(seq.Count == 2 && seq[1][0] == 0x2E, "Key sequences");
        Throws(delegate { KeySpec.Parse("ctrl+alt+Delete"); }, "send_sas"); Throws(delegate { KeySpec.Parse("Delete+alt+Control"); }, "send_sas");
        Throws(delegate { KeySpec.Parse("ctrl+banana"); }, "Unknown key"); Throws(delegate { KeySpec.Parse("   "); }, "No keys");
        Assert(KeySpec.IsExtended(0x25) && KeySpec.IsExtended(0x2E) && !KeySpec.IsExtended(0x41), "Extended keys");
        Console.WriteLine("PASS xdotool-style key parsing, and ctrl+alt+del is refused with a pointer to send_sas");
        var clock = new PauseClock();
        Assert(!clock.Paused(0) && !clock.Paused(PauseClock.Now()), "No pause before any physical input");
        clock.Touch(10000);
        Assert(clock.Paused(10000) && clock.Paused(12999) && !clock.Paused(13000) && !clock.Paused(20000), "Pause lasts 3 s from the last physical event");
        clock.Touch(12000); Assert(clock.Paused(14999) && !clock.Paused(15000), "Each physical event restarts the pause");
        Console.WriteLine("PASS customer-input pause timer");
        using (var bmp = new System.Drawing.Bitmap(1280, 800, System.Drawing.Imaging.PixelFormat.Format24bppRgb)) {
            var noise = new Random(5); var pixels = new byte[1280 * 800 * 3]; noise.NextBytes(pixels);
            var data = bmp.LockBits(new System.Drawing.Rectangle(0, 0, 1280, 800), System.Drawing.Imaging.ImageLockMode.WriteOnly, System.Drawing.Imaging.PixelFormat.Format24bppRgb);
            for (int row = 0; row < 800; row++) Marshal.Copy(pixels, row * 1280 * 3, new IntPtr(data.Scan0.ToInt64() + row * data.Stride), 1280 * 3);
            bmp.UnlockBits(data);
            int quality; byte[] jpeg = JpegFit.Encode(bmp, 700000, out quality);
            Assert(jpeg[0] == 0xFF && jpeg[1] == 0xD8 && Convert.ToBase64String(jpeg).Length < 700000, "Noise must fit under 700,000 characters as a JPEG");
            Assert(quality < 80, "Noise cannot fit at the first quality, quality " + quality);
            int easy; Assert(Convert.ToBase64String(JpegFit.Encode(bmp, 2000000, out easy)).Length < 2000000 && easy == 80, "A roomy limit keeps the first quality");
            int tight; byte[] small = JpegFit.Encode(bmp, 300000, out tight);
            Assert(Convert.ToBase64String(small).Length < 300000 && tight < quality, "A tighter limit steps the quality down further: " + tight + " vs " + quality);
        }
        Console.WriteLine("PASS JPEG quality steps down until the base64 text fits");
        Assert(UiLines.Line(12, "ControlType.Button", "OK", 640, 412) == "[12] Button \"OK\" (640,412)", "Basic line");
        Assert(UiLines.Line(3, "ControlType.Pane", "", 10, 20) == "[3] Pane (10,20)", "No name");
        Assert(UiLines.Line(4, "Edit", "say \"hi\"\r\nnow", 1, 2) == "[4] Edit \"say 'hi'  now\" (1,2)", "Quotes and line breaks");
        Assert(UiLines.Line(5, "Text", new string('x', 200), 1, 2).Length == "[5] Text \"".Length + 80 + "\" (1,2)".Length, "Long names are cut at 80 characters");
        Console.WriteLine("PASS ui_tree line formatting");
        // ui_tree text stays under the relay's 200,000 character limit and says when it was cut.
        var many = new List<string>(); for (int i = 1; i <= 3000; i++) many.Add(UiLines.Line(i, "ControlType.Text", new string('n', 80), 1000, 700));
        int kept; string joined = UiLines.Join(many, false, UiLines.MaxChars, out kept);
        Assert(joined.Length <= UiLines.MaxChars && joined.Length > UiLines.MaxChars - 400 && kept < many.Count && kept > 1000 && joined.EndsWith(UiLines.MoreByChars) && joined.Split('\n').Length == kept + 1, "A long tree is cut under the limit with a closing line, kept " + kept + " length " + joined.Length);
        Assert(UiLines.MaxChars + 10000 <= 200000, "The cap leaves room under the relay's text limit");
        var few = new List<string>(); few.Add("[1] A"); few.Add("[2] B");
        Assert(UiLines.Join(few, false, UiLines.MaxChars, out kept) == "[1] A\n[2] B" && kept == 2, "A short tree is unchanged");
        Assert(UiLines.Join(few, true, UiLines.MaxChars, out kept) == "[1] A\n[2] B\n" + UiLines.MoreByCount && kept == 2, "More elements than max_lines");
        Assert(UiLines.Join(new List<string>(), false, UiLines.MaxChars, out kept) == "" && kept == 0, "An empty tree");
        Console.WriteLine("PASS ui_tree text is capped below the relay limit");
        // The relay refuses a result that reports more than 16 displays.
        var rects = new List<System.Drawing.Rectangle>(); for (int i = 0; i < 20; i++) rects.Add(new System.Drawing.Rectangle(i * 100, 0, 100, 100));
        ScreenMath.CapDisplays(rects); Assert(rects.Count == 16 && rects[15].X == 1500, "Displays are clamped to 16");
        var few3 = new List<System.Drawing.Rectangle>(); few3.Add(new System.Drawing.Rectangle(0, 0, 10, 10)); ScreenMath.CapDisplays(few3); Assert(few3.Count == 1, "A normal PC keeps its displays");
        // ui_tree uses the display that holds the foreground window: left of, above, right of the primary, and off all of them.
        var layout = new List<System.Drawing.Rectangle>(); layout.Add(new System.Drawing.Rectangle(0, 0, 1920, 1080)); layout.Add(new System.Drawing.Rectangle(-1280, 100, 1280, 1024)); layout.Add(new System.Drawing.Rectangle(1920, 0, 1600, 900));
        Assert(ScreenMath.MonitorAt(layout, 960, 540) == 0 && ScreenMath.MonitorAt(layout, -1, 500) == 1 && ScreenMath.MonitorAt(layout, -1280, 100) == 1 && ScreenMath.MonitorAt(layout, 1920, 0) == 2 && ScreenMath.MonitorAt(layout, 1919, 1079) == 0, "A point maps to the display that holds it");
        Assert(ScreenMath.MonitorAt(layout, 3600, 450) == 2 && ScreenMath.MonitorAt(layout, -2000, 600) == 1 && ScreenMath.MonitorAt(layout, 500, 1500) == 0 && ScreenMath.MonitorAt(new List<System.Drawing.Rectangle>(), 1, 1) == -1, "A point on no display maps to the nearest one");
        Console.WriteLine("PASS display clamp and foreground display choice");
        // The pause survives a dropped hook: GetLastInputInfo counts, minus the app's own injected input.
        Assert(InputIdle.CustomerAgoMs(10000, 10500, 0, false) == 500 && InputIdle.RemainingMs(500) == 2500, "Input with no injection by the app is the customer's");
        Assert(InputIdle.CustomerAgoMs(10000, 10500, 10000, true) == -1 && InputIdle.CustomerAgoMs(10000, 10500, 10020, true) == -1 && InputIdle.RemainingMs(-1) == 0, "Input at the app's own injection tick is not the customer's");
        Assert(InputIdle.CustomerAgoMs(10100, 10500, 10000, true) == 400 && InputIdle.CustomerAgoMs(10051, 10500, 10000, true) == 449, "A later input after the app's injection is the customer's");
        Assert(InputIdle.CustomerAgoMs(10040, 10500, 10000, true) == -1 && InputIdle.CustomerAgoMs(10050, 10500, 10000, true) == -1, "The slack covers the tick resolution");
        Assert(InputIdle.RemainingMs(3000) == 0 && InputIdle.RemainingMs(2999) == 1 && InputIdle.RemainingMs(0) == 3000, "Three seconds from the customer's input");
        Assert(InputIdle.CustomerAgoMs(4294967000u, 200u, 0, false) == 496 && InputIdle.CustomerAgoMs(4294967000u, 200u, 4294966900u, true) == 496 && InputIdle.CustomerAgoMs(4294967200u, 200u, 4294967290u, true) == -1, "The tick counter wraps");
        Console.WriteLine("PASS pause cross-check against GetLastInputInfo");
    }
    static string Hex(string b64) { return Convert.ToBase64String(Convert.FromBase64String(b64), 0, 2); }
    static Dictionary<string, object> Act(string name, params object[] pairs) {
        var a = Wire.Map(pairs); a["name"] = name; return Wire.Map("type", "screen", "lane", "screen", "action", a);
    }
    // Typing, results and run: the parts that need a client but no screen.
    static void ClientRuleTests(string dir) {
        // A result the relay refuses is replaced once by a plain error, and the client carries on.
        foreach (int code in new int[] { 400, 413 }) {
            using (var relay = new FakeRelay()) {
                relay.Lifetime = 300000; relay.Start();
                relay.RejectOk = code;
                string id = relay.Queue(Run("[Console]::Write('refused')", 20));
                var r = relay.WaitResult(id, 20);
                Assert(!Wire.Flag(r, "ok") && Wire.Text(r, "error") == "result rejected by relay", "A refused result is replaced by an error (" + code + "): " + Wire.Text(r, "error"));
                Assert(relay.ResultCounts[id] == 2, "The refused result is sent once and its replacement once, not forever: " + relay.ResultCounts[id]);
                relay.RejectOk = 0;
                var next = relay.Call(Run("[Console]::Write('next')", 20));
                Assert(Wire.Flag(next, "ok") && Decode(next, "stdout_b64") == "next", "The client polls and runs the next command after a refused result");
                for (int i = 0; i < 100 && relay.Agent.BusyCount != 0; i++) Thread.Sleep(20);
                Assert(relay.Agent.BusyCount == 0, "The lane is free again");
            }
        }
        Console.WriteLine("PASS a result the relay refuses is replaced by an error once, and the client carries on");
        // Run as: only the signed-in user in normal mode.
        using (var relay = new FakeRelay()) {
            relay.Lifetime = 300000; relay.Start();
            string marker = Path.Combine(dir, "as-system");
            foreach (string who in new string[] { "system", "root", "SYSTEM" }) {
                var cmd = Run("Set-Content -LiteralPath '" + marker + "' -Value ran", 20); cmd["as"] = who;
                var r = relay.Call(cmd);
                Assert(!Wire.Flag(r, "ok") && Wire.Text(r, "error") == (who == "system" ? "as: \"system\" needs full control" : "as must be user"), "as " + who + " is refused: " + Wire.Text(r, "error"));
                Assert(!File.Exists(marker), "A refused command does not run");
            }
            var user = Run("[Console]::Write('u')", 20); user["as"] = "user";
            var ok = relay.Call(user); Assert(Wire.Flag(ok, "ok") && Decode(ok, "stdout_b64") == "u", "as user runs");
            Console.WriteLine("PASS run as: system and anything but user is refused in normal mode");
        }
        // A reconnect without screen consent reports no screen cap and refuses screen frames.
        var withoutScreen = new FakeRelay();
        try {
            withoutScreen.Agent.ScreenAllowed = false; withoutScreen.Lifetime = 300000; withoutScreen.Start();
            var caps = (System.Collections.ArrayList)withoutScreen.Hello["caps"];
            Assert(caps.Count == 1 && caps.Contains("lanes") && !caps.Contains("screen"), "Hello without screen consent reports only lanes");
            var shot = withoutScreen.Call(Act("screenshot")); Assert(!Wire.Flag(shot, "ok") && Wire.Text(shot, "error").Contains("not approved"), "A screen frame is refused without consent: " + Wire.Text(shot, "error"));
            var run = withoutScreen.Call(Run("[Console]::Write('cmd')", 20)); Assert(Wire.Flag(run, "ok") && Decode(run, "stdout_b64") == "cmd", "Commands still run");
        } finally { withoutScreen.Dispose(); }
        Console.WriteLine("PASS a reconnect without screen consent has commands and files only");
        // Stop flag and pause between the steps of an input; type_secret keeps its errors generic.
        using (var screen = new Screen()) {
            screen.Start();
            var stop = new ManualResetEvent(true);
            try { screen.TypeText("abc", stop, false); throw new Exception("typing did not stop"); } catch (ScreenError e) { Assert(e.Message == "support access ended", "Stopped typing: " + e.Message); }
            stop = new ManualResetEvent(false);
            screen.TypeText("\r", stop, false); screen.TypeText("", stop, false);
            screen.Watch.Clock.Touch(PauseClock.Now());
            try { screen.TypeText("abc", stop, false); throw new Exception("typing did not pause"); } catch (ScreenError e) { Assert(e.Message == Screen.PauseText, "A pause before the first character has no count: " + e.Message); }
            try { screen.TypeText("abc", stop, true); throw new Exception("secret typing did not pause"); } catch (ScreenError e) { Assert(e.Message == Screen.PauseText, "A secret's error has no count: " + e.Message); }
            screen.Watch.Clock.Touch(-100000);
            var secret = screen.Run(Act("type_secret", "text", "S3CR3T-NEVER-ECHOED"), new ManualResetEvent(true));
            Assert(!Wire.Flag(secret, "ok") && Wire.Text(secret, "error") == Screen.SecretFailed && !Wire.Text(secret, "error").Contains("S3CR3T") && !secret.ContainsKey("text"), "type_secret returns only its generic error: " + Wire.Text(secret, "error"));
            var tooLong = screen.Run(Act("type_secret", "text", new string('x', 6000)), new ManualResetEvent(false));
            Assert(Wire.Text(tooLong, "error") == Screen.SecretFailed, "Even a refused secret returns the generic error");
        }
        Console.WriteLine("PASS input loops stop with the stop flag and the pause; type_secret errors are generic");
        // A reconnect needs the screen consent the prepare prompt records.
        var resume = Wire.Map("sid", Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"), "restart_resume", true, "resume_expires_at", Client.UnixNow() + 60000);
        try {
            Assert(!RestartResume.HasScreenConsent(resume), "A reconnect nobody prepared has no screen consent");
            RestartResume.Arm(resume, false);
            Assert(RestartResume.HasScreenConsent(resume) && !RestartResume.HasAdministratorConsent(resume), "Preparing records screen consent, and administrator consent only when asked");
            long expiry = Wire.Number(resume, "resume_expires_at"); resume["resume_expires_at"] = expiry + 1;
            Assert(!RestartResume.HasScreenConsent(resume), "The consent is bound to the deadline");
            resume["resume_expires_at"] = expiry;
            RestartResume.Disarm(resume);
            Assert(!RestartResume.HasScreenConsent(resume), "A used or cancelled reconnect clears the screen consent");
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\SupportMcp\ReconnectConsent")) key.SetValue(Wire.Text(resume, "sid"), "someone|" + expiry);
            Assert(!RestartResume.HasScreenConsent(resume), "An administrator consent from an older app is not screen consent");
        } finally { RestartResume.Disarm(resume); }
        Console.WriteLine("PASS a prepared reconnect carries screen consent only when the prompt recorded it");
    }
    static void LaneTests() {
        using (var relay = new FakeRelay()) {
            relay.Lifetime = 300000; relay.Start();
            var caps = (System.Collections.ArrayList)relay.Hello["caps"];
            Assert(Wire.Text(relay.Hello, "agent") == "windows-app-2" && Wire.Text(relay.Hello, "control") == "normal" && caps.Contains("screen") && caps.Contains("uia") && caps.Contains("lanes"), "Hello must announce screen control and lanes");
            Assert(relay.WaitBusy(delegate(string[] b) { return b.Length == 0; }, 5000), "An idle client polls with no busy lane");
            for (int i = 0; i < 100 && relay.LastPoll == null; i++) Thread.Sleep(50);
            Assert(relay.LastPoll != null && relay.LastPoll.ContainsKey("busy") && Wire.Text(relay.LastPoll, "desktop") != "" && relay.LastPoll.ContainsKey("paused_until") && relay.LastPoll["paused_until"] == null, "A poll reports the desktop and no pause");
            string cmdId = relay.Queue(Run("Start-Sleep -Seconds 6; [Console]::Write('slow')", 30));
            Assert(relay.WaitBusy(delegate(string[] b) { return Array.IndexOf(b, "cmd") >= 0 && b.Length == 1; }, 15000), "While a command runs the client keeps polling and reports busy_lanes [cmd]");
            var timer = Stopwatch.StartNew();
            var screen = relay.Call(Act("wait", "seconds", 0.2, "screenshot", false));
            Assert(Wire.Flag(screen, "ok") && timer.ElapsedMilliseconds < 4000 && !relay.HasResult(cmdId), "A screen operation must finish while the command still runs, took " + timer.ElapsedMilliseconds + " ms");
            foreach (string name in new string[] { "block_input", "send_sas" }) {
                var denied = relay.Call(Act(name)); Assert(!Wire.Flag(denied, "ok") && Wire.Text(denied, "error") == "full control is not available in this build", name + " needs full control");
            }
            var control = relay.Call(Wire.Map("type", "control", "lane", "screen", "action", "request_full_control"));
            Assert(!Wire.Flag(control, "ok") && Wire.Text(control, "error") == "full control is not available in this build", "request_full_control is not available in normal mode");
            var bad = relay.Call(Act("fly")); Assert(!Wire.Flag(bad, "ok") && Wire.Text(bad, "error") == "unknown screen action", "Unknown action");
            var secretKey = relay.Call(Act("key", "keys", "ctrl+alt+Delete", "screenshot", false)); Assert(!Wire.Flag(secretKey, "ok"), "ctrl+alt+Delete is refused");
            Assert(!relay.HasResult(cmdId), "The command is still running");
            var done = relay.WaitResult(cmdId, 30);
            Assert(Wire.Flag(done, "ok") && Decode(done, "stdout_b64") == "slow", "The command result still arrives");
            Assert(relay.WaitBusy(delegate(string[] b) { return b.Length == 0; }, 2000), "A finished lane ends the parked poll at once, so the client is free again within 2 s");
            Console.WriteLine("PASS hello, lanes: a screen operation runs while a command runs, and full-control operations are refused");
        }
    }
    // Needs a Windows desktop session: real capture, input and windows.
    static void LiveScreenTests() {
        Screen.Dpi();
        if (Screen.Desktop() != "default" || Screen.Monitors().Count == 0) { Console.WriteLine("SKIP live screen tests: no reachable desktop"); return; }
        using (var relay = new FakeRelay()) {
            relay.Lifetime = 300000; relay.Start();
            var shot = relay.Call(Act("screenshot"));
            Assert(Wire.Flag(shot, "ok") && Wire.Text(shot, "mime") == "image/jpeg" && Wire.Text(shot, "desktop") == "default" && Wire.Number(shot, "displays") >= 1 && Wire.Number(shot, "display") == 0, "Screenshot result: " + Wire.Text(shot, "error"));
            Assert(Wire.Number(shot, "width") <= 1280 && Wire.Number(shot, "height") <= 800 && Wire.Text(shot, "image_b64").Length < 700000 && Hex(Wire.Text(shot, "image_b64")) == Convert.ToBase64String(new byte[] { 0xFF, 0xD8 }), "Screenshot size, limit and JPEG header");
            var zoom = relay.Call(Act("zoom", "x1", 0, "y1", 0, "x2", 200, "y2", 100));
            Assert(Wire.Flag(zoom, "ok") && Wire.Number(zoom, "width") > 0 && Wire.Number(zoom, "width") <= 1280, "Zoom: " + Wire.Text(zoom, "error"));
            var outside = relay.Call(Act("click", "x", 99999, "y", 1, "screenshot", false)); Assert(!Wire.Flag(outside, "ok") && Wire.Text(outside, "error").Contains("outside"), "A click outside the screenshot is refused");
            var tree = relay.Call(Act("ui_tree", "max_lines", 5)); Assert(Wire.Flag(tree, "ok") || Wire.Text(tree, "error") != "", "ui_tree answers");
            var stale = relay.Call(Act("ui_act", "ref", 999, "verb", "invoke", "screenshot", false)); Assert(!Wire.Flag(stale, "ok") && Wire.Text(stale, "error").Contains("ui_tree"), "A ref that ui_tree never gave is refused");
        }
        // Mapping reaches the exact physical pixel, and the guards refuse.
        int mw, mh; var display = Screen.Monitors()[0]; ScreenMath.Fit(display.Width, display.Height, out mw, out mh);
        using (var screen = new Screen()) {
            screen.Start(); Assert(screen.Watch.Ok, "The input hooks must install on a desktop session");
            var stop = new ManualResetEvent(false);
            System.Drawing.Point at = System.Drawing.Point.Empty; Dictionary<string, object> moved = null;
            var t = new Thread(delegate() {
                Screen.Dpi();
                moved = screen.Run(Act("move", "x", mw / 2, "y", mh / 3, "screenshot", false), stop);
                Win.GetCursorPos(out at);
            }); t.Start(); t.Join();
            Assert(Wire.Flag(moved, "ok"), "move: " + Wire.Text(moved, "error"));
            Assert(at.X == display.X + ScreenMath.ToPhysical(mw / 2, mw, display.Width) && at.Y == display.Y + ScreenMath.ToPhysical(mh / 3, mh, display.Height), "The cursor must land on the mapped physical pixel, got " + at.X + "," + at.Y);
            screen.Watch.Clock.Touch(PauseClock.Now());
            foreach (var act in new Dictionary<string, object>[] { Act("click", "x", 5, "y", 5), Act("move", "x", 5, "y", 5), Act("type", "text", "x"), Act("key", "keys", "a"), Act("scroll", "x", 5, "y", 5), Act("drag", "x1", 5, "y1", 5, "x2", 9, "y2", 9) }) {
                var refused = screen.Run(act, stop); Assert(!Wire.Flag(refused, "ok") && Wire.Text(refused, "error") == Screen.PauseText, "Input must be refused during a customer pause: " + ((Dictionary<string, object>)act["action"])["name"]);
            }
            var secretPaused = screen.Run(Act("type_secret", "text", "x"), stop); Assert(!Wire.Flag(secretPaused, "ok") && Wire.Text(secretPaused, "error") == Screen.SecretFailed, "type_secret is refused during a pause with the generic error");
            Assert(Wire.Flag(screen.Run(Act("screenshot"), stop), "ok"), "A screenshot still works during a pause");
            Assert(Wire.Text(screen.Run(Act("ui_tree", "max_lines", 3), stop), "error") != Screen.PauseText, "ui_tree is not paused");
            screen.Watch.Clock.Touch(-100000);
        }
        // Own-window guard: a window of this process at the target refuses the click and the keystrokes.
        using (var screen = new Screen()) {
            screen.Start();
            Dictionary<string, object> click = null, key = null, tree = null; var stop = new ManualResetEvent(false);
            var t = new Thread(delegate() {
                Screen.Dpi();
                using (var form = new Form { StartPosition = FormStartPosition.Manual, Location = new System.Drawing.Point(display.X + 60, display.Y + 60), Size = new System.Drawing.Size(300, 200), TopMost = true }) {
                    form.Show(); form.Activate(); for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(25); }
                    int x = ScreenMath.ToImage(form.Left + 100 - display.X, mw, display.Width), y = ScreenMath.ToImage(form.Top + 100 - display.Y, mh, display.Height);
                    click = screen.Run(Act("click", "x", x, "y", y, "screenshot", false), stop);
                    key = screen.Run(Act("type", "text", "x", "screenshot", false), stop);
                    tree = screen.Run(Act("ui_tree"), stop);
                }
            }); t.SetApartmentState(ApartmentState.STA); t.Start(); t.Join();
            Assert(!Wire.Flag(click, "ok") && Wire.Text(click, "error").Contains("support window"), "A click on this process's window must be refused: " + Wire.Text(click, "error"));
            Assert(!Wire.Flag(key, "ok") && Wire.Text(key, "error").Contains("support window"), "Keystrokes while this process has the focus must be refused: " + Wire.Text(key, "error"));
            Assert(!Wire.Flag(tree, "ok") && Wire.Text(tree, "error").Contains("support window"), "ui_tree must not read this process's window: " + Wire.Text(tree, "error"));
        }
        Console.WriteLine("PASS live screen: capture, zoom, exact cursor mapping, pause and own-window guards");
    }
    public static int Main() {
        string dir = Path.Combine(Path.GetTempPath(), "support-mcp-native-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        try {
            Assert(Ui.Clock(TimeSpan.FromSeconds(0)) == "00:00:00" && Ui.Clock(TimeSpan.FromSeconds(3661)) == "01:01:01" && Ui.Clock(TimeSpan.FromHours(100)) == "100:00:00", "The session clock must format as hh:mm:ss");
            foreach (bool administrator in new bool[] { false, true }) {
                foreach (bool reconnect in new bool[] { false, true }) {
                    foreach (DialogResult answer in new DialogResult[] { DialogResult.Yes, DialogResult.No, DialogResult.Cancel }) {
                        int prompts = 0;
                        bool allowed = SupportAccess.Confirm(administrator, reconnect, delegate(string message) {
                            prompts++;
                            Assert(message.Contains("with administrator rights?") == administrator, "Consent must describe the actual access rights");
                            Assert(message.Contains("see your screen") && message.Contains("control your mouse and keyboard") && message.Contains("run commands") && message.Contains("change files"), "Consent must name screen, mouse and keyboard control as well as commands and files: " + message);
                            return answer;
                        });
                        bool preconsented = reconnect && !administrator;
                        Assert(allowed == (preconsented || answer == DialogResult.Yes), "Only explicit Yes grants new access");
                        Assert(prompts == (preconsented ? 0 : 1), "Administrator startup and reconnect must always prompt");
                    }
                }
            }
            Console.WriteLine("PASS consent accepts only Yes, describes actual rights, and never silently grants administrator reconnect");
            using (var relay = new FakeRelay()) {
                relay.Lifetime = 300000; // covers the 60 s cold-start allowance below plus the rest of this block
                relay.Start();
                Assert(relay.Elevated == SupportAccess.IsAdministrator(), "Handshake must report actual token rights");
                var rights = relay.Call(Run("$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); [Console]::Write($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))", 60));
                Assert(Wire.Flag(rights, "ok") && Decode(rights, "stdout_b64") == SupportAccess.IsAdministrator().ToString(), "Commands must inherit the consented access rights: timed_out=" + Wire.Flag(rights, "timed_out") + " exit_code=" + Wire.Number(rights, "exit_code") + " stdout=[" + Decode(rights, "stdout_b64") + "] stderr=[" + Decode(rights, "stderr_b64") + "]");
                var r = relay.Call(Run("[Console]::Write('hello ' + [char]0x2713); [Console]::Error.Write('warning'); exit 7", 10));
                Assert(Wire.Flag(r, "ok") && Wire.Number(r, "exit_code") == 7, "Exit code");
                Assert(Decode(r, "stdout_b64") == "hello \u2713" && Decode(r, "stderr_b64") == "warning", "Unicode and stderr");
                r = relay.Call(Run("[Console]::Write(('x' * 80000))", 10));
                Assert(Convert.FromBase64String(Wire.Text(r, "stdout_b64")).Length == 65536 && Wire.Flag(r, "stdout_truncated"), "Bounded output");
                string file = Path.Combine(dir, "a file 'with quotes' \u2713.bin"); byte[] data = new byte[700000]; new Random(17).NextBytes(data);
                r = relay.Call(Wire.Map("type", "put_file", "path", file, "data_b64", Convert.ToBase64String(data, 0, 500000), "append", false));
                Assert(Wire.Flag(r, "ok") && Wire.Number(r, "bytes") == 500000, "First file write");
                relay.Call(Wire.Map("type", "put_file", "path", file, "data_b64", Convert.ToBase64String(data, 500000, 200000), "append", true));
                r = relay.Call(Wire.Map("type", "get_file", "path", file, "offset", 0, "length", 524288));
                Assert(!Wire.Flag(r, "eof") && Wire.Number(r, "size") == data.Length, "File size and first chunk");
                byte[] first = Convert.FromBase64String(Wire.Text(r, "data_b64"));
                r = relay.Call(Wire.Map("type", "get_file", "path", file, "offset", 524288, "length", 524288));
                byte[] last = Convert.FromBase64String(Wire.Text(r, "data_b64")); Assert(Wire.Flag(r, "eof"), "Last chunk");
                for (int i = 0; i < data.Length; i++) Assert(data[i] == (i < first.Length ? first[i] : last[i - first.Length]), "Byte round trip");
                r = relay.Call(Wire.Map("type", "get_file", "path", "relative.txt", "length", 1)); Assert(!Wire.Flag(r, "ok"), "Relative path refused");
                // put_file creates missing parent directories, like the PowerShell agent.
                string nested = Path.Combine(dir, "a", "b", "c", "data.bin"); byte[] nestedData = new byte[] { 1, 2, 3, 4, 5, 6 };
                Assert(!Directory.Exists(Path.Combine(dir, "a")), "Test setup: parent must not exist");
                r = relay.Call(Wire.Map("type", "put_file", "path", nested, "data_b64", Convert.ToBase64String(nestedData, 0, 4), "append", false));
                Assert(Wire.Flag(r, "ok") && Wire.Number(r, "bytes") == 4, "First chunk into a missing directory: " + Wire.Text(r, "error"));
                r = relay.Call(Wire.Map("type", "put_file", "path", nested, "data_b64", Convert.ToBase64String(nestedData, 4, 2), "append", true));
                Assert(Wire.Flag(r, "ok") && Wire.Number(r, "bytes") == 2, "Append chunk after creating the directory: " + Wire.Text(r, "error"));
                Assert(Convert.ToBase64String(File.ReadAllBytes(nested)) == Convert.ToBase64String(nestedData), "Nested upload byte round trip");
                // get_file reads a file that another process is still writing, if the writer allows readers.
                string live = Path.Combine(dir, "live.log");
                using (var writer = new FileStream(live, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) {
                    byte[] one = Encoding.ASCII.GetBytes("first line\r\n"), two = Encoding.ASCII.GetBytes("second line\r\n");
                    writer.Write(one, 0, one.Length); writer.Flush();
                    r = relay.Call(Wire.Map("type", "get_file", "path", live, "offset", 0, "length", 1000));
                    Assert(Wire.Flag(r, "ok"), "Live file must be readable: " + Wire.Text(r, "error"));
                    Assert(Decode(r, "data_b64") == "first line\r\n" && Wire.Flag(r, "eof"), "Live file bytes written so far");
                    writer.Write(two, 0, two.Length); writer.Flush();
                    r = relay.Call(Wire.Map("type", "get_file", "path", live, "offset", one.Length, "length", 1000));
                    Assert(Wire.Flag(r, "ok") && Decode(r, "data_b64") == "second line\r\n" && Wire.Number(r, "size") == one.Length + two.Length, "Live file read continues while the writer keeps writing");
                }
                // put_file does not lock out a reader that already has the file open, like the PowerShell agent.
                using (var reader = new FileStream(nested, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
                    r = relay.Call(Wire.Map("type", "put_file", "path", nested, "data_b64", Convert.ToBase64String(nestedData, 0, 1), "append", true));
                    Assert(Wire.Flag(r, "ok"), "Append while another process reads the file: " + Wire.Text(r, "error"));
                }
                int pollsBefore = relay.Polls;
                r = relay.Call(Run("Start-Sleep -Seconds 4; [Console]::Write('slept')", 15));
                Assert(Wire.Flag(r, "ok") && Decode(r, "stdout_b64") == "slept", "Long operation result");
                Assert(relay.Polls - pollsBefore <= 4, "A busy client must wait for its operation instead of polling in a loop, polls: " + (relay.Polls - pollsBefore));
                string counter = Path.Combine(dir, "executed.txt"); relay.FailFirstResult = true;
                r = relay.Call(Run("Add-Content -LiteralPath '" + counter + "' -Value once", 10));
                Assert(File.ReadAllLines(counter).Length == 1, "Result retries must not repeat execution");
                string late = Path.Combine(dir, "timeout-late"), started = Path.Combine(dir, "timeout-started");
                r = relay.Call(Run(ChildCommand(late, started), 1));
                Assert(Wire.Flag(r, "timed_out") && r["exit_code"] == null, "Timeout result");
                Thread.Sleep(3500); Assert(!File.Exists(late), "Timeout must kill descendants");
                late = Path.Combine(dir, "end-late"); started = Path.Combine(dir, "end-started");
                relay.Queue(Run(ChildCommand(late, started), 20)); WaitFile(started); relay.End = true; relay.WaitExit();
                Thread.Sleep(3500); Assert(!File.Exists(late), "Operator end must kill descendants");
                Console.WriteLine("PASS commands, Unicode, bounded output, file chunks, retry deduplication, timeout and operator-end process trees");
            }
            using (var relay = new FakeRelay()) {
                relay.Start(); string late = Path.Combine(dir, "close-late"), started = Path.Combine(dir, "close-started");
                relay.Queue(Run(ChildCommand(late, started), 20)); WaitFile(started); relay.Agent.Stop(); relay.WaitExit();
                Thread.Sleep(3500); Assert(!File.Exists(late) && relay.End, "Customer close must kill descendants and end relay access");
                Console.WriteLine("PASS customer close cancels processes and ends relay access");
            }
            using (var relay = new FakeRelay()) {
                relay.Lifetime = 800; relay.Start(); relay.WaitExit(); Assert(relay.End, "Local expiry must end access");
                Console.WriteLine("PASS local fixed expiry");
            }
            // A PC clock three hours ahead of the relay: the absolute startup deadline in the
            // file is then already in the past on the PC. The relative budget must still win.
            using (var relay = new FakeRelay(Wire.Map("sid", new string('a', 64), "key", new string('b', 64), "startup_expires_at", Client.UnixNow() - 10800000 + 60000, "startup_ms", 60000))) {
                relay.ClockSkew = 10800000; relay.Lifetime = 600000; relay.Start();
                for (int i = 0; i < 100 && relay.Agent.ExpiresLocal == DateTime.MinValue; i++) Thread.Sleep(50);
                Assert(Math.Abs((relay.Agent.ExpiresLocal.ToUniversalTime() - DateTime.UtcNow).TotalMilliseconds - 600000) < 5000, "Ends-by-itself time must come from the relay's remaining time on the PC's own clock");
                var r = relay.Call(Run("[Console]::Write('ok')", 10));
                Assert(Wire.Flag(r, "ok") && Decode(r, "stdout_b64") == "ok", "A fast PC clock must not stop the client");
                Console.WriteLine("PASS fast PC clock keeps the startup and session deadlines relative");
            }
            using (var relay = new FakeRelay(Wire.Map("sid", new string('a', 64), "key", new string('b', 64), "startup_expires_at", Client.UnixNow() - 10800000 + 60000))) {
                relay.Refuse = true; relay.Launch();
                relay.WaitExit(); // no handshake can finish, so only the startup deadline can stop it, and an absolute one that is already past does
                Console.WriteLine("PASS absolute startup deadline is only a fallback");
            }
            using (var relay = new FakeRelay()) {
                relay.Start(); relay.Agent.EndRemote = false; relay.Agent.Stop(); relay.WaitExit();
                Assert(!relay.End, "An explicitly prepared Windows shutdown must preserve the relay session");
                Console.WriteLine("PASS prepared shutdown preserves relay access for reconnection");
            }
            var resume = Wire.Map("sid", Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"), "restart_resume", true, "resume_expires_at", Client.UnixNow() + 60000);
            string resumePath = RestartResume.PathFor(resume);
            Assert(RestartResume.Valid(resume, resumePath), "Scoped, unexpired reconnect must be valid");
            Assert(!RestartResume.Valid(resume, Path.Combine(dir, "agent.exe")), "A downloaded file cannot bypass consent with a resume switch");
            resume["resume_expires_at"] = Client.UnixNow() - 1;
            Assert(!RestartResume.Valid(resume, resumePath), "Expired reconnect must be refused");
            resume["resume_expires_at"] = Client.UnixNow() + 86401000;
            Assert(!RestartResume.Valid(resume, resumePath), "Reconnect cannot exceed 24 hours");
            try {
                RestartResume.Arm(resume);
                using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\RunOnce"))
                    Assert((string)key.GetValue(RestartResume.ValueName(resume)) == "\"" + resumePath + "\" --resume", "One-time sign-in command");
            } finally { RestartResume.Disarm(resume); }
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\RunOnce"))
                Assert(key.GetValue(RestartResume.ValueName(resume)) == null, "End must remove automatic reconnect");
            resume["resume_expires_at"] = Client.UnixNow() + 60000;
            try {
                Assert(!RestartResume.HasAdministratorConsent(resume), "Administrator resume needs advance consent");
                RestartResume.Arm(resume, true);
                Assert(RestartResume.HasAdministratorConsent(resume), "Preparation can consent to one administrator reconnect");
                long expiry = Wire.Number(resume, "resume_expires_at");
                resume["resume_expires_at"] = expiry + 1;
                Assert(!RestartResume.HasAdministratorConsent(resume), "Approval cannot extend or change the deadline");
                resume["resume_expires_at"] = expiry;
                RestartResume.Disarm(resume);
                Assert(!RestartResume.HasAdministratorConsent(resume), "Consuming or cancelling reconnect clears administrator consent");
                RestartResume.Arm(resume, false);
                Assert(!RestartResume.HasAdministratorConsent(resume), "Normal-user preparation cannot preapprove administrator access");
            } finally { RestartResume.Disarm(resume); }
            Console.WriteLine("PASS reconnect path/deadline constraints and one-time startup registration/removal");
            ScreenPureTests(dir);
            ClientRuleTests(dir);
            LaneTests();
            LiveScreenTests();
            // The downloaded PE overlay must be readable by the actual .NET client.
            string overlay = Path.Combine(dir, "overlay.exe"); byte[] cfg = Encoding.UTF8.GetBytes(Wire.Json().Serialize(Wire.Map("sid", new string('a', 64), "key", new string('b', 64), "origin", "https://support.example.com", "startup_expires_at", Client.UnixNow() + 10000)));
            using (var f = File.Create(overlay)) { f.WriteByte(77); f.WriteByte(90); f.Write(cfg, 0, cfg.Length); byte[] n = BitConverter.GetBytes(cfg.Length); f.Write(n, 0, n.Length); byte[] footer = Encoding.ASCII.GetBytes(Wire.Footer); f.Write(footer, 0, footer.Length); }
            Assert(Wire.Text(Wire.ReadConfig(overlay), "sid") == new string('a', 64), "Overlay configuration");
            Console.WriteLine("PASS executable session overlay"); return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        finally { Directory.Delete(dir, true); }
    }
}
