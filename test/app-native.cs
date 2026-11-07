// Compile with src/agent-app.cs, /main:AppTests and the same v4 references.
// Runs the real HTTP client and native Job containment on a Windows test host.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
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

// A fake /device/ relay for DeviceLink, on an HttpListener like FakeRelay. Status and Body are what it answers next;
// LastPath, LastAuth and LastJson record the request it saw; Refuse drops the connection, so the client reads offline.
sealed class FakeDevice : IDisposable {
    readonly HttpListener listener = new HttpListener();
    readonly Thread server;
    public readonly string Origin;
    public volatile int Status = 200;
    public volatile string Body = "{\"protocol\":1}";
    public volatile string LastPath = "", LastAuth, LastJson = "";
    public volatile bool Refuse;
    public FakeDevice() {
        var tcp = new TcpListener(IPAddress.Loopback, 0); tcp.Start(); int port = ((IPEndPoint)tcp.LocalEndpoint).Port; tcp.Stop();
        Origin = "http://127.0.0.1:" + port;
        listener.Prefixes.Add(Origin + "/"); listener.Start();
        server = new Thread(Serve); server.IsBackground = true; server.Start();
    }
    void Serve() {
        try { while (listener.IsListening) { var ctx = listener.GetContext(); ThreadPool.QueueUserWorkItem(delegate { Reply(ctx); }); } }
        catch (HttpListenerException) { } catch (ObjectDisposedException) { }
    }
    void Reply(HttpListenerContext ctx) {
        try {
            if (Refuse) { ctx.Response.Abort(); return; }
            LastPath = ctx.Request.Url.AbsolutePath; LastAuth = ctx.Request.Headers["Authorization"];
            using (var r = new StreamReader(ctx.Request.InputStream)) LastJson = r.ReadToEnd();
            byte[] bytes = Encoding.UTF8.GetBytes(Body);
            ctx.Response.StatusCode = Status; ctx.Response.ContentType = "application/json"; ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length); ctx.Response.Close();
        } catch (Exception) { try { ctx.Response.Abort(); } catch (Exception) { } }
    }
    public Dictionary<string, object> Sent() { return Wire.Json().Deserialize<Dictionary<string, object>>(LastJson); }
    public void Dispose() { try { listener.Close(); } catch (Exception) { } server.Join(1000); }
}

public static class AppTests {
    static void Assert(bool ok, string detail) { if (!ok) throw new Exception(detail); }
    static void m3Release(System.Threading.Mutex m) { try { m.ReleaseMutex(); } catch (Exception) { } }
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
    static void ThrowsData(Action action, string detail) {
        try { action(); } catch (InvalidDataException) { return; }
        throw new Exception("Expected an InvalidDataException: " + detail);
    }
    // An exe with a footer, built like the relay's overlay: body bytes, the JSON, its length, then the magic string.
    static byte[] Overlay(Dictionary<string, object> cfg) {
        byte[] body = new byte[] { 77, 90, 1, 2, 3 }, json = Encoding.UTF8.GetBytes(Wire.Json().Serialize(cfg));
        var ms = new MemoryStream(); ms.Write(body, 0, body.Length); ms.Write(json, 0, json.Length);
        byte[] n = BitConverter.GetBytes(json.Length); ms.Write(n, 0, n.Length);
        byte[] footer = Encoding.ASCII.GetBytes(Wire.Footer); ms.Write(footer, 0, footer.Length);
        return ms.ToArray();
    }
    static List<Dictionary<string, object>> BadDeviceFooters() {
        var list = new List<Dictionary<string, object>>();
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com", "code", "ABCDE-FGH23", "workspace", "acme")); // both
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com", "code", "ABCDE-FGH2")); // short
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com", "code", "ABCDE-FGH0I")); // 0 and I are not in the alphabet
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com", "workspace", "Acme")); // uppercase slug
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com", "workspace", "")); // empty slug
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com", "extra", "1")); // an unknown field
        list.Add(Wire.Map("kind", "device", "origin", "http://evil.example.com")); // http that is not loopback
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com/path")); // an origin with a path
        list.Add(Wire.Map("kind", "other", "origin", "https://support.example.com")); // not a device kind
        list.Add(Wire.Map("kind", "device")); // no origin
        return list;
    }
    // ReadConfig takes a session footer and refuses a device footer; ReadDevice does the reverse. The kind is read first.
    static void FooterReaderTests() {
        byte[] session = Overlay(Wire.Map("sid", new string('a', 64), "key", new string('b', 64), "origin", "https://support.example.com"));
        Assert(Wire.Kind(session) == "" && Wire.Text(Wire.ReadConfig(session), "sid") == new string('a', 64), "A session footer parses as a session");
        ThrowsData(delegate { Wire.ReadDevice(session); }, "a session footer is not a setup footer");
        byte[] device = Overlay(Wire.Map("kind", "device", "origin", "https://support.example.com", "code", "ABCDE-FGH23"));
        Assert(Wire.Kind(device) == "device", "The kind is read first");
        var d = Wire.ReadDevice(device);
        Assert(Wire.Text(d, "code") == "ABCDE-FGH23" && Wire.Text(d, "origin") == "https://support.example.com", "A device footer with a code parses");
        ThrowsData(delegate { Wire.ReadConfig(device); }, "no session role runs on a device footer");
        Assert(Wire.Text(Wire.ReadDevice(Overlay(Wire.Map("kind", "device", "origin", "https://support.example.com", "workspace", "acme-1"))), "workspace") == "acme-1", "A workspace footer parses");
        Assert(!Wire.ReadDevice(Overlay(Wire.Map("kind", "device", "origin", "https://support.example.com"))).ContainsKey("code"), "A plain device footer carries no code");
        Assert(Wire.Text(Wire.ReadDevice(Overlay(Wire.Map("kind", "device", "origin", "http://127.0.0.1:8787"))), "origin") == "http://127.0.0.1:8787", "Loopback http is allowed for a device footer");
        foreach (Dictionary<string, object> bad in BadDeviceFooters()) ThrowsData(delegate { Wire.ReadDevice(Overlay(bad)); }, Wire.Json().Serialize(bad));
        Console.WriteLine("PASS a setup footer parses, a session footer still parses, and each footer reader refuses the other");
    }
    // DeviceLink against a fake /device/ relay: every status maps, the key goes in the header, and a drop is offline.
    static void DeviceLinkTests() {
        using (var relay = new FakeDevice()) {
            var link = new DeviceLink(relay.Origin);
            relay.Status = 201; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "status", "active", "workspace", "default", "device_id", new string('a', 20), "key", "smd1.default.id.secret"));
            var a = link.Pair(Wire.Map("code", "ABCDE-FGH23", "name", "Front desk", "access", "any", "control", "full"));
            Assert(a.Result == DeviceLink.DeviceResult.Ok && a.Ok && Wire.Text(a.Body, "key").StartsWith("smd1.") && Wire.Text(a.Body, "status") == "active", "A 201 pair is Ok with the key and the device id");
            Assert(relay.LastPath == "/device/pair" && relay.LastAuth == null, "pair posts to /device/pair with no key");
            Assert(Wire.Number(relay.Sent(), "protocol") == 1 && Wire.Text(relay.Sent(), "code") == "ABCDE-FGH23", "Every request carries protocol 1");
            relay.Status = 202; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "status", "pending", "confirm", "482913", "key", "smd1.default.id.secret", "expires_at", 1));
            Assert(link.Pair(Wire.Map("workspace", "acme")).Result == DeviceLink.DeviceResult.Pending, "A 202 pair is Pending");
            relay.Status = 404; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "code_invalid", "message", "this code is not valid")));
            Assert(link.Pair(Wire.Map("code", "ZZZZZ-ZZZZZ")).Result == DeviceLink.DeviceResult.CodeInvalid, "A 404 code_invalid is CodeInvalid");
            relay.Status = 400; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "bad_request", "message", "send code or workspace")));
            var refused = link.Pair(Wire.Map());
            Assert(refused.Result == DeviceLink.DeviceResult.Refused && refused.Message == "send code or workspace", "A refusal carries the relay's own message");
            relay.Status = 200; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "device", Wire.Map("id", "d", "workspace", "default", "status", "active", "name", "PC", "access", "ask", "control", "limited", "site_id", null)));
            var h = link.Hello("smd1.default.id.secret", Wire.Map("os", "Windows 11", "machine", "POS-1", "app_version", "0.4.0"));
            Assert(h.Result == DeviceLink.DeviceResult.Ok && relay.LastAuth == "Bearer smd1.default.id.secret" && relay.LastPath == "/device/hello", "hello sends the key in the Authorization header, never the URL");
            Assert(Wire.Text(h.Body["device"] as Dictionary<string, object>, "access") == "ask", "hello returns the device the relay sent");
            relay.Status = 401; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "device_unknown", "message", "this key is not valid")));
            Assert(link.Hello("smd1.k", Wire.Map()).Result == DeviceLink.DeviceResult.Removed, "A 401 is Removed");
            relay.Status = 426; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "protocol_unsupported", "message", "update needed"), "supported", Wire.Map("min", 2, "max", 2)));
            Assert(link.Hello("smd1.k", Wire.Map()).Result == DeviceLink.DeviceResult.UpdateNeeded, "A 426 is UpdateNeeded");
            relay.Status = 200; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "device", Wire.Map("id", "d", "status", "active")));
            link.Update("smd1.k", Wire.Map("access", "any"));
            Assert(relay.LastPath == "/device/update" && Wire.Text(relay.Sent(), "access") == "any" && relay.LastAuth == "Bearer smd1.k", "update posts the change with the key");
            relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "removed", true));
            link.Leave("smd1.k");
            Assert(relay.LastPath == "/device/leave" && relay.Sent().Count == 1 && Wire.Number(relay.Sent(), "protocol") == 1, "leave posts only the protocol, with the key");
            relay.Refuse = true;
            Assert(link.Hello("smd1.k", Wire.Map()).Result == DeviceLink.DeviceResult.Offline && link.Hello("smd1.k", Wire.Map()).Status == 0, "A dropped connection is Offline with no status");
        }
        Console.WriteLine("PASS the device client speaks the /device/ wire: pair, check-in, update and leave, with status mapping and offline");
    }
    // The setup wizard's pure rules: code normalisation, step validation, the answers argument and the exit-code map.
    static void SetupRuleTests() {
        // A code is normalised to ABCDE-FGH23 whatever the case, spaces or hyphens; 0, 1, I and O are not in the alphabet.
        Assert(DeviceSetup.NormalizeCode("abcde-fgh23") == "ABCDE-FGH23", "lower case");
        Assert(DeviceSetup.NormalizeCode("ABCDEFGH23") == "ABCDE-FGH23", "no hyphen");
        Assert(DeviceSetup.NormalizeCode(" abc de-fg h23 ") == "ABCDE-FGH23", "spaces");
        foreach (string bad in new string[] { "", "ABCDE-FGH2", "ABCDE-FGH234", "ABCDE-FGH2I", "ABCDE-FGH2O", "ABCDE FGH2!", "11111-11111" })
            Assert(DeviceSetup.NormalizeCode(bad) == null, "a bad code is null: " + bad);
        Assert(DeviceSetup.CodeCharsOk("ABCDE-FGH") && DeviceSetup.CodeCharsOk("") && !DeviceSetup.CodeCharsOk("ABCDEFGHJKL") && !DeviceSetup.CodeCharsOk("ABC!"), "as typed: only the alphabet, at most ten");

        // A name is required, trimmed, at most 100 characters, no control characters.
        Assert(DeviceSetup.CheckName("Front desk") == "" && DeviceSetup.CheckName("  x  ") == "", "a plain name is fine");
        Assert(DeviceSetup.CheckName("") != "" && DeviceSetup.CheckName("   ") != "" && DeviceSetup.CheckName(new string('x', 101)) != "" && DeviceSetup.CheckName("a\tb") != "", "bad names are refused");

        // Step validation: nothing is preselected, so each choice must be made; a workspace install needs no code.
        Assert(DeviceSetup.Missing(DeviceSetup.Screen.Code, "", false, "", null, null) != "", "a missing code stops the code step");
        Assert(DeviceSetup.Missing(DeviceSetup.Screen.Code, "", true, "", null, null) == "", "a workspace install needs no code");
        Assert(DeviceSetup.Missing(DeviceSetup.Screen.Code, "abcde-fgh23", false, "", null, null) == "", "a good code passes the code step");
        Assert(DeviceSetup.Missing(DeviceSetup.Screen.Name, "", false, "", null, null) != "" && DeviceSetup.Missing(DeviceSetup.Screen.Name, "", false, "PC", null, null) == "", "the name step");
        Assert(DeviceSetup.Missing(DeviceSetup.Screen.Access, "", false, "PC", null, null) != "" && DeviceSetup.Missing(DeviceSetup.Screen.Access, "", false, "PC", "ask", null) == "" && DeviceSetup.Missing(DeviceSetup.Screen.Access, "", false, "PC", "any", null) == "", "the access step needs a choice");
        Assert(DeviceSetup.Missing(DeviceSetup.Screen.Control, "", false, "PC", "ask", null) != "" && DeviceSetup.Missing(DeviceSetup.Screen.Control, "", false, "PC", "ask", "full") == "" && DeviceSetup.Missing(DeviceSetup.Screen.Control, "", false, "PC", "ask", "limited") == "", "the control step needs a choice");
        Assert(DeviceSetup.StepOf(DeviceSetup.Screen.Code) == 1 && DeviceSetup.StepOf(DeviceSetup.Screen.Install) == 5 && DeviceSetup.StepOf(DeviceSetup.Screen.Intro) == 0 && DeviceSetup.StepOf(DeviceSetup.Screen.Done) == 0, "steps 1 to 5 are code to install");

        // The answers argument: base64url JSON, decoded and checked again. No owner contact (call 7).
        string withCode = DeviceSetup.EncodeAnswers(" Front desk ", "any", "full", "ABCDE-FGH23");
        Assert(System.Text.RegularExpressions.Regex.IsMatch(withCode, "^[A-Za-z0-9_-]+$"), "the argument is base64url with no padding");
        var back = DeviceSetup.DecodeAnswers(withCode);
        Assert(Wire.Text(back, "name") == "Front desk" && Wire.Text(back, "access") == "any" && Wire.Text(back, "control") == "full" && Wire.Text(back, "code") == "ABCDE-FGH23" && !back.ContainsKey("workspace"), "a code's answers round-trip, trimmed");
        var ws = DeviceSetup.DecodeAnswers(DeviceSetup.EncodeAnswers("PC", "ask", "limited", null));
        Assert(Wire.Flag(ws, "workspace") && !ws.ContainsKey("code") && Wire.Text(ws, "access") == "ask", "a workspace install carries workspace true, no code");
        Assert(!back.ContainsKey("owner_contact") && !ws.ContainsKey("owner_contact"), "the answers never carry an owner contact");
        foreach (string arg in new string[] { "", "not base64url!!", "====" })
            ThrowsData(delegate { DeviceSetup.DecodeAnswers(arg); }, "junk: " + arg);
        // Tampered JSON is refused: a bad access, a missing field, both a code and a workspace, an over-long argument.
        Func<Dictionary<string, object>, string> enc = delegate(Dictionary<string, object> m) {
            string b = Convert.ToBase64String(Encoding.UTF8.GetBytes(Wire.Json().Serialize(m)));
            return b.TrimEnd('=').Replace('+', '-').Replace('/', '_');
        };
        foreach (Dictionary<string, object> bad in new List<Dictionary<string, object>> {
            Wire.Map("name", "PC", "access", "sometimes", "control", "full", "code", "ABCDE-FGH23"),
            Wire.Map("name", "PC", "access", "ask", "control", "other", "code", "ABCDE-FGH23"),
            Wire.Map("name", "", "access", "ask", "control", "full", "code", "ABCDE-FGH23"),
            Wire.Map("name", "PC", "access", "ask", "control", "full", "code", "abcde-fgh23"),
            Wire.Map("name", "PC", "access", "ask", "control", "full", "code", "ABCDE-FGH23", "workspace", true),
            Wire.Map("name", "PC", "access", "ask", "control", "full"),
            Wire.Map("name", "PC", "access", "ask", "control", "full", "owner_contact", "x", "code", "ABCDE-FGH23"),
        }) ThrowsData(delegate { DeviceSetup.DecodeAnswers(enc(bad)); }, Wire.Json().Serialize(bad));
        ThrowsData(delegate { DeviceSetup.DecodeAnswers(new string('A', DeviceSetup.MaxAnswers + 1)); }, "too long");

        // The exit-code map: where the wizard goes and what it says.
        Assert(DeviceSetup.After(DeviceSetup.Active) == DeviceSetup.Screen.Done && DeviceSetup.After(DeviceSetup.Pending) == DeviceSetup.Screen.Waiting && DeviceSetup.After(DeviceSetup.CodeInvalid) == DeviceSetup.Screen.Code && DeviceSetup.After(DeviceSetup.AlreadySetUp) == DeviceSetup.Screen.Already, "each exit code goes to its screen");
        Assert(DeviceSetup.After(DeviceSetup.Network) == DeviceSetup.Screen.Install && DeviceSetup.After(DeviceSetup.Refused) == DeviceSetup.Screen.Install && DeviceSetup.After(999) == DeviceSetup.Screen.Install, "network, refused and anything unknown go back to the install step");
        Assert(DeviceSetup.ExitText(DeviceSetup.Active) == "" && DeviceSetup.ExitText(DeviceSetup.Pending) == "" && DeviceSetup.ExitText(DeviceSetup.AlreadySetUp) == "", "the success screens carry no error");
        Assert(DeviceSetup.ExitText(DeviceSetup.CodeInvalid).Contains("code") && DeviceSetup.ExitText(DeviceSetup.Network).Contains("reach") && DeviceSetup.ExitText(DeviceSetup.Refused).Contains("refused"), "code, network and refused each say what happened");
        Assert(DeviceSetup.ShowConfirm("482913") == "482 913" && DeviceSetup.ShowConfirm("abc") == null && DeviceSetup.ShowConfirm(null) == null, "six digits show as two groups");
        Assert(DeviceSetup.ModeText("any").Contains("any time") && DeviceSetup.ModeText("ask").Contains("asks you") && DeviceSetup.Folder.EndsWith("SupportMCP") && DeviceSetup.Exe.EndsWith("support.exe"), "the mode text and the install paths");
        // The OS line: Windows 11 still says "Windows 10" in ProductName, so the build decides; capped at the relay's 100.
        Assert(DeviceSetup.OsName("Windows 10 Pro", "26200", "25H2") == "Windows 11 Pro 25H2 (build 26200)", "Windows 11 by its build");
        Assert(DeviceSetup.OsName("Windows 10 Pro", "19045", "22H2") == "Windows 10 Pro 22H2 (build 19045)", "Windows 10 stays Windows 10");
        Assert(DeviceSetup.OsName("Windows 7 Professional", "7601", null) == "Windows 7 Professional (build 7601)", "Windows 7 has no release");
        Assert(DeviceSetup.OsName(null, "7601", null) == "Windows (build 7601)" && DeviceSetup.OsName(new string('x', 300), "1", null).Length == 100, "no name, and the cap");
        Assert(DeviceSetup.Os().StartsWith("Windows", StringComparison.Ordinal) && DeviceSetup.Os().IndexOf("NT 6.2", StringComparison.Ordinal) < 0, "this PC's line names Windows, not NT 6.2: " + DeviceSetup.Os());
        Console.WriteLine("PASS the setup wizard rules: code format, step validation, the answers argument, and the exit-code map");
    }
    // The elevated install's pure parts: the leftover decision, the service command line, the registry builders, the
    // Apps entry values, the install paths and the locked-folder ACL (read back as the FullControl tests do).
    static void DeviceInstallTests() {
        Assert(DeviceInstall.LeftoverAction(true, false) == DeviceInstall.Leftover.AlreadySetUp && DeviceInstall.LeftoverAction(true, true) == DeviceInstall.Leftover.AlreadySetUp, "a running service means Support is already set up");
        Assert(DeviceInstall.LeftoverAction(false, true) == DeviceInstall.Leftover.Clean, "the folder with no service is a crash leftover to clean");
        Assert(DeviceInstall.LeftoverAction(false, false) == DeviceInstall.Leftover.Proceed, "nothing installed means a clean install");

        string exe = @"C:\Program Files\SupportMCP\support.exe";
        Assert(DeviceInstall.ServiceBinary(exe) == "\"C:\\Program Files\\SupportMCP\\support.exe\" --device-service", "the service path is quoted, with --device-service");
        Assert(DeviceInstall.TrayRunValue(exe) == "\"C:\\Program Files\\SupportMCP\\support.exe\" --tray", "the tray startup value is quoted, with --tray");

        var apps = DeviceInstall.AppsValues("0.4.0", @"C:\Program Files\SupportMCP", exe, 512);
        Assert(Wire.Text(apps, "DisplayName") == "Support" && Wire.Text(apps, "DisplayVersion") == "0.4.0" && Wire.Text(apps, "Publisher") == "Support-MCP", "the Apps entry names the app, its version and publisher");
        Assert(Wire.Text(apps, "InstallLocation") == @"C:\Program Files\SupportMCP" && Wire.Text(apps, "UninstallString") == "\"" + exe + "\" --uninstall", "the Apps entry says where it is and how to uninstall it");
        Assert(apps["NoModify"] is int && (int)apps["NoModify"] == 1 && apps["NoRepair"] is int && (int)apps["NoRepair"] == 1 && apps["EstimatedSize"] is int && (int)apps["EstimatedSize"] == 512, "NoModify, NoRepair and EstimatedSize are whole numbers");
        Assert(!apps.ContainsKey("DisplayIcon"), "there is no DisplayIcon: the exe carries no icon");

        Assert(DeviceSetup.Folder.EndsWith("\\SupportMCP") && DeviceSetup.Exe == Path.Combine(DeviceSetup.Folder, "support.exe") && Directory.Exists(FullInstall.Root), "the install folder is under %ProgramFiles%\\SupportMCP and the app is support.exe in it");

        // The locked folder: owner Administrators, SYSTEM and Administrators full, nothing inherited (as FullAcl.Folder,
        // which the one-off tests already check on disk, plus the owner this install sets).
        var locked = DeviceInstall.LockedFolder();
        Assert(locked.AreAccessRulesProtected && ((SecurityIdentifier)locked.GetOwner(typeof(SecurityIdentifier))).Equals(FullAcl.AdminsSid), "the locked folder is owned by Administrators and does not inherit");
        var rules = locked.GetAccessRules(true, true, typeof(SecurityIdentifier));
        Assert(rules.Count == 2, "two rules: " + rules.Count);
        foreach (FileSystemAccessRule r in rules)
            Assert((r.IdentityReference.Equals(FullAcl.SystemSid) || r.IdentityReference.Equals(FullAcl.AdminsSid)) && r.FileSystemRights == FileSystemRights.FullControl && !r.IsInherited
                && r.InheritanceFlags == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit), "only SYSTEM and Administrators, full control, inherited by files and folders");
        Console.WriteLine("PASS the elevated install: the leftover decision, the service and tray command lines, the Apps entry, the paths and the locked folder");
    }
    // The saved PC service's pure parts: the state map for every wire result, the timing and backoff, the refresh
    // limit, the history cap, the status frame, and the live pipe (frame vocabulary and the ACL).
    static void DeviceServiceTests(string dir) {
        // Classify: a 200 is active or pending (from the body); a 401 is removed from active and expired from pending;
        // 426 is update_needed; offline and an unexpected refusal keep trying. (DeviceLink already maps each HTTP
        // status to these results, so this covers every wire status.)
        DeviceService.Schedule sched;
        Assert(DeviceService.Classify("active", DeviceLink.DeviceResult.Ok, "active", out sched) == DeviceState.Active && sched == DeviceService.Schedule.Normal, "200 active");
        Assert(DeviceService.Classify("pending", DeviceLink.DeviceResult.Ok, "pending", out sched) == DeviceState.Pending && sched == DeviceService.Schedule.Normal, "200 still pending");
        Assert(DeviceService.Classify("pending", DeviceLink.DeviceResult.Ok, "active", out sched) == DeviceState.Active, "200 pending to active");
        Assert(DeviceService.Classify("active", DeviceLink.DeviceResult.Removed, "", out sched) == DeviceState.Removed && sched == DeviceService.Schedule.Stopped, "401 after active is removed, and stops");
        Assert(DeviceService.Classify("pending", DeviceLink.DeviceResult.Removed, "", out sched) == DeviceState.Expired && sched == DeviceService.Schedule.Stopped, "401 while pending is expired, and stops");
        Assert(DeviceService.Classify("active", DeviceLink.DeviceResult.UpdateNeeded, "", out sched) == DeviceState.UpdateNeeded && sched == DeviceService.Schedule.Update, "426 is update_needed, re-checked later");
        foreach (DeviceLink.DeviceResult r in new DeviceLink.DeviceResult[] { DeviceLink.DeviceResult.Offline, DeviceLink.DeviceResult.Refused }) {
            Assert(DeviceService.Classify("active", r, "", out sched) == DeviceState.Offline && sched == DeviceService.Schedule.Backoff, "offline or refused keeps trying: " + r);
        }

        // Backoff: one minute, doubling, capped at fifteen; it resets to one on the next failure after a success (0).
        long b = 0; var seen = new List<long>();
        for (int i = 0; i < 6; i++) { b = DeviceService.NextBackoff(b); seen.Add(b); }
        Assert(seen[0] == 60000 && seen[1] == 120000 && seen[2] == 240000 && seen[3] == 480000 && seen[4] == 900000 && seen[5] == 900000, "backoff 1,2,4,8,15,15 minutes");
        Assert(DeviceService.NextBackoff(0) == 60000, "a reset backoff starts at one minute");

        // Jitter bounds: five minutes plus up to thirty seconds, never less, never more.
        var rnd = new Random(1234); long min = long.MaxValue, max = long.MinValue;
        for (int i = 0; i < 2000; i++) { long d = DeviceService.NextCheckDelay(rnd); if (d < min) min = d; if (d > max) max = d; }
        Assert(min >= DeviceService.CheckEveryMs && max <= DeviceService.CheckEveryMs + DeviceService.JitterMaxMs && max > DeviceService.CheckEveryMs, "every check-in is 5 minutes plus 0 to 30 seconds");
        Assert(DeviceService.UpdateEveryMs == 6 * 3600 * 1000L, "an update is re-checked every six hours");

        // The 30-second refresh limit.
        Assert(DeviceService.RefreshDue(0, DeviceService.RefreshMinMs) && !DeviceService.RefreshDue(0, DeviceService.RefreshMinMs - 1), "a refresh is allowed at most once every 30 seconds");

        // History: the lines a 200 adds, and the cap at 50 newest.
        Assert(DeviceService.HistoryFor("pending", "ask", "limited", "active", "ask", "limited").Count == 1, "approval alone is one line");
        Assert(DeviceService.HistoryFor("active", "ask", "full", "active", "any", "full").Count == 1 && DeviceService.HistoryFor("active", "any", "full", "active", "ask", "full").Count == 1, "a team access change, either way, is a line");
        Assert(DeviceService.HistoryFor("active", "ask", "limited", "active", "ask", "limited").Count == 0, "no change, no line");
        var hist = new System.Collections.ArrayList();
        for (int i = 0; i < 60; i++) { hist.Add(Wire.Map("at", (long)i, "text", "line " + i)); DeviceService.TrimHistory(hist); }
        Assert(hist.Count == DeviceService.HistoryCap && Wire.Text((Dictionary<string, object>)hist[0], "text") == "line 10" && Wire.Text((Dictionary<string, object>)hist[hist.Count - 1], "text") == "line 59", "the last 50 lines are kept, newest last");

        // The status frame: confirm is shown only while pending.
        var pending = DeviceService.StatusFrame("PC", "ask", "limited", DeviceState.Pending, "482913", 111, new System.Collections.ArrayList());
        Assert(Wire.Text(pending, "state") == DeviceState.Pending && Wire.Text(pending, "confirm") == "482913" && Wire.Number(pending, "last_ok_at") == 111, "a pending frame carries the six digits");
        foreach (string st in new string[] { DeviceState.Active, DeviceState.Expired, DeviceState.Removed, DeviceState.Offline }) {
            Assert(!DeviceService.StatusFrame("PC", "any", "full", st, "482913", 0, new System.Collections.ArrayList()).ContainsKey("confirm"), "no confirm outside pending: " + st);
        }

        // The pipe vocabulary: exactly status, allow_any_time and refresh; any extra field, or any attempt to set
        // "ask", is refused (the connection closes).
        Func<string, Dictionary<string, object>> one = delegate(string json) { return Wire.Json().Deserialize<Dictionary<string, object>>(json); };
        Assert(Pipes.DeviceRequest(one("{\"type\":\"status\"}")) == "status" && Pipes.DeviceRequest(one("{\"type\":\"allow_any_time\"}")) == "allow_any_time" && Pipes.DeviceRequest(one("{\"type\":\"refresh\"}")) == "refresh", "the three frames");
        foreach (string json in new string[] { "{}", "{\"type\":\"end\"}", "{\"type\":\"run\"}", "{\"type\":\"ask\"}", "{\"type\":\"allow_any_time\",\"access\":\"ask\"}", "{\"type\":\"set_access\",\"access\":\"ask\"}", "{\"Type\":\"status\"}", "{\"type\":[\"status\"]}" })
            Assert(Pipes.DeviceRequest(one(json)) == null, "refused: " + json);

        // A live pipe on the device ACL (the test account stands in for SYSTEM, which the tests do not run as): a
        // modest client gets in and reads status; a client that asks for full access, which includes new instances,
        // is refused; an unknown frame closes the connection.
        var me = WindowsIdentity.GetCurrent().User;
        string pipeName = "SupportMcpDeviceTest-" + Guid.NewGuid().ToString("N").Substring(0, 8);
        string sddl = "D:P(A;;GA;;;" + me.Value + ")(A;;0x12008B;;;IU)";
        Func<Dictionary<string, object>, Dictionary<string, object>> handle = delegate(Dictionary<string, object> m) {
            string req = Pipes.DeviceRequest(m);
            if (req == null) return null;
            return DeviceService.StatusFrame("PC", "ask", "limited", DeviceState.Active, "", 7, new System.Collections.ArrayList());
        };
        new UiServer(pipeName, handle, delegate(uint ssn) { return true; }, sddl, 1024);
        // The greedy client is checked on one instance with the service's real ACL: this account holds full access on
        // the test pipe above, so a client running as it would always get in there.
        using (var real = Native.PipeServer(pipeName + "-acl", "D:P(A;;GA;;;SY)(A;;0x12008B;;;IU)", 1, true)) {
            using (var greedy = new System.IO.Pipes.NamedPipeClientStream(".", pipeName + "-acl", System.IO.Pipes.PipeDirection.InOut)) {
                try { greedy.Connect(2000); throw new Exception("the device pipe gave out full access"); } catch (UnauthorizedAccessException) { }
            }
        }
        using (var c = Pipes.Client(pipeName)) {
            c.Connect(2000);
            foreach (string t in new string[] { "status", "allow_any_time", "refresh" }) {
                Pipes.Write(c, Wire.Map("type", t));
                Assert(Wire.Text(Pipes.Read(c, DeviceService.PipeReadMax, UiServer.ReadMs), "state") == DeviceState.Active, "a valid frame is answered: " + t);
            }
        }
        using (var c = Pipes.Client(pipeName)) {
            c.Connect(2000); Pipes.Write(c, Wire.Map("type", "set_access", "access", "ask"));
            try { Pipes.Read(c, DeviceService.PipeReadMax, UiServer.ReadMs); throw new Exception("the service answered a frame it must refuse"); } catch (EndOfStreamException) { } catch (IOException) { }
        }
        Console.WriteLine("PASS the saved PC service: the state map, backoff and jitter, the refresh limit, the history cap, the status frame, and the pipe");
    }
    // The tray's pure parts: the state-to-text map, which actions show in which state and mode (the one-way rule), the
    // history lines, and the run-time icon (a handle created and freed).
    static void TrayTests() {
        Assert(TrayText.State(DeviceState.Active, "") == "Your support team can see this PC.", "active text");
        Assert(TrayText.State(DeviceState.Pending, "482913") == "Waiting for approval: read them 482 913.", "pending shows the six digits");
        Assert(TrayText.State(DeviceState.Pending, "") == "Waiting for approval.", "pending without digits");
        Assert(TrayText.State(DeviceState.Expired, "").Contains("wasn't approved") && TrayText.State(DeviceState.Removed, "").Contains("removed") && TrayText.State(DeviceState.UpdateNeeded, "").Contains("update") && TrayText.State(DeviceState.Offline, "").Contains("reach"), "each state has its own line");
        Assert(TrayText.Mode("any").Contains("any time") && TrayText.Mode("ask").Contains("asks you"), "the mode line");

        // The one-way rule: the any-time action shows only while active and asking first; never when any, never when
        // pending; uninstall always; no action ever sets "ask".
        foreach (string state in new string[] { DeviceState.Active, DeviceState.Pending, DeviceState.Expired, DeviceState.Removed, DeviceState.UpdateNeeded, DeviceState.Offline }) {
            foreach (string access in new string[] { "ask", "any" }) {
                var actions = TrayText.Actions(state, access);
                bool expectAllow = state == DeviceState.Active && access == "ask";
                Assert(actions.Contains("allow_any_time") == expectAllow, "allow_any_time only when active and asks first: " + state + "/" + access);
                Assert(actions.Contains("uninstall"), "uninstall always shows: " + state + "/" + access);
                foreach (string a in actions) Assert(a != "ask" && a != "allow_ask" && a.IndexOf("ask") < 0, "no action ever sets ask: " + a);
            }
        }
        Assert(!TrayText.Actions(DeviceState.Pending, "ask").Contains("allow_any_time"), "a pending PC never offers the any-time action");
        Assert(!TrayText.Actions(DeviceState.Active, "any").Contains("allow_any_time"), "an any-time PC never offers the action again");
        Assert(TrayText.ShowTeamOnly(DeviceState.Active, "any") && !TrayText.ShowTeamOnly(DeviceState.Active, "ask") && !TrayText.ShowTeamOnly(DeviceState.Removed, "any"), "only an any-time PC says only the team can change it");
        Assert(TrayText.ShowMode(DeviceState.Active) && TrayText.ShowMode(DeviceState.Pending) && !TrayText.ShowMode(DeviceState.Removed) && !TrayText.ShowMode(DeviceState.Expired), "a removed or unapproved PC shows no mode line");
        Assert(TrayText.AllowConfirm.Contains("undo this from this PC") && TrayText.AllowConfirm.Contains("Only your support team"), "the confirm says it can't be undone from this PC and only the team can turn it back");

        // Recent history, newest first, limited.
        var hist = new System.Collections.ArrayList();
        for (int i = 0; i < 6; i++) hist.Add(Wire.Map("at", (long)(1700000000000 + i), "text", "line " + i));
        var recent = TrayText.Recent(hist, 4);
        Assert(recent.Count == 4 && recent[0].Contains("line 5") && recent[3].Contains("line 2"), "the last four history lines, newest first");
        Assert(TrayText.Recent(null, 4).Count == 0, "no history is no lines");
        Assert(TrayText.Tip(new string('x', 200)).Length <= 63, "the tooltip fits 63 characters");

        // The icon is drawn at run time: Create makes a handle, DestroyIcon frees it. A different color per state.
        IntPtr h = TrayIcon.Create(16, TrayIcon.ColorFor(DeviceState.Active));
        Assert(h != IntPtr.Zero, "the tray icon is drawn to a handle");
        Assert(Native.DestroyIcon(h), "the icon handle is freed");
        Assert(!TrayIcon.ColorFor(DeviceState.Active).Equals(TrayIcon.ColorFor(DeviceState.Pending)) && !TrayIcon.ColorFor(DeviceState.Pending).Equals(TrayIcon.ColorFor(DeviceState.Removed)), "the icon colour follows the state");
        Console.WriteLine("PASS the tray: the state-to-text map, the one-way action rule, the history lines, and the run-time icon handle");
    }
    // Uninstall's pure parts: the removal plan (our names only, never the one-off shared record), the exit-code map,
    // the Temp-copy rule, and that a 401 from leave counts as done.
    static void UninstallTests(string dir) {
        var plan = DeviceUninstall.RemovalPlan();
        Assert(plan.Count == 4, "four artifacts");
        Assert(plan[0] == "service SupportMcpDevice", "the service by its exact name");
        Assert(plan[1].Contains("CurrentVersion\\Run\\SupportMcpTray"), "the HKLM Run tray value");
        Assert(plan[2].Contains("Uninstall\\SupportMcpDevice"), "the Apps uninstall entry");
        Assert(plan[3] == "folder " + DeviceSetup.Folder && plan[3].EndsWith("\\SupportMCP"), "the install folder");
        // Never the one-off sessions' shared record HKLM\SOFTWARE\SupportMCP, and nothing outside our names.
        foreach (string item in plan) {
            Assert(item.IndexOf("SOFTWARE\\SupportMCP") < 0, "never the shared record: " + item);
            Assert(item.Contains("SupportMcpDevice") || item.Contains("SupportMcpTray") || item.EndsWith("\\SupportMCP"), "only our names: " + item);
        }

        // The exit-code map.
        Assert(DeviceUninstall.Map(DeviceUninstall.Removed) == DeviceUninstall.Outcome.Removed, "0 is removed");
        Assert(DeviceUninstall.Map(DeviceUninstall.Unreachable) == DeviceUninstall.Outcome.RemovedUnreachable, "10 is removed but the relay was unreachable");
        Assert(DeviceUninstall.Map(-1223) == DeviceUninstall.Outcome.Declined, "a declined Windows prompt");
        Assert(DeviceUninstall.Map(DeviceUninstall.Fail) == DeviceUninstall.Outcome.Failed && DeviceUninstall.Map(999) == DeviceUninstall.Outcome.Failed, "anything else is a failure");

        // The Temp-copy rule: run from the install folder restages; run from anywhere else proceeds.
        Assert(DeviceUninstall.NeedsRestage(DeviceSetup.Exe), "the installed support.exe restages itself");
        Assert(!DeviceUninstall.NeedsRestage(Path.Combine(Path.GetTempPath(), "SupportMcpStage-x\\support.exe")), "a Temp copy proceeds");

        // leave: a 200 or a 401 both count as done (reached); only a network failure leaves the PC on the list.
        Assert(DeviceUninstall.LeaveReachedRelay(DeviceLink.DeviceResult.Ok), "200 counts as done");
        Assert(DeviceUninstall.LeaveReachedRelay(DeviceLink.DeviceResult.Removed), "401 counts as done");
        Assert(!DeviceUninstall.LeaveReachedRelay(DeviceLink.DeviceResult.Offline), "a network failure is not reached");
        Assert(DeviceUninstall.LeaveReachedRelay(DeviceLink.DeviceResult.Refused), "an unexpected refusal still removes locally");

        // The real removal on a temp folder whose exe is running (as a tray left behind would be): it is renamed aside,
        // so the original path is free for a fresh install. A running exe, not an open file handle: Windows renames a
        // folder whose exe is running, but not one holding an open handle of any share mode. This drives the shared
        // DeviceInstall.RemoveFolderAside, not a parallel copy.
        string root = Path.Combine(dir, "uninst-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        string f = Path.Combine(root, "SupportMCP"); Directory.CreateDirectory(f);
        string fexe = Path.Combine(f, "support.exe"); File.Copy(Path.Combine(Environment.SystemDirectory, "PING.EXE"), fexe); File.WriteAllText(Path.Combine(f, "device.json"), "{}");
        var running = Process.Start(new ProcessStartInfo(fexe, "-n 60 127.0.0.1") { UseShellExecute = false, CreateNoWindow = true });
        try {
            Thread.Sleep(500);
            DeviceUninstall.TestRemoveFolder(f);
            Assert(!Directory.Exists(f), "a folder whose exe is running is renamed aside, freeing the original path for a reinstall");
            Assert(Directory.GetDirectories(root, "SupportMCP.removed-*").Length >= 1, "the running exe's folder is kept under a unique removed name, not at the original path");
        } finally { try { running.Kill(); } catch (Exception) { } running.WaitForExit(5000); running.Dispose(); }
        foreach (string d in Directory.GetDirectories(root, "SupportMCP.removed-*")) try { Directory.Delete(d, true); } catch (Exception) { }
        // A plain (unlocked) folder is removed outright, with no leftover.
        Directory.CreateDirectory(f); File.WriteAllText(Path.Combine(f, "device.json"), "{}");
        DeviceUninstall.TestRemoveFolder(f);
        Assert(!Directory.Exists(f) && Directory.GetDirectories(root, "SupportMCP.removed-*").Length == 0, "an unlocked folder is removed with nothing left behind");

        // Two elevated installs or removes at once: the second is refused while the first holds the setup mutex.
        // Only SYSTEM and Administrators may open it, so a standard (or filtered) test account checks that refusal and
        // the held-mutex refusal on its own handle; an elevated one opens it twice, as two elevated installs would.
        string mn = "Local\\SupportMcpDeviceSetupTest-" + Guid.NewGuid().ToString("N");
        bool elevated = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
        using (var m1 = DeviceInstall.SetupMutex(mn)) {
            Assert(m1.WaitOne(0), "the first elevated install or remove takes the setup mutex");
            if (elevated) {
                using (var m2 = DeviceInstall.SetupMutex(mn)) Assert(!m2.WaitOne(0), "a second one is refused while the first holds it");
                m1.ReleaseMutex();
                using (var m3 = DeviceInstall.SetupMutex(mn)) { Assert(m3.WaitOne(0), "once released, the next one takes it"); m3Release(m3); }
            } else {
                try { DeviceInstall.SetupMutex(mn).Dispose(); throw new Exception("a standard user opened the setup mutex"); } catch (UnauthorizedAccessException) { }
                bool second = true; var other = new Thread(delegate() { second = m1.WaitOne(0); if (second) m1.ReleaseMutex(); }); other.Start(); other.Join();
                Assert(!second, "a second one is refused while the first holds it");
                m1.ReleaseMutex();
            }
        }
        Console.WriteLine("PASS uninstall: the removal plan and exit codes, the rename-aside removal, and the setup mutex refusal");
    }
    // Drives the real service against a fake relay with a real temp folder: a 200 with no device, a team access
    // change, allow_any_time only from "ask" (never sending "ask"), terminal states persisted and not re-checked after
    // a reload, and the uninstall event opened with Modify so a waiter sees the signal.
    static void DeviceServiceLiveTests(string dir) {
        string folder = Path.Combine(dir, "svc-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(folder);
        string exe = Path.Combine(folder, "support.exe");
        Func<string, string, string, string, string> dev = delegate(string st, string nm, string ac, string ct) {
            return Wire.Json().Serialize(Wire.Map("protocol", 1, "device", Wire.Map("id", "d", "workspace", "default", "status", st, "name", nm, "access", ac, "control", ct, "site_id", null)));
        };
        Action<string> writeJson = delegate(string json) { File.WriteAllText(Path.Combine(folder, "device.json"), json); };
        Func<DeviceService, int> histCount = delegate(DeviceService svc) { var h = svc.TestStatus()["history"] as System.Collections.ArrayList; return h == null ? 0 : h.Count; };

        using (var relay = new FakeDevice()) {
            writeJson(Wire.Json().Serialize(Wire.Map("origin", relay.Origin, "workspace", "default", "device_id", "d", "key", "smd1.default.id.secret", "status", "active", "name", "PC", "access", "ask", "control", "limited")));
            var svc = new DeviceService(exe);
            Assert(svc.TestInit(), "the service loads device.json");
            relay.Status = 200; relay.Body = dev("active", "Front desk", "ask", "limited");
            svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "state") == DeviceState.Active && Wire.Text(svc.TestStatus(), "name") == "Front desk", "a 200 updates name and state from the device");
            // A 200 with no "device" is treated as offline, not a crash that ends the loop.
            relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1));
            svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "state") == DeviceState.Offline, "a 200 with no device is offline, not a crash");
            // The team flips access to any: a history line is added.
            int before = histCount(svc);
            relay.Body = dev("active", "Front desk", "any", "limited");
            svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "access") == "any" && histCount(svc) == before + 1, "a team access change applies and is a history line");
            // Back to ask (the team turned it off), so allow_any_time becomes possible again.
            relay.Body = dev("active", "Front desk", "ask", "limited");
            svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "access") == "ask", "the team can set it back to ask");
            // allow_any_time: the pipe answers at once, and the update runs in the background and only ever sends "any".
            relay.Body = dev("active", "Front desk", "any", "limited"); relay.LastJson = ""; relay.LastPath = "";
            var reply = svc.TestHandle(Wire.Map("type", "allow_any_time"));
            Assert(reply != null && Wire.Text(reply, "state").Length > 0, "allow_any_time is answered at once");
            bool went = false;
            for (int i = 0; i < 100 && !went; i++) { if (Wire.Text(svc.TestStatus(), "access") == "any") went = true; else Thread.Sleep(50); }
            Assert(went, "allow_any_time turned on any in the background");
            Assert(relay.LastPath == "/device/update" && Wire.Text(relay.Sent(), "access") == "any", "it sent access any, never ask");
            // A second allow_any_time while already any sends nothing (and so can never send ask).
            relay.LastJson = ""; relay.LastPath = "";
            svc.TestHandle(Wire.Map("type", "allow_any_time")); Thread.Sleep(300);
            Assert(relay.LastJson == "", "allow_any_time does nothing once the mode is any");
        }

        // Terminal states are persisted and a reload serves them without a fresh check-in or a duplicate history line.
        foreach (string[] pair in new string[][] { new string[] { "active", DeviceState.Removed }, new string[] { "pending", DeviceState.Expired } }) {
            string folder2 = Path.Combine(dir, "term-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(folder2);
            string exe2 = Path.Combine(folder2, "support.exe");
            using (var relay = new FakeDevice()) {
                var start = Wire.Map("origin", relay.Origin, "workspace", "default", "device_id", "d", "key", "smd1.default.id.secret", "status", pair[0], "name", "PC", "access", "ask", "control", "limited");
                if (pair[0] == "pending") start["confirm"] = "482913";
                File.WriteAllText(Path.Combine(folder2, "device.json"), Wire.Json().Serialize(start));
                var svc = new DeviceService(exe2); Assert(svc.TestInit(), "init " + pair[1]);
                relay.Status = 401; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "device_unknown", "message", "x")));
                svc.TestCheckInOnce();
                Assert(Wire.Text(svc.TestStatus(), "state") == pair[1] && svc.TestTerminal, "401 gives " + pair[1] + " and is terminal");
                var stored = Wire.Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(folder2, "device.json")));
                Assert(Wire.Text(stored, "state") == pair[1], pair[1] + " is persisted to device.json");
                int lines = histCount(svc);
                // A reload serves the terminal state, stays terminal, and adds no duplicate history line at boot.
                var reloaded = new DeviceService(exe2); Assert(reloaded.TestInit(), "reload " + pair[1]);
                Assert(Wire.Text(reloaded.TestStatus(), "state") == pair[1] && reloaded.TestTerminal, "a reload serves " + pair[1] + " without a check-in");
                Assert(histCount(reloaded) == lines, "no duplicate " + pair[1] + " line at boot");
            }
        }

        // The uninstall event opened with Modify can be set, and a waiter sees it (the bug was Synchronize-only).
        string en = "Local\\SupportMcpTestUninstall-" + Guid.NewGuid().ToString("N");
        using (var created = DeviceService.TestCreateEvent(en)) {
            var got = new ManualResetEvent(false);
            var w = new Thread(delegate() { var we = DeviceService.TestOpenEvent(en, EventWaitHandleRights.Synchronize); if (we != null) using (we) if (we.WaitOne(5000)) got.Set(); });
            w.IsBackground = true; w.Start(); Thread.Sleep(200);
            var signaller = DeviceService.TestOpenEvent(en, EventWaitHandleRights.Synchronize | EventWaitHandleRights.Modify);
            Assert(signaller != null && signaller.Set(), "the event opens with Modify and sets");
            if (signaller != null) signaller.Dispose();
            Assert(got.WaitOne(5000), "a waiter sees the uninstall signal");
        }
        Console.WriteLine("PASS the live service: a 200 with no device, a team mode change, allow_any_time one-way and async, terminal persistence across a reload, and the uninstall event");
    }
    // The focus the confirm gives back: only to the window that had it, only while the support window still holds it.
    static void FocusReturnTests() {
        Func<IntPtr, bool> ours = delegate(IntPtr w) { return (int)w >= 100; }, here = delegate(IntPtr w) { return (int)w != 7; };
        IntPtr notepad = (IntPtr)10, corner = (IntPtr)100, other = (IntPtr)11;
        Assert(FocusReturn.Target(notepad, corner, ours, here) == notepad, "Keep connected gives the focus back to the window that had it");
        Assert(FocusReturn.Target(IntPtr.Zero, corner, ours, here) == IntPtr.Zero, "Nothing remembered, nothing to give back");
        Assert(FocusReturn.Target(notepad, other, ours, here) == IntPtr.Zero, "The customer clicked elsewhere meanwhile: the focus is not taken from that window");
        Assert(FocusReturn.Target(notepad, IntPtr.Zero, ours, here) == IntPtr.Zero, "No foreground window, no hand-back");
        Assert(FocusReturn.Target(corner, corner, ours, here) == IntPtr.Zero, "Never to one of the app's own windows");
        Assert(FocusReturn.Target((IntPtr)7, corner, ours, here) == IntPtr.Zero, "Not to a window that is gone or on another desktop");
        Console.WriteLine("PASS keep connected returns the focus to the remembered window and nowhere else");
    }
    static void ScreenPureTests(string dir) {
        FocusReturnTests();
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
        Throws(delegate { KeySpec.Parse("super+l"); }, "LockWorkStation"); Throws(delegate { KeySpec.Parse("L+win"); }, "rundll32.exe user32.dll,LockWorkStation"); Throws(delegate { KeySpec.Parse("ctrl+a super+L"); }, "Win+L");
        Assert(KeySpec.Parse("super+r")[0].Length == 2 && KeySpec.Parse("ctrl+l")[0].Length == 2, "Other Win and L combinations still work");
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
        // Each line ends with the verbs ui_act can use, from the patterns the element supports.
        Assert(UiLines.Line(12, "ControlType.Button", "OK", 640, 412, "invoke,focus") == "[12] Button \"OK\" (640,412) invoke,focus", "A line with verbs");
        Assert(UiLines.Line(12, "ControlType.Button", "OK", 640, 412, "") == "[12] Button \"OK\" (640,412)", "A line without verbs has no trailing space");
        Assert(UiLines.Verbs(true, false, false, false, false, false, true) == "invoke,focus", "A button: invoke and focus");
        Assert(UiLines.Verbs(false, true, false, false, false, false, true) == "set_value,focus", "A writable edit: set_value and focus");
        Assert(UiLines.Verbs(false, true, true, false, false, false, true) == "focus", "A read-only value is not set_value");
        Assert(UiLines.Verbs(false, false, false, true, false, false, false) == "toggle", "A check box that cannot take the focus: toggle only");
        Assert(UiLines.Verbs(false, false, false, false, true, false, true) == "expand,collapse,focus", "A tree node or combo box: expand, collapse and focus");
        Assert(UiLines.Verbs(true, true, false, true, true, true, true) == "invoke,set_value,toggle,expand,collapse,select,focus", "Every verb, in a fixed order");
        Assert(UiLines.Verbs(false, false, false, false, false, false, false) == "", "No pattern and no focus: no verbs");
        Assert(UiLines.Verbs(true, true, false, true, true, true, true, false) == "disabled", "A disabled element has no verbs and says so");
        Assert(UiLines.Line(5, "ControlType.Button", "Find next", 1, 2, UiLines.Verbs(true, false, false, false, false, false, true, false)) == "[5] Button \"Find next\" (1,2) disabled", "A disabled line");
        Assert(UiLines.Verbs(false, false, false, false, true, false, true, true, true) == "focus", "A leaf node has no expand or collapse");
        Assert(UiLines.Verbs(true, false, false, false, true, true, true, true, true) == "invoke,select,focus", "A leaf keeps its other verbs");
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
        Assert(InputIdle.CustomerAgoMs(10100, 10500, 10000, true) == 400 && InputIdle.CustomerAgoMs(10011, 10500, 10000, true) == 489, "A later input after the app's injection is the customer's");
        Assert(InputIdle.CustomerAgoMs(10010, 10500, 10000, true) == -1 && InputIdle.SlackMs < 20, "The slack stays below the 20 ms typing gap");
        Assert(InputIdle.CustomerAgoMs(16, 32, 0, true) == 16, "One clock tick after the app's last event is the customer's, as it is for a key pressed during the typing gap");
        Assert(InputIdle.RemainingMs(3000) == 0 && InputIdle.RemainingMs(2999) == 1 && InputIdle.RemainingMs(0) == 3000, "Three seconds from the customer's input");
        Assert(InputIdle.CustomerAgoMs(4294967000u, 200u, 0, false) == 496 && InputIdle.CustomerAgoMs(4294967000u, 200u, 4294966900u, true) == 496 && InputIdle.CustomerAgoMs(4294967200u, 200u, 4294967290u, true) == -1, "The tick counter wraps");
        long month = 30L * 86400000; uint monthAgo = unchecked((uint)(5000 + month));
        Assert(InputIdle.CustomerAgoMs(5000, monthAgo, 0, false) == month && InputIdle.RemainingMs(month) == 0, "A PC idle for 30 days is idle, not paused");
        Assert(InputIdle.CustomerAgoMs(10005, 10000, 0, false) == 0 && InputIdle.RemainingMs(0) == 3000, "An input a moment ahead of the clock reads as just now");
        Assert(!InputIdle.Stuck(InputIdle.StuckMs - 1, false) && InputIdle.Stuck(InputIdle.StuckMs, false) && !InputIdle.Stuck(InputIdle.StuckMs * 10, true), "A key down for 10 s with no input since is stuck; one with input since (a held key repeats) is not");
        Console.WriteLine("PASS pause cross-check against GetLastInputInfo, and the stuck-key rule");
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
        // Any other 4xx is a failure of the moment: the same result is sent again, not replaced.
        foreach (int code in new int[] { 408, 429 }) {
            using (var relay = new FakeRelay()) {
                relay.Lifetime = 300000; relay.Start();
                relay.RejectOk = code;
                string id = relay.Queue(Run("[Console]::Write('kept')", 20));
                for (int i = 0; i < 100 && !relay.ResultCounts.ContainsKey(id); i++) Thread.Sleep(50);
                Assert(relay.ResultCounts.ContainsKey(id), "The result was sent");
                relay.RejectOk = 0;
                var r = relay.WaitResult(id, 20);
                Assert(Wire.Flag(r, "ok") && Decode(r, "stdout_b64") == "kept" && relay.ResultCounts[id] >= 2, "A " + code + " takes the retry path and the real result gets through: " + Wire.Text(r, "error"));
            }
        }
        Console.WriteLine("PASS only 400 and 413 replace a result");
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
            // No Screen means no global input hooks and no F24 probe on the customer's PC.
            var screenField = typeof(Client).GetField("screen", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
            Assert(screenField != null && screenField.GetValue(withoutScreen.Agent) == null, "No Screen is created without screen consent");
            Assert(!withoutScreen.Agent.Paused, "Paused is false without a Screen");
            var lastPoll = withoutScreen.LastPoll;
            Assert(lastPoll != null && lastPoll.ContainsKey("desktop") && !lastPoll.ContainsKey("paused_until"), "The poll reports the desktop and no pause without a Screen");
        } finally { withoutScreen.Dispose(); }
        Console.WriteLine("PASS a reconnect without screen consent has commands and files only, and installs no input hooks");
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
    // The service side of a Client in full control, without a service: screen frames are answered here, and
    // as: "user" runs with a copy of this process's own token, the way the service runs with the console user's.
    sealed class FakeFull : IFullControl {
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr result);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        public bool SignedIn = true; public long WelcomedAt; public int Screens;
        public string UserName { get { return "tester"; } }
        public Dictionary<string, object> ScreenOp(Dictionary<string, object> frame, WaitHandle stop) { Screens++; return Wire.Map("ok", true, "desktop", "secure"); }
        public IntPtr UserToken(out string profile) {
            if (!SignedIn) throw new ArgumentException(TokenChoice.NobodySignedIn);
            IntPtr own, dup;
            if (!OpenProcessToken(GetCurrentProcess(), 0x02000000, out own)) throw new Exception("OpenProcessToken");
            try { if (!DuplicateTokenEx(own, 0x02000000, IntPtr.Zero, 2, 1, out dup)) throw new Exception("DuplicateTokenEx"); } finally { CloseHandle(own); }
            profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile); return dup;
        }
        public void Report(Dictionary<string, object> poll, long serverOffsetMs) { poll["desktop"] = "secure"; poll["input_blocked_until"] = Client.UnixNow() + 60000; }
        public void Welcomed(long expiresAtMs) { WelcomedAt = expiresAtMs; }
    }

    // One process gets at most 2 connections of the window pipe, idle ones are cut off after 5 s, and an end the service
    // never confirms finishes as Lost. A connection counts once its server thread takes it, and the threads of clients
    // that connect together can take them in any order. So each idle client first gets an answer, which proves it is
    // counted, and the test then waits for the server to cut them off (it counts a client out before it disconnects it).
    static void PerProcessLimit(string uiSddl) {
        string sid8b = Guid.NewGuid().ToString("N").Substring(0, 8), name = Backstop.Name(sid8b) + "-ui"; int endedB = 0;
        new UiServer(name, delegate { return Wire.Map("connected", true, "link", true, "ended", false); }, delegate { Interlocked.Increment(ref endedB); }, delegate(uint session) { return true; }, uiSddl);
        var idle = new List<System.IO.Pipes.NamedPipeClientStream>(); var asked = new List<Stopwatch>();
        try {
            for (int i = 0; i < UiServer.PerProcess; i++) {
                var c = Pipes.Client(name); idle.Add(c); c.Connect(2000);
                asked.Add(Stopwatch.StartNew()); Pipes.Write(c, Wire.Map("type", "status"));
                Assert(Wire.Flag(Pipes.Read(c, 4096, UiServer.ReadMs), "connected"), "An idle client is served first");
            }
            Assert(!ServiceLink.Running(sid8b), "A third connection of the same process is refused");
            for (int i = 0; i < idle.Count; i++) {
                try { Pipes.Read(idle[i], 4096, UiServer.ReadMs + 30000); throw new Exception("an idle client got a message"); } catch (IOException) { }
                // Windows may end a wait up to a clock tick early.
                Assert(asked[i].ElapsedMilliseconds >= UiServer.ReadMs - 100, "An idle client was cut off after " + asked[i].ElapsedMilliseconds + " ms");
            }
        } finally { foreach (var c in idle) c.Dispose(); }
        Assert(ServiceLink.Running(sid8b), "The idle clients were cut off and the process gets through again");
        // A service that never confirms the end: the window says it cannot reach it, not that the session ended.
        ServiceLink.EndMs = 2000;
        try {
            var stubborn = new ServiceLink(sid8b); int stubbornDone = 0; stubborn.Finished += delegate { stubbornDone++; }; stubborn.Start();
            Thread.Sleep(800); stubborn.Stop(); stubborn.Flush(10000);
            Assert(stubbornDone == 1 && stubborn.Lost && endedB >= 3, "The end goes out on the connection the window holds, again and again, and an unconfirmed end finishes as Lost: " + endedB);
        } finally { ServiceLink.EndMs = 30000; }
    }

    // A program the command started without waiting (like rundll32 user32.dll,LockWorkStation) gets up to a second to
    // finish: here a copy of this test program that waits 250 ms, started last. One that keeps running is killed
    // once that second is over, and the client's stop ends the second at once. Not a cscript script: on the
    // 20261103 Windows Server 2025 runner image cscript takes about two seconds to start, longer than that second.
    internal static void SettleTests(FakeRelay relay, string dir) {
        string tag = Guid.NewGuid().ToString("N").Substring(0, 8);
        string quick = Path.Combine(dir, "settle-quick-" + tag), slowPid = Path.Combine(dir, "settle-pid-" + tag), self = System.Reflection.Assembly.GetExecutingAssembly().Location;
        var r = relay.Call(Run("$s = Start-Process cmd.exe -WindowStyle Hidden -PassThru -ArgumentList '/c ping -n 30 127.0.0.1 >nul'; Set-Content -LiteralPath '" + slowPid.Replace("'", "''")
            + "' -Value ([string]$s.Id + ' ' + $s.StartTime.ToUniversalTime().Ticks); Start-Process -FilePath '" + self.Replace("'", "''") + "' -WindowStyle Hidden -ArgumentList '--settle \"" + quick.Replace("'", "''") + "\"'; [Console]::Write([DateTime]::UtcNow.Ticks)", 30));
        long settledMs = (DateTime.UtcNow.Ticks - long.Parse(Decode(r, "stdout_b64"))) / 10000;
        Assert(Wire.Flag(r, "ok") && File.Exists(quick), "A program the command did not wait for finishes");
        Assert(settledMs >= CommandJob.SettleMs - 100 && settledMs < 10000, "The result waits about a second for a program that keeps running: " + settledMs + " ms");
        // The pid with its start time, so a reused pid cannot pass for the slow child.
        string[] slow = File.ReadAllText(slowPid).Trim().Split(' '); bool slowGone = true;
        try { using (var p = Process.GetProcessById(int.Parse(slow[0]))) if (p.StartTime.ToUniversalTime().Ticks == long.Parse(slow[1])) slowGone = p.WaitForExit(1000); }
        catch (ArgumentException) { } catch (InvalidOperationException) { }
        Assert(slowGone, "The program that keeps running is killed after that second");
        // The stop comes 50 ms after PowerShell itself exited (the script writes its pid), so it falls in the settle second.
        string marker = Path.Combine(dir, "settle-marker-" + tag), script = Path.Combine(dir, "settle-stop-" + tag + ".ps1");
        File.WriteAllText(script, "Start-Process cmd.exe -WindowStyle Hidden -ArgumentList '/c ping -n 30 127.0.0.1 >nul'; Set-Content -LiteralPath '" + marker.Replace("'", "''") + "' -Value $PID");
        var stop = new ManualResetEvent(false); var clock = Stopwatch.StartNew(); long stoppedAt = long.MaxValue;
        var stopper = new Thread(delegate() {
            while (clock.ElapsedMilliseconds < 30000) { try { if (File.Exists(marker) && File.ReadAllText(marker).Trim().Length > 0) break; } catch (IOException) { } Thread.Sleep(5); }
            try { using (var ps = Process.GetProcessById(int.Parse(File.ReadAllText(marker).Trim()))) ps.WaitForExit(30000); } catch (ArgumentException) { }
            Thread.Sleep(50); stoppedAt = clock.ElapsedMilliseconds; stop.Set();
        });
        stopper.Start();
        try { using (var job = new CommandJob()) job.Run(script, dir, 30, stop); } catch (OperationCanceledException) { }
        long ended = clock.ElapsedMilliseconds; stopper.Join();
        Assert(stoppedAt <= ended && ended - stoppedAt < 300, "The client's stop ends the settle second at once: " + (ended - stoppedAt) + " ms after it");
    }

    // One elevation attempt with a stand-in for staging and UAC. The drop clock starts at the prompt, not at the staging; a
    // withdrawal during the staging shows no prompt; Discard removes the staged copy of a prompt nobody answered; and the
    // sweep at start removes only old staged folders directly in Temp, without following a junction inside.
    static void AttemptTests() {
        string a8 = Guid.NewGuid().ToString("N").Substring(0, 8), dir = Path.Combine(Path.GetTempPath(), "support-mcp-attempt-" + a8); Directory.CreateDirectory(dir);
        Func<string> slowStage = delegate { Thread.Sleep(1200); string d = Path.Combine(dir, Elevation.StagePrefix + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(d); File.WriteAllText(Path.Combine(d, "app.exe"), "x"); return Path.Combine(d, "app.exe"); };
        var no = new Elevation.Attempt(a8, slowStage, delegate(string copy, string nonce, Action answered) { Thread.Sleep(100); return -1223; }, 1000, delegate { });
        Assert(no.Done.WaitOne(10000) && no.Outcome == Elevation.Declined, "A No 100 ms into the prompt is a No, however long the staging took: " + no.Outcome);
        var drop = new Elevation.Attempt(a8, slowStage, delegate(string copy, string nonce, Action answered) { Thread.Sleep(1100); return -1223; }, 1000, delegate { });
        Assert(drop.Done.WaitOne(10000) && drop.Outcome == Elevation.NoAnswer, "A No after the drop time is Windows dropping the prompt: " + drop.Outcome);
        bool prompted = false; ManualResetEvent staging = new ManualResetEvent(false), go = new ManualResetEvent(false);
        var early = new Elevation.Attempt(a8, delegate { staging.Set(); go.WaitOne(); return slowStage(); }, delegate(string copy, string nonce, Action answered) { prompted = true; return 0; }, 300, delegate { });
        staging.WaitOne(); early.Withdraw(); go.Set();
        Assert(early.Done.WaitOne(10000) && !prompted && early.Outcome == Elevation.NoAnswer, "A withdrawal during the staging shows no prompt");
        string staged = null; ManualResetEvent asking = new ManualResetEvent(false), answer = new ManualResetEvent(false);
        var open = new Elevation.Attempt(a8, delegate { staged = slowStage(); return staged; }, delegate(string copy, string nonce, Action answered) { asking.Set(); answer.WaitOne(); return -1223; }, 300, delegate { });
        asking.WaitOne(); open.Discard();
        Assert(!Directory.Exists(Path.GetDirectoryName(staged)), "Discard removes the staged copy of a prompt nobody answered");
        answer.Set(); open.Done.WaitOne(10000);
        var yes = new Elevation.Attempt(a8, delegate { staged = slowStage(); return staged; }, delegate(string copy, string nonce, Action answered) { answered(); asking.Set(); answer.WaitOne(); return 0; }, 300, delegate { });
        asking.Reset(); answer.Reset(); asking.WaitOne(); yes.Discard();
        Assert(Directory.Exists(Path.GetDirectoryName(staged)), "Discard leaves the copy of an answered prompt alone");
        answer.Set(); Assert(yes.Done.WaitOne(10000) && yes.Outcome == Elevation.Installed && yes.EndedAt > 0, "The installer's exit code 0 is Installed");
        // The sweep: an hour-old staged folder (with a junction to a folder outside), a young one, another name, and a staged
        // name one level down.
        string temp = Path.Combine(dir, "sweep-" + a8), victim = Path.Combine(dir, "victim-" + a8);
        Directory.CreateDirectory(victim); File.WriteAllText(Path.Combine(victim, "keep.txt"), "x");
        string old = Path.Combine(temp, Elevation.StagePrefix + "old"), young = Path.Combine(temp, Elevation.StagePrefix + "young"), other = Path.Combine(temp, "other-old"), deep = Path.Combine(other, Elevation.StagePrefix + "deep");
        foreach (string d in new string[] { old, young, deep }) Directory.CreateDirectory(d);
        MkLink("/J", Path.Combine(old, "link"), victim);
        Assert(Directory.Exists(Path.Combine(old, "link")), "Test setup: the junction exists");
        foreach (string d in new string[] { old, other, deep }) Directory.SetCreationTimeUtc(d, DateTime.UtcNow.AddHours(-2));
        Elevation.SweepStaged(temp);
        Assert(!Directory.Exists(old) && Directory.Exists(young) && Directory.Exists(deep) && File.Exists(Path.Combine(victim, "keep.txt")),
            "The sweep removes only an old staged folder directly in Temp, and not what a junction inside points to: old " + Directory.Exists(old)
            + " young " + Directory.Exists(young) + " deep " + Directory.Exists(deep) + " victim " + File.Exists(Path.Combine(victim, "keep.txt")));
        DeleteTreeTests(dir);
        try { Directory.Delete(dir, true); } catch (Exception) { }
    }
    static void MkLink(string kind, string link, string target) {
        using (var mk = Process.Start(new ProcessStartInfo("cmd.exe", "/c mklink " + kind + " \"" + link + "\" \"" + target + "\"") { UseShellExecute = false, CreateNoWindow = true })) mk.WaitForExit();
    }
    // DeleteTree never follows a link: not the folder it is asked to delete, not a junction inside, not a folder swapped
    // for a junction after it was listed; and it never changes the attributes of a file another hard link shares.
    static void DeleteTreeTests(string dir) {
        string t8 = Guid.NewGuid().ToString("N").Substring(0, 8), root = Path.Combine(dir, "tree-" + t8);
        Func<string, string> victimOf = delegate(string name) { string v = Path.Combine(root, "victim-" + name); Directory.CreateDirectory(v); File.WriteAllText(Path.Combine(v, "keep.txt"), "x"); return v; };
        Directory.CreateDirectory(root);
        string top = victimOf("top"), topLink = Path.Combine(root, Elevation.StagePrefix + "link");
        MkLink("/J", topLink, top);
        Elevation.DeleteTree(topLink);
        Assert(!Directory.Exists(topLink) && File.Exists(Path.Combine(top, "keep.txt")), "A staged folder that is itself a junction: the link goes, its target stays");
        // A subfolder swapped for a junction between the listing of its parent and its own opening, and between its check
        // and its listing (the folder is then held, so the swap itself fails).
        string swapped = victimOf("swap"), race = Path.Combine(root, Elevation.StagePrefix + "race"), sub = Path.Combine(race, "sub");
        Action<string> swap = delegate(string name) {
            if (name != "sub" || Directory.Exists(sub + "-moved")) return;
            try { Directory.Move(sub, sub + "-moved"); MkLink("/J", sub, swapped); } catch (IOException) { }
        };
        Directory.CreateDirectory(sub); File.WriteAllText(Path.Combine(sub, "inner.txt"), "x");
        Native.BeforeOpen = swap;
        try { Elevation.DeleteTree(race); } catch (Exception) { } finally { Native.BeforeOpen = null; }
        Assert(!Directory.Exists(sub) && File.Exists(Path.Combine(swapped, "keep.txt")), "A folder swapped for a junction after the listing: the junction goes, its target stays: swapped "
            + Directory.Exists(sub + "-moved") + ", left " + Directory.Exists(sub) + ", target kept " + File.Exists(Path.Combine(swapped, "keep.txt")));
        if (Directory.Exists(sub + "-moved")) Directory.Delete(sub + "-moved", true);
        Directory.CreateDirectory(sub); File.WriteAllText(Path.Combine(sub, "inner.txt"), "x");
        Native.AfterCheck = swap;
        try { Elevation.DeleteTree(race); } catch (Exception) { } finally { Native.AfterCheck = null; }
        Assert(File.Exists(Path.Combine(swapped, "keep.txt")), "A folder swapped for a junction after its check is not followed");
        string shared = Path.Combine(victimOf("hard"), "shared.txt"), hard = Path.Combine(root, Elevation.StagePrefix + "hard");
        File.WriteAllText(shared, "x"); File.SetAttributes(shared, FileAttributes.ReadOnly | FileAttributes.Hidden);
        Directory.CreateDirectory(hard); MkLink("/H", Path.Combine(hard, "link.txt"), shared);
        var before = File.GetAttributes(shared);
        Assert((before & (FileAttributes.ReadOnly | FileAttributes.Hidden)) == (FileAttributes.ReadOnly | FileAttributes.Hidden), "Test setup: the shared file is read-only and hidden");
        try { Elevation.DeleteTree(hard); } catch (Exception) { }
        Assert(File.Exists(shared) && File.GetAttributes(shared) == before, "The attributes of a file another hard link shares stay as they were: " + File.GetAttributes(shared));
        string plain = Path.Combine(root, Elevation.StagePrefix + "plain"), ro = Path.Combine(plain, "deep", "ro.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(ro)); File.WriteAllText(ro, "x"); File.SetAttributes(ro, FileAttributes.ReadOnly);
        Elevation.DeleteTree(plain);
        Assert(!Directory.Exists(plain), "A plain staged folder goes, with a read-only file in a subfolder");
        File.SetAttributes(shared, FileAttributes.Normal);
        foreach (string f in Directory.GetFiles(root, "*", SearchOption.AllDirectories)) try { File.SetAttributes(f, FileAttributes.Normal); } catch (Exception) { }
    }

    static void QuestionTests() {
        // Before UAC the full-control question stays open after Allow, as the owner of the UAC prompt (Windows shows the prompt in
        // front only for an app in the foreground, and the click on Allow gives it that), says that Windows asks now, and cannot
        // be closed until the app finishes it. It is modeless: the corner window, with End session, stays enabled throughout.
        // Allow does nothing in its first 500 ms. Don't allow closes it at once. As the app's own confirm (no UAC), Allow closes it.
        {
            bool cornerOpen = false, cornerHeld = false, early = true, allowHeld = false, closeRefused = false, finished = false, denyClosed = false, confirmClosed = false;
            var t = new Thread(delegate() {
                Action pump = delegate { for (int i = 0; i < 10; i++) { Application.DoEvents(); System.Windows.Threading.Dispatcher.CurrentDispatcher.Invoke(System.Windows.Threading.DispatcherPriority.Background, new Action(delegate { })); Thread.Sleep(25); } };
                Func<System.Windows.DependencyObject, string, System.Windows.Controls.Button> button = delegate(System.Windows.DependencyObject w, string text) { return Find<System.Windows.Controls.Button>(w, delegate(System.Windows.Controls.Button b) { return text.Equals(b.Content); }); };
                var corner = new SupportWindow(Palette.Detect(), false, false, null); corner.Show(); pump();
                IntPtr cornerHandle = new System.Windows.Interop.WindowInteropHelper(corner).Handle;
                var d = ConsentDialog.Open(true);
                // Loaded comes asynchronously: wait for it, so only the time guards Allow, and press at once after it.
                for (int i = 0; i < 400 && !d.IsLoaded; i++) { System.Windows.Threading.Dispatcher.CurrentDispatcher.Invoke(System.Windows.Threading.DispatcherPriority.Background, new Action(delegate { })); Thread.Sleep(5); }
                var allow = button(d, "Allow");
                Press(allow); pump(); early = d.Allowed || d.Decided.WaitOne(0) || !allow.IsVisible;
                cornerOpen = IsWindowEnabled(cornerHandle);
                Thread.Sleep(ConsentDialog.ArmMs); pump();
                Press(allow); pump();
                allowHeld = d.IsVisible && d.Allowed && d.Decided.WaitOne(0) && !allow.IsVisible
                    && Find<System.Windows.Controls.TextBlock>(d, delegate(System.Windows.Controls.TextBlock b) { return b.Text == SupportAccess.Asking && b.IsVisible; }) != null;
                cornerHeld = IsWindowEnabled(cornerHandle);
                d.Close(); pump(); closeRefused = d.IsVisible;
                d.Finish(); pump(); finished = !d.IsVisible;
                var n = ConsentDialog.Open(true); pump();
                Press(button(n, "Don't allow")); pump();
                denyClosed = !n.IsVisible && !n.Allowed && n.Decided.WaitOne(0); n.Finish();
                var c = ConsentDialog.Open(false); pump(); Thread.Sleep(ConsentDialog.ArmMs);
                Press(button(c, "Allow")); pump();
                confirmClosed = !c.IsVisible && c.Allowed && c.Decided.WaitOne(0); c.Finish();
                corner.CloseQuietly(); pump();
            }); t.SetApartmentState(ApartmentState.STA); t.Start(); t.Join();
            Assert(cornerOpen && cornerHeld, "The corner window stays enabled while the question is open and while it waits for UAC");
            Assert(!early, "Allow does nothing right after the question appears");
            Assert(allowHeld, "Allow before UAC keeps the question open and says that Windows asks now");
            Assert(closeRefused && finished, "The question cannot be closed while UAC asks, only finished by the app");
            Assert(denyClosed, "Don't allow closes the question");
            Assert(confirmClosed, "Allow on the app's own confirm closes it");
            // The installer goes ahead only while the event of its own attempt (a random nonce) exists and is not set, and it
            // keeps the event: the app exiting afterwards withdraws nothing, setting it does. Nobody can make the event first.
            string w8 = Guid.NewGuid().ToString("N").Substring(0, 8), n1 = Elevation.Nonce(), n2 = Elevation.Nonce();
            Func<string, bool> wanted = delegate(string nonce) { using (var h = Elevation.Wanted(w8, nonce)) return h != null; };
            Assert(n1 != n2 && System.Text.RegularExpressions.Regex.IsMatch(n1, "^[0-9a-f]{32}$"), "Each attempt has a nonce of its own");
            Assert(!wanted(n1), "No attempt: the installer installs nothing");
            EventWaitHandle held;
            using (var want = Elevation.Want(w8, n1)) {
                Assert(wanted(n1) && !wanted(n2), "Only the attempt with that nonce is wanted");
                using (var other = Elevation.Want(w8, n2)) { other.Set(); Assert(wanted(n1) && !wanted(n2), "Withdrawing one attempt leaves another alone"); }
                held = Elevation.Wanted(w8, n1);
            }
            Assert(held != null && !held.WaitOne(0), "The installer's open event outlives the app and stays unset");
            held.Dispose();
            Assert(!wanted(n1), "With no one holding it, an attempt whose app is gone is not wanted");
            using (var want = Elevation.Want(w8, n1)) {
                held = Elevation.Wanted(w8, n1); want.Set();
                Assert(held.WaitOne(0) && !wanted(n1), "A withdrawal reaches an installer that already holds the event");
                held.Dispose();
            }
            using (var squat = new EventWaitHandle(false, EventResetMode.ManualReset, Elevation.WantName(w8, n2))) {
                bool refused = false; try { Elevation.Want(w8, n2).Dispose(); } catch (IOException) { refused = true; }
                Assert(refused, "An event someone made first is refused");
            }
        }
    }

    static void FullControlTests(string dir) {
        Assert(ConsentPath.Decide(true, 2, 1, 5) == Consent.Confirm && ConsentPath.Decide(true, 1, 0, -1) == Consent.Confirm, "An elevated app (or UAC off for an administrator) gets no UAC prompt, so it asks itself");
        Assert(ConsentPath.Decide(false, 3, 1, 0) == Consent.Confirm && ConsentPath.Decide(false, 3, -1, 0) == Consent.Confirm, "An administrator who elevates without a prompt is asked by the app");
        Assert(ConsentPath.Decide(false, 1, 0, -1) == Consent.Unavailable && ConsentPath.Decide(false, 1, 0, 0) == Consent.Unavailable, "UAC off and a standard user: full control is impossible");
        Assert(ConsentPath.Decide(false, 3, 1, 5) == Consent.Prompt && ConsentPath.Decide(false, 3, -1, -1) == Consent.Prompt && ConsentPath.Decide(false, 3, 1, 2) == Consent.Prompt, "An administrator with UAC gets the UAC prompt");
        Assert(ConsentPath.Decide(false, 1, 1, 0) == Consent.Prompt && ConsentPath.Decide(false, 1, -1, 5) == Consent.Prompt, "A standard user gets the UAC credential prompt (ConsentPromptBehaviorAdmin does not apply)");
        Assert(SupportAccess.LimitedHeading + " " + SupportAccess.LimitedText == "Continue with limited support? Support can see your screen and control your mouse and keyboard, but not Windows security prompts.", "Fallback text");
        Assert(SupportAccess.FullHeading + " " + SupportAccess.FullText == "Give support full control of this PC? Support can see your screen, control your mouse and keyboard, work through Windows security prompts and the sign-in screen, and keep working after a restart. Access ends when you click End session, or after 24 hours, and everything is removed.", "Full control text");
        Assert(SupportAccess.Asking == "Windows will ask for permission to give support full control.", "Notice before UAC");
        Console.WriteLine("PASS full-control consent: the UAC prompt, the app's own confirm, or unavailable, and the texts");

        // ACLs: the service folder is SYSTEM and Administrators only, with nothing inherited.
        var folder = FullAcl.Folder(); var rules = folder.GetAccessRules(true, true, typeof(SecurityIdentifier));
        Assert(folder.AreAccessRulesProtected && rules.Count == 2, "Folder ACL: protected, two rules, got " + rules.Count);
        foreach (FileSystemAccessRule r in rules)
            Assert((r.IdentityReference.Equals(FullAcl.SystemSid) || r.IdentityReference.Equals(FullAcl.AdminsSid)) && r.FileSystemRights == FileSystemRights.FullControl && r.AccessControlType == AccessControlType.Allow
                && r.InheritanceFlags == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit) && !r.IsInherited, "Folder rule " + r.IdentityReference);
        var window = FullAcl.Window(); var wrules = window.GetAccessRules(true, true, typeof(SecurityIdentifier)); int users = 0;
        Assert(window.AreAccessRulesProtected && wrules.Count == 3, "Window ACL: protected, three rules");
        foreach (FileSystemAccessRule r in wrules) {
            if (!r.IdentityReference.Equals(FullAcl.UsersSid)) { Assert(r.FileSystemRights == FileSystemRights.FullControl, "SYSTEM and Administrators own window.exe"); continue; }
            users++; Assert((r.FileSystemRights & FileSystemRights.ReadAndExecute) == FileSystemRights.ReadAndExecute && (r.FileSystemRights & (FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership)) == 0, "Users may only read and run window.exe");
        }
        Assert(users == 1, "Users read window.exe");
        var me = WindowsIdentity.GetCurrent().User; var script = FullAcl.Script(me);
        foreach (FileSystemAccessRule r in script.GetAccessRules(true, true, typeof(SecurityIdentifier))) if (r.IdentityReference.Equals(me)) Assert((r.FileSystemRights & (FileSystemRights.Write | FileSystemRights.Delete)) == 0, "The user may read a command script, not change it");
        // On disk, as icacls shows it. The folder is created in one step with its ACL, and never over an existing one.
        string aclDir = Path.Combine(dir, "acl-folder"); Native.CreateLocked(aclDir, FullAcl.Folder());
        try {
            try { Native.CreateLocked(aclDir, FullAcl.Folder()); throw new Exception("an existing folder was adopted"); } catch (System.ComponentModel.Win32Exception e) { Assert(e.NativeErrorCode == 183, "Exists: " + e.NativeErrorCode); }
            var icacls = Process.Start(new ProcessStartInfo("icacls.exe", "\"" + aclDir + "\"") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true });
            string shown = icacls.StandardOutput.ReadToEnd(); icacls.WaitForExit();
            string sys = FullAcl.SystemSid.Translate(typeof(NTAccount)).Value, admins = FullAcl.AdminsSid.Translate(typeof(NTAccount)).Value;
            int entries = 0; foreach (string line in shown.Split('\n')) if (line.Contains(":(")) entries++;
            Assert(shown.Contains(sys + ":(OI)(CI)(F)") && shown.Contains(admins + ":(OI)(CI)(F)") && entries == 2, "icacls shows SYSTEM and Administrators with full control, inherited by files and folders, and nobody else:\n" + shown);
        } finally {
            var mine = new DirectorySecurity(); mine.AddAccessRule(new FileSystemAccessRule(me, FileSystemRights.FullControl, AccessControlType.Allow));
            Directory.SetAccessControl(aclDir, mine); Directory.Delete(aclDir);
        }
        // The folder goes under %ProgramFiles%, read from HKLM, where Users may not create or delete anything.
        Assert(FullInstall.Folder("abcd1234").EndsWith(@"\SupportMCP-abcd1234") && Directory.Exists(FullInstall.Root) && !FullInstall.Root.ToUpperInvariant().Contains("PROGRAMDATA"), "The session folder: " + FullInstall.Folder("abcd1234"));
        foreach (FileSystemAccessRule r in Directory.GetAccessControl(FullInstall.Root).GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (r.IdentityReference.Equals(FullAcl.UsersSid) && r.AccessControlType == AccessControlType.Allow && r.PropagationFlags != PropagationFlags.InheritOnly)
                Assert((r.FileSystemRights & (FileSystemRights.CreateDirectories | FileSystemRights.CreateFiles | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership)) == 0, "Users cannot create or delete in " + FullInstall.Root + ": " + r.FileSystemRights);
        Console.WriteLine("PASS full-control ACLs: the folder (checked with icacls), window.exe and command scripts");

        // The deadline: saved and loaded with the full session id, expiry, the 24-hour cap, and the first welcome.
        long now = Client.UnixNow(); string fullSid = new string('c', 64);
        var st = new FullState { Sid = fullSid, Task = Backstop.NewTask("cccccccc"), Deadline = now + 7200000, AppPid = 4242 }; st.Save(dir);
        var back = FullState.Load(dir);
        Assert(back != null && back.Deadline == st.Deadline && !back.Welcomed && back.Sid == fullSid && back.AppPid == 4242 && back.Task == st.Task && back.Task.StartsWith("SupportMcp-cccccccc-") && back.Task.Length == 28, "State round trip, with this install's own task name");
        Assert(Backstop.NewTask("cccccccc") != Backstop.NewTask("cccccccc"), "Every install gets a task name of its own");
        back.Welcomed = true; back.Save(dir); back = FullState.Load(dir);
        Assert(back.Welcomed && !File.Exists(FullState.PathIn(dir) + ".new"), "State is replaced in place");
        File.WriteAllText(FullState.PathIn(dir), "{\"deadline\":" + (now + 5000) + "}"); Assert(FullState.Load(dir) == null, "A state without the full session id is treated as over");
        File.WriteAllText(FullState.PathIn(dir), "{not json"); Assert(FullState.Load(dir) == null, "A damaged state is treated as over");
        File.WriteAllText(FullState.PathIn(dir), "{\"deadline\":\"soon\"}"); Assert(FullState.Load(dir) == null, "A state of the wrong type is treated as over");
        File.Delete(FullState.PathIn(dir)); Assert(FullState.Load(dir) == null, "A missing state is treated as over");
        Assert(!FullState.Expired(now + 1, now) && FullState.Expired(now, now) && FullState.Expired(now - 1, now), "Expired at the deadline");
        Assert(FullState.Clamp(now + 3 * FullState.DayMs, now) == now + FullState.DayMs && FullState.Clamp(now + 5000, now) == now + 5000, "Never more than 24 hours");
        Assert(FullState.OnWelcome(now + 7200000, false, now + 86000000, now) == now + 86000000, "The first welcome moves connect_by to the session's expiry");
        Assert(FullState.OnWelcome(now + 50000000, true, now + 86000000, now) == now + 50000000 && FullState.OnWelcome(now + 50000000, true, now + 1000, now) == now + 1000, "A later welcome never extends the deadline, only brings it closer");
        Assert(FullState.OnWelcome(now + 7200000, false, now + 5 * FullState.DayMs, now) == now + FullState.DayMs, "A relay expiry beyond 24 hours is capped");
        Assert(SasShare.Needed(-1) && SasShare.Needed(0) && SasShare.Needed(2) && !SasShare.Needed(1) && !SasShare.Needed(3) && SasShare.Wanted(-1) == 1 && SasShare.Wanted(0) == 1 && SasShare.Wanted(2) == 3, "SoftwareSASGeneration changes only when services may not send SAS; ease of access apps keep their right");
        Console.WriteLine("PASS full-control state: persistence, expiry, the 24-hour cap and the first welcome");

        // SoftwareSASGeneration shared by sessions, in a test copy of the two keys under HKCU. The C# release and the
        // backstop's PowerShell release must behave the same.
        string testKey = @"Software\SupportMcpTest-" + Guid.NewGuid().ToString("N");
        SasShare.MutexName = @"Local\SupportMcpTest-Sas-" + Guid.NewGuid().ToString("N"); // a Global one needs administrator rights
        Func<Microsoft.Win32.RegistryKey> root = delegate { return Microsoft.Win32.Registry.CurrentUser.CreateSubKey(testKey); };
        Func<object> sas = delegate { using (var r = root()) using (var k = r.OpenSubKey(SasShare.PolicyKey)) return k == null ? null : k.GetValue(SasShare.Value); };
        Action<object> setSas = delegate(object v) { using (var r = root()) using (var k = r.CreateSubKey(SasShare.PolicyKey)) { if (v == null) k.DeleteValue(SasShare.Value, false); else k.SetValue(SasShare.Value, v, Microsoft.Win32.RegistryValueKind.DWord); } };
        Func<bool> clean = delegate { using (var r = root()) return r.OpenSubKey(SasShare.RootKey) == null; };
        Action<string> psRelease = delegate(string holder) {
            var ps = Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" + SasShare.ReleaseScript(@"HKCU:\" + testKey, holder) + "\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true });
            string err = ps.StandardError.ReadToEnd(); ps.WaitForExit(); Assert(ps.ExitCode == 0 && err.Trim() == "", "The backstop's PowerShell runs cleanly: " + err);
        };
        try {
            foreach (bool viaPowerShell in new bool[] { false, true }) {
                Action<string> release = delegate(string holder) { if (viaPowerShell) psRelease(holder); else using (var r = root()) SasShare.Release(r, holder); };
                string how = viaPowerShell ? " (PowerShell)" : " (C#)";
                setSas(null);
                using (var r = root()) SasShare.Acquire(r, "SupportMcp-aaaaaaaa");
                Assert((int)sas() == 1, "Absent becomes 1" + how);
                using (var r = root()) SasShare.Acquire(r, "SupportMcp-bbbbbbbb");
                release("SupportMcp-aaaaaaaa");
                Assert((int)sas() == 1, "The first session to leave keeps the value while another still needs it" + how);
                release("SupportMcp-bbbbbbbb");
                Assert(sas() == null && clean(), "The last one deletes the value it added, and the records" + how);
                setSas(2);
                using (var r = root()) SasShare.Acquire(r, "SupportMcp-aaaaaaaa");
                Assert((int)sas() == 3, "2 becomes 3" + how);
                release("SupportMcp-aaaaaaaa");
                Assert((int)sas() == 2 && clean(), "2 comes back" + how);
                setSas(0);
                using (var r = root()) SasShare.Acquire(r, "SupportMcp-aaaaaaaa");
                setSas(3); // an administrator changes it while the session runs
                release("SupportMcp-aaaaaaaa");
                Assert((int)sas() == 3 && clean(), "A later change by an administrator stays" + how);
                setSas(1);
                using (var r = root()) SasShare.Acquire(r, "SupportMcp-aaaaaaaa");
                release("SupportMcp-aaaaaaaa");
                Assert((int)sas() == 1 && clean(), "A value that already allowed services is left alone" + how);
            }
            // The C# and the PowerShell release both wait for the mutex another process holds.
            setSas(null);
            using (var r = root()) SasShare.Acquire(r, "SupportMcp-aaaaaaaa");
            var other = new Mutex(false, SasShare.MutexName); var taken = new ManualResetEvent(false); var letGo = new ManualResetEvent(false);
            var owner = new Thread(delegate() { other.WaitOne(); taken.Set(); letGo.WaitOne(); other.ReleaseMutex(); }); owner.Start(); taken.WaitOne();
            var waited = Stopwatch.StartNew(); var releaser = new Thread(delegate() { psRelease("SupportMcp-aaaaaaaa"); }); releaser.Start();
            Thread.Sleep(2500); Assert((int)sas() == 1, "The PowerShell release waits while another process holds the mutex");
            letGo.Set(); releaser.Join(30000); owner.Join();
            Assert(sas() == null && clean() && waited.ElapsedMilliseconds >= 2500, "Then it runs");
            // Without the mutex nothing touches the record: Acquire and Release report it, PowerShell exits with 1.
            int wait = SasShare.WaitMs; SasShare.WaitMs = 1000;
            try {
                setSas(null);
                using (var r = root()) Assert(SasShare.Acquire(r, "SupportMcp-aaaaaaaa"), "Acquire reports that it ran");
                taken.Reset(); letGo.Reset();
                owner = new Thread(delegate() { other.WaitOne(); taken.Set(); letGo.WaitOne(); other.ReleaseMutex(); }); owner.Start(); taken.WaitOne();
                using (var r = root()) Assert(!SasShare.Acquire(r, "SupportMcp-bbbbbbbb"), "Acquire without the mutex reports the skip");
                using (var r = root()) using (var k = r.OpenSubKey(SasShare.HoldersKey)) Assert(k.GetValue("SupportMcp-bbbbbbbb") == null, "and adds no holder");
                using (var r = root()) Assert(!SasShare.Release(r, "SupportMcp-aaaaaaaa"), "Release without the mutex reports the skip");
                Assert((int)sas() == 1, "and puts nothing back");
                var ps = Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" + SasShare.ReleaseScript(@"HKCU:\" + testKey, "SupportMcp-aaaaaaaa") + "\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true });
                string err = ps.StandardError.ReadToEnd(); ps.WaitForExit();
                Assert(ps.ExitCode == 1 && err.Trim() == "", "The PowerShell release without the mutex exits with 1: " + ps.ExitCode + " " + err);
                using (var r = root()) using (var k = r.OpenSubKey(SasShare.HoldersKey)) Assert((int)sas() == 1 && k.GetValue("SupportMcp-aaaaaaaa") != null && (string)k.GetValue("original") == "absent", "and keeps the entry and the original value for a later release");
                letGo.Set(); owner.Join();
                using (var r = root()) Assert(SasShare.Release(r, "SupportMcp-aaaaaaaa"), "A later release runs");
                Assert(sas() == null && clean(), "and puts the original back");
            } finally { SasShare.WaitMs = wait; letGo.Set(); }
            // send_sas checks the value first, since Windows drops SendSAS without an error when it refuses it.
            foreach (object v in new object[] { null, 0, 2 }) { setSas(v); using (var r = root()) Assert(!SasShare.Allowed(r), "Services may not send SAS with " + (v ?? "no value")); }
            foreach (object v in new object[] { 1, 3 }) { setSas(v); using (var r = root()) Assert(SasShare.Allowed(r), "Services may send SAS with " + v); }
        } finally { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(testKey, false); }
        Console.WriteLine("PASS SoftwareSASGeneration: shared by sessions, put back by the last one, an administrator's change kept, the same in PowerShell, never changed without the mutex");

        // The backstop never runs agent.exe, releases the registry share, and deletes itself last.
        string f = @"C:\Program Files\SupportMCP-abcd1234";
        var actions = Backstop.Actions("abcd1234", f, "SupportMcp-abcd1234-0123abcd"); string sys32 = Backstop.System32("");
        Assert(actions.Length == 3 && actions[0][0].EndsWith(@"\System32\cmd.exe") && actions[1][0].EndsWith(@"\System32\WindowsPowerShell\v1.0\powershell.exe") && actions[2][0].EndsWith(@"\System32\cmd.exe"), "cmd, PowerShell, cmd from the 64-bit System32");
        Assert(actions[0][1] == "/c " + sys32 + "sc.exe stop \"SupportMcp-abcd1234\" & " + sys32 + "PING.EXE -n 6 127.0.0.1 >nul & " + sys32 + "taskkill.exe /f /fi \"SERVICES eq SupportMcp-abcd1234\" & " + sys32 + "sc.exe delete \"SupportMcp-abcd1234\"", "First the service, every tool by its full path: " + actions[0][1]);
        Assert(sys32.IndexOf(' ') < 0, "System32 has no space, so the cmd lines need no quotes around tools");
        Assert(actions[1][1].Contains(SasShare.ReleaseScript("HKLM:", "SupportMcp-abcd1234")) && !actions[1][1].Substring(actions[1][1].IndexOf('"') + 1).TrimEnd('"').Contains("\""), "Then the registry share, with no double quote inside the script");
        Assert(actions[2][1].StartsWith("/c (for /l %i in (1,1,20) do @(if exist \"" + f + "\"") && actions[2][1].EndsWith(" & (" + sys32 + "reg.exe query \"HKLM\\SOFTWARE\\SupportMCP\\SoftwareSASGeneration\" /v \"SupportMcp-abcd1234\" /reg:64 >nul 2>&1 || " + sys32 + "schtasks.exe /delete /tn \"SupportMcp-abcd1234-0123abcd\" /f)") && actions[2][1].Contains(sys32 + "PING.EXE -n 3"), "Then the folder, and the task itself last, once its registry share is released: " + actions[2][1]);
        foreach (string[] a in actions) {
            Assert(!a[1].Contains("agent.exe") && !a[1].Contains("window.exe"), "The backstop never runs the app");
            Assert(a[1].IndexOf('%') < 0 || (a[1].IndexOf('%') == a[1].IndexOf("%i") && a[1].IndexOf("%i") == a[1].LastIndexOf("%i")), "At most one %i and no other %, so Task Scheduler expands nothing");
        }
        string xml = Backstop.Xml(actions, (long)(new DateTime(2026, 11, 3, 12, 0, 0, DateTimeKind.Utc) - new DateTime(1970, 1, 1)).TotalMilliseconds + 500);
        Assert(xml.Contains("<TimeTrigger><Repetition><Interval>PT1H</Interval></Repetition><StartBoundary>2026-11-03T12:00:01Z</StartBoundary>") && xml.Contains("<UserId>S-1-5-18</UserId>") && xml.Contains("<StartWhenAvailable>true</StartWhenAvailable>") && xml.Contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"), "Task at the deadline in UTC, rounded up, as SYSTEM, run late if the PC was off, and again every hour until it deletes itself");
        int at0 = xml.IndexOf("<Arguments>" + System.Security.SecurityElement.Escape(actions[0][1])), at1 = xml.IndexOf(System.Security.SecurityElement.Escape(actions[1][1])), at2 = xml.IndexOf(System.Security.SecurityElement.Escape(actions[2][1]));
        Assert(at0 > 0 && at1 > at0 && at2 > at1 && !xml.Contains(" & ") && xml.Contains("&amp;") && xml.Contains("&quot;"), "Three actions in order, escaped for XML");
        Console.WriteLine("PASS backstop task: the command line, its order and the task XML");

        // run in full control: the token choice and the as: field.
        Assert(TokenChoice.Pick(true, false, 0) == RunAs.System && TokenChoice.Pick(true, true, 3) == RunAs.System, "as: system runs as SYSTEM, signed in or not");
        Assert(TokenChoice.Pick(false, false, 0) == RunAs.Nobody && TokenChoice.NobodySignedIn == "nobody is signed in; use as: \"system\"", "as: user with nobody signed in is an error");
        Assert(TokenChoice.Pick(false, true, 3) == RunAs.ElevatedUser && TokenChoice.Pick(false, true, 1) == RunAs.User && TokenChoice.Pick(false, true, 2) == RunAs.User, "An administrator's filtered token is swapped for its elevated linked token; other tokens run as they are");
        var full = new FakeFull();
        using (var relay = new FakeRelay()) {
            relay.Agent.Full = full; relay.Lifetime = 300000; relay.Start();
            var caps = (System.Collections.ArrayList)relay.Hello["caps"];
            Assert(Wire.Text(relay.Hello, "control") == "full" && caps.Contains("full") && caps.Contains("screen") && Wire.Text(relay.Hello, "user") == "tester" && Wire.Flag(relay.Hello, "elevated"), "The service's hello says control full");
            for (int i = 0; i < 100 && full.WelcomedAt == 0; i++) Thread.Sleep(20);
            Assert(Math.Abs(full.WelcomedAt - (Client.UnixNow() + 300000)) < 5000, "The welcome's expiry reaches the service");
            for (int i = 0; i < 100 && (relay.LastPoll == null || Wire.Text(relay.LastPoll, "desktop") != "secure"); i++) Thread.Sleep(50);
            Assert(Wire.Text(relay.LastPoll, "desktop") == "secure" && Wire.Number(relay.LastPoll, "input_blocked_until") > 0, "Polls carry the service's report");
            var shot = relay.Call(Act("screenshot")); Assert(Wire.Flag(shot, "ok") && Wire.Text(shot, "desktop") == "secure" && full.Screens == 1, "Screen frames go to the service");
            var sys = Run("[Console]::Write([Security.Principal.WindowsIdentity]::GetCurrent().Name)", 30); sys["as"] = "system";
            var r = relay.Call(sys); Assert(Wire.Flag(r, "ok") && Decode(r, "stdout_b64") == WindowsIdentity.GetCurrent().Name, "as: system runs with the service's own token: " + Wire.Text(r, "error"));
            var user = Run("[Console]::Write([Security.Principal.WindowsIdentity]::GetCurrent().Name + '|' + (Get-Location).Path)", 30); user["as"] = "user";
            r = relay.Call(user); Assert(Wire.Flag(r, "ok") && Decode(r, "stdout_b64") == WindowsIdentity.GetCurrent().Name + "|" + Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "as: user runs with the given token in its profile folder: " + Wire.Text(r, "error") + Decode(r, "stderr_b64"));
            full.SignedIn = false;
            r = relay.Call(user); Assert(!Wire.Flag(r, "ok") && Wire.Text(r, "error") == TokenChoice.NobodySignedIn, "as: user with nobody signed in: " + Wire.Text(r, "error"));
            var bad = Run("1", 10); bad["as"] = "root"; r = relay.Call(bad); Assert(Wire.Text(r, "error") == "as must be user or system", "Only user and system");
        }
        Console.WriteLine("PASS full-control client: hello, welcome, poll report, screen frames, and run as system, as user and with nobody signed in");

        // Block timer: the time limit, the operator's off, and Ctrl+Alt+Del.
        var block = new BlockTimer(); block.Arm(1000, 99);
        Assert(block.RemainingMs(1000) == 600000 && block.On(600999) && !block.On(601000), "At most 10 minutes");
        block.Arm(1000, 0); Assert(block.RemainingMs(1000) == 60000, "At least 1 minute");
        block.Arm(1000, 2); Assert(block.Check(5000, true, true) && block.Check(120999, true, true) && !block.Check(121000, true, true) && !block.Escaped && !block.On(121000), "It lifts by itself when the time is up");
        block.Arm(1000, 2); Assert(!block.Check(5000, false, true) && block.Escaped && !block.Check(6000, true, true) && !block.On(6000), "A switch to the secure desktop is Ctrl+Alt+Del: off, and it stays off");
        block.Arm(1000, 2); Assert(!block.Escaped && !block.Check(5000, true, false) && block.Escaped, "A block Windows already lifted counts as Ctrl+Alt+Del; only on again re-arms it");
        block.Arm(1000, 2); block.Off(); Assert(!block.Check(5000, true, true) && !block.Escaped, "The operator's off");
        Console.WriteLine("PASS block_input timer: the 10-minute cap, renewal, Ctrl+Alt+Del and off");

        // Pipe messages are length-prefixed JSON objects within a size limit; a window may only ask for status or end.
        Func<byte[], Dictionary<string, object>> read = delegate(byte[] raw) { return Pipes.Read(new MemoryStream(raw), 1024); };
        Func<string, byte[]> frame = delegate(string json) { byte[] b = Encoding.UTF8.GetBytes(json), all = new byte[b.Length + 4]; BitConverter.GetBytes(b.Length).CopyTo(all, 0); b.CopyTo(all, 4); return all; };
        var ms = new MemoryStream(); Pipes.Write(ms, Wire.Map("type", "status")); ms.Position = 0;
        Assert(Wire.Text(Pipes.Read(ms, 1024), "type") == "status", "A message round trip");
        foreach (byte[] raw in new byte[][] { frame("[1,2]"), frame("null"), frame("{\"type\":"), frame("\"text\""), new byte[] { 2, 0, 0, 0, 0x7B }, new byte[] { 0xFF, 0xFF, 0xFF, 0x7F }, new byte[] { 1, 0, 0, 0, 0x7B }, new byte[] { 0, 4, 0, 0 }, new byte[] { 1, 0 } }) {
            try { read(raw); throw new Exception("accepted a bad message of " + raw.Length + " bytes"); } catch (InvalidDataException) { } catch (EndOfStreamException) { }
        }
        Assert(Pipes.UiRequest(read(frame("{\"type\":\"status\"}"))) == "status" && Pipes.UiRequest(read(frame("{\"type\":\"end\"}"))) == "end", "status and end");
        foreach (string json in new string[] { "{\"type\":\"run\"}", "{\"type\":\"status\",\"x\":1}", "{\"type\":5}", "{}", "{\"Type\":\"end\"}", "{\"type\":[\"end\"]}" })
            Assert(Pipes.UiRequest(read(frame(json))) == null, "A window may not ask " + json);
        // The real pipe: a window reads status and ends the session; garbage closes the connection; nobody can take the name first.
        string sid8 = Guid.NewGuid().ToString("N").Substring(0, 8); int ended = 0;
        // Only the pipe's owner may add instances, and the tests do not run as SYSTEM: this account stands in for it.
        string uiSddl = "D:P(A;;GA;;;" + me.Value + ")(A;;0x12008B;;;IU)"; Func<uint, bool> anySession = delegate(uint session) { return true; };
        var ui = new UiServer(Backstop.Name(sid8) + "-ui", delegate { return Wire.Map("connected", true, "link", true, "busy", 1, "paused", false, "blocked", true, "expires_at", Client.UnixNow() + 3600000, "ended", ended > 0); }, delegate { Interlocked.Increment(ref ended); }, anySession, uiSddl);
        try { Native.PipeServer(Backstop.Name(sid8) + "-ui", "D:P(A;;GA;;;SY)", 4, true); throw new Exception("a second first instance was allowed"); } catch (System.ComponentModel.Win32Exception) { }
        Assert(ServiceLink.Running(sid8) && !ServiceLink.Running(Guid.NewGuid().ToString("N").Substring(0, 8)), "Running finds the service of this session only");
        // A client that asks for full access (which includes making a new pipe instance) is refused.
        // (The service's real ACL, on one instance this test account did not need rights to create.)
        using (var real = Native.PipeServer("SupportMcpTest-acl-" + sid8, "D:P(A;;GA;;;SY)(A;;0x12008B;;;IU)", 1, true)) {
            using (var greedy = new System.IO.Pipes.NamedPipeClientStream(".", "SupportMcpTest-acl-" + sid8, System.IO.Pipes.PipeDirection.InOut)) {
                try { greedy.Connect(2000); throw new Exception("the window pipe gave out write access that includes new instances"); } catch (UnauthorizedAccessException) { }
            }
            var accepting = new Thread(delegate() { try { real.WaitForConnection(); } catch (Exception) { } }); accepting.Start();
            using (var modest = Pipes.Client("SupportMcpTest-acl-" + sid8)) { modest.Connect(2000); Assert(modest.IsConnected, "A window's client gets in"); }
            accepting.Join(3000);
        }
        using (var raw = Pipes.Client(Backstop.Name(sid8) + "-ui")) {
            raw.Connect(2000); Pipes.Write(raw, Wire.Map("type", "run", "command", "calc"));
            try { Pipes.Read(raw, 4096); throw new Exception("the service answered a request a window may not make"); } catch (IOException) { }
            Assert(ended == 0, "A bad request does nothing");
        }
        var link = new ServiceLink(sid8); int connected = 0, finished = 0, busyNow = -1;
        link.Connected += delegate { connected++; }; link.Finished += delegate { finished++; }; link.BusyChanged += delegate(int n) { busyNow = n; };
        link.Start();
        for (int i = 0; i < 100 && (connected == 0 || busyNow != 1); i++) Thread.Sleep(50);
        Assert(connected == 1 && busyNow == 1 && link.Blocked && !link.Paused && link.SurvivesSignOut && Math.Abs((link.ExpiresLocal.ToUniversalTime() - DateTime.UtcNow).TotalMinutes - 60) < 1, "The window reads status");
        link.Stop(); link.Flush(5000);
        for (int i = 0; i < 100 && finished == 0; i++) Thread.Sleep(50);
        Assert(ended >= 1 && finished == 1 && !link.Lost && !ServiceLink.Running(sid8), "End session reaches the service, and the window sees the session end");
        PerProcessLimit(uiSddl);
        // Only the active console session is served: a process of another session (a switched user, Remote Desktop) is refused.
        string sid8c = Guid.NewGuid().ToString("N").Substring(0, 8);
        new UiServer(Backstop.Name(sid8c) + "-ui", delegate { return Wire.Map("connected", true, "ended", false); }, delegate { }, delegate(uint session) { return false; }, uiSddl);
        Assert(!ServiceLink.Running(sid8c), "A client from another session is refused");
        // Pipe clients let the server identify them, never act as them.
        string me8 = Guid.NewGuid().ToString("N").Substring(0, 8); string secret = Path.Combine(dir, "only-me.txt"); File.WriteAllText(secret, "x"); Exception asClient = null;
        using (var server = Native.PipeServer("SupportMcpTest-" + me8, "D:P(A;;GA;;;" + me.Value + ")", 1, true)) {
            var t = new Thread(delegate() { server.WaitForConnection(); Pipes.Read(server, 1024); server.RunAsClient(delegate { try { File.ReadAllText(secret); } catch (Exception e) { asClient = e; } }); });
            t.Start();
            using (var c = Pipes.Client("SupportMcpTest-" + me8)) { c.Connect(2000); Pipes.Write(c, Wire.Map("type", "status")); t.Join(5000); }
        }
        Assert(asClient != null, "The server cannot open files as the client (identification only)");
        Console.WriteLine("PASS pipes: framing, the window's two requests, the first-instance guard and the window link");

        // The corner window's copy is the exe without the configuration (and its attach key).
        byte[] cfgBytes = Encoding.UTF8.GetBytes("{\"sid\":\"x\"}"), body = new byte[] { 77, 90, 1, 2, 3 };
        var withCfg = new MemoryStream(); withCfg.Write(body, 0, body.Length); withCfg.Write(cfgBytes, 0, cfgBytes.Length); withCfg.Write(BitConverter.GetBytes(cfgBytes.Length), 0, 4); byte[] footer = Encoding.ASCII.GetBytes(Wire.Footer); withCfg.Write(footer, 0, footer.Length);
        Assert(Wire.Payload(withCfg.ToArray()) == body.Length, "window.exe is cut before the configuration");
        Console.WriteLine("PASS window.exe carries no session configuration");

        // The elevated installer runs from a copy in a fresh folder, and reads itself through a handle that nobody can write or rename under.
        string download = Path.Combine(dir, "downloads"); Directory.CreateDirectory(download);
        string exe = Path.Combine(download, "remote-support-abcd1234.exe"); File.WriteAllBytes(exe, withCfg.ToArray());
        File.WriteAllText(exe + ".config", "<configuration/>"); File.WriteAllText(Path.Combine(download, "version.dll"), "planted");
        string staged = Elevation.Stage(exe);
        try {
            Assert(Path.GetFileName(staged) == "remote-support-abcd1234.exe" && Path.GetDirectoryName(Path.GetDirectoryName(staged)).TrimEnd('\\') == Path.GetTempPath().TrimEnd('\\') && Directory.GetFiles(Path.GetDirectoryName(staged)).Length == 1, "Only the exe is in the staging folder: " + staged);
            FileStream held; byte[] selfBytes = FullInstall.ReadSelf(staged, out held);
            using (held) {
                Assert(selfBytes.Length == withCfg.Length, "The installer reads its whole file once");
                try { using (new FileStream(staged, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) { } throw new Exception("the held exe could be opened for writing"); } catch (IOException) { }
                try { File.Move(staged, staged + ".old"); throw new Exception("the held exe could be renamed"); } catch (IOException) { }
            }
        } finally { Directory.Delete(Path.GetDirectoryName(staged), true); }
        Console.WriteLine("PASS the elevated installer runs from a clean copy and holds its own file");

        // File operations as SYSTEM refuse junctions, links and a second hard link, and work on a plain path.
        string plain = Path.Combine(dir, "plain"), target = Path.Combine(dir, "protected"); Directory.CreateDirectory(plain); Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(target, "file.txt"), "keep");
        Func<string, int> cmd = delegate(string line) { var c = Process.Start(new ProcessStartInfo("cmd.exe", "/c " + line) { UseShellExecute = false, CreateNoWindow = true }); c.WaitForExit(); return c.ExitCode; };
        Assert(cmd("mklink /J \"" + Path.Combine(plain, "jump") + "\" \"" + target + "\"") == 0, "Test setup: a junction");
        Assert(cmd("mklink /H \"" + Path.Combine(plain, "twin.txt") + "\" \"" + Path.Combine(target, "file.txt") + "\"") == 0, "Test setup: a second hard link");
        foreach (string path in new string[] { Path.Combine(plain, @"jump\file.txt"), Path.Combine(plain, @"jump\new.txt") })
            foreach (bool write in new bool[] { true, false }) {
                try { using (Native.OpenPlain(path, write, false)) { } throw new Exception("followed a junction: " + path + " write " + write); } catch (ArgumentException e) { Assert(e.Message == Native.LinkRefused, e.Message); } catch (System.ComponentModel.Win32Exception) { Assert(!write, "Only a read of a missing file may fail differently"); }
            }
        try { using (Native.OpenPlain(Path.Combine(plain, "twin.txt"), true, false)) { } throw new Exception("wrote through a second hard link"); } catch (ArgumentException e) { Assert(e.Message == Native.LinkRefused, e.Message); }
        Assert(File.ReadAllText(Path.Combine(target, "file.txt")) == "keep" && !File.Exists(Path.Combine(target, "new.txt")), "Nothing behind the junction or the link changed");
        // Missing folders are made one level at a time, each checked; a junction at any level is refused.
        foreach (bool write in new bool[] { true, false }) {
            try { using (Native.OpenPlain(Path.Combine(plain, @"jump\new\deeper\x.txt"), write, false)) { } throw new Exception("went through a junction above new folders"); } catch (ArgumentException e) { Assert(e.Message == Native.LinkRefused, e.Message); }
        }
        Assert(!Directory.Exists(Path.Combine(target, "new")), "No folder was made behind the junction");
        string ok = Path.Combine(plain, @"sub\one\two\data.bin");
        using (var w = Native.OpenPlain(ok, true, false)) w.Write(new byte[] { 1, 2, 3 }, 0, 3);
        using (var w = Native.OpenPlain(ok, true, true)) w.Write(new byte[] { 4 }, 0, 1);
        using (var w = Native.OpenPlain(ok, true, false)) w.Write(new byte[] { 9 }, 0, 1);
        using (var r2 = Native.OpenPlain(ok, false, false)) Assert(r2.Length == 1 && r2.ReadByte() == 9, "A plain path: create, append, then replace");
        Assert(cmd("rmdir \"" + Path.Combine(plain, "jump") + "\"") == 0, "Test cleanup: the junction");
        Console.WriteLine("PASS file operations as SYSTEM refuse junctions and extra hard links, and keep working on plain paths");
    }
    static void LaneTests() {
        using (var relay = new FakeRelay()) {
            relay.Lifetime = 300000; relay.Start();
            var caps = (System.Collections.ArrayList)relay.Hello["caps"];
            Assert(Wire.Text(relay.Hello, "agent") == "windows-app-2" && Wire.Text(relay.Hello, "version") == Wire.Version && Wire.Text(relay.Hello, "control") == "normal" && caps.Contains("screen") && caps.Contains("uia") && caps.Contains("lanes"), "Hello must announce screen control and lanes");
            Assert(relay.WaitBusy(delegate(string[] b) { return b.Length == 0; }, 5000), "An idle client polls with no busy lane");
            for (int i = 0; i < 100 && relay.LastPoll == null; i++) Thread.Sleep(50);
            Assert(relay.LastPoll != null && relay.LastPoll.ContainsKey("busy") && Wire.Text(relay.LastPoll, "desktop") != "" && relay.LastPoll.ContainsKey("paused_until") && relay.LastPoll["paused_until"] == null, "A poll reports the desktop and no pause");
            string cmdId = relay.Queue(Run("Start-Sleep -Seconds 6; [Console]::Write('slow')", 30));
            Assert(relay.WaitBusy(delegate(string[] b) { return Array.IndexOf(b, "cmd") >= 0 && b.Length == 1; }, 15000), "While a command runs the client keeps polling and reports busy_lanes [cmd]");
            var timer = Stopwatch.StartNew();
            var screen = relay.Call(Act("wait", "seconds", 0.2, "screenshot", false));
            Assert(Wire.Flag(screen, "ok") && timer.ElapsedMilliseconds < 4000 && !relay.HasResult(cmdId), "A screen operation must finish while the command still runs, took " + timer.ElapsedMilliseconds + " ms");
            foreach (string name in new string[] { "block_input", "send_sas" }) {
                var denied = relay.Call(Act(name)); Assert(!Wire.Flag(denied, "ok") && Wire.Text(denied, "error") == Screen.NoFull, name + " needs full control");
            }
            var control = relay.Call(Wire.Map("type", "control", "lane", "screen", "action", "request_full_control"));
            Assert(!Wire.Flag(control, "ok") && Wire.Text(control, "error") == Screen.NoFull, "request_full_control without a handler is refused in normal mode");
            var bad = relay.Call(Act("fly")); Assert(!Wire.Flag(bad, "ok") && Wire.Text(bad, "error") == "unknown screen action", "Unknown action");
            var secretKey = relay.Call(Act("key", "keys", "ctrl+alt+Delete", "screenshot", false)); Assert(!Wire.Flag(secretKey, "ok"), "ctrl+alt+Delete is refused");
            Assert(!relay.HasResult(cmdId), "The command is still running");
            var done = relay.WaitResult(cmdId, 30);
            Assert(Wire.Flag(done, "ok") && Decode(done, "stdout_b64") == "slow", "The command result still arrives");
            Assert(relay.WaitBusy(delegate(string[] b) { return b.Length == 0; }, 2000), "A finished lane ends the parked poll at once, so the client is free again within 2 s");
            Console.WriteLine("PASS hello, lanes: a screen operation runs while a command runs, and full-control operations are refused");
        }
        // A normal-mode app that can elevate says so with the "full" cap, and request_full_control goes to its handler.
        using (var relay = new FakeRelay()) {
            relay.Agent.CanElevate = true; int asked = 0;
            relay.Agent.RequestFull = delegate { asked++; return Wire.Map("ok", false, "error", "the customer declined full control"); };
            relay.Lifetime = 300000; relay.Start();
            var caps = (System.Collections.ArrayList)relay.Hello["caps"];
            Assert(caps.Contains("full") && Wire.Text(relay.Hello, "control") == "normal", "A normal-mode app that can elevate reports the full cap and control normal");
            var r = relay.Call(Wire.Map("type", "control", "lane", "screen", "action", "request_full_control"));
            Assert(asked == 1 && !Wire.Flag(r, "ok") && Wire.Text(r, "error") == "the customer declined full control", "request_full_control runs the elevation handler: " + Wire.Text(r, "error"));
            var more = relay.Call(Run("[Console]::Write('still')", 20));
            Assert(Wire.Flag(more, "ok") && Decode(more, "stdout_b64") == "still", "A declined request leaves normal mode working");
        }
        // A handler that hands the session to the service stops this client without a result or an end.
        using (var relay = new FakeRelay()) {
            relay.Agent.CanElevate = true; var agent = relay.Agent;
            agent.RequestFull = delegate { agent.EndRemote = false; agent.Stop(); return null; };
            relay.Lifetime = 300000; relay.Start();
            string id = relay.Queue(Wire.Map("type", "control", "lane", "screen", "action", "request_full_control"));
            relay.WaitExit(); Thread.Sleep(300);
            Assert(!relay.HasResult(id) && !relay.End, "A handed-over client sends no result and no end");
        }
        // The cooldown: a decline at the first start blocks an immediate request as much as a later decline; a failure does not.
        {
            int asks = 0; Func<Dictionary<string, object>> ask = delegate { asks++; return Wire.Map("ok", false, "error", "asked"); };
            long t = PauseClock.Now();
            var gate = new FullRequestGate(); gate.Record(Elevation.Declined, t);
            Assert(Wire.Text(gate.Request(ask, t + 1), "error") == FullRequestGate.Cooling && asks == 0, "A decline at the first start: an immediate request gets the cooldown error and no prompt");
            Assert(Wire.Text(gate.Request(ask, t + FullRequestGate.CooldownMs - 1), "error") == FullRequestGate.Cooling && asks == 0, "Still within the minute");
            Assert(Wire.Text(gate.Request(ask, t + FullRequestGate.CooldownMs), "error") == "asked" && asks == 1, "After a minute it prompts again");
            gate = new FullRequestGate(); gate.Record(Elevation.Failed, t); gate.Record(Elevation.Installed, t);
            Assert(Wire.Text(gate.Request(ask, t + 1), "error") == "asked" && asks == 2, "A failure is not a decline: it prompts at once");
            gate = new FullRequestGate(); var inside = new ManualResetEvent(false); var leave = new ManualResetEvent(false); Dictionary<string, object> second = null;
            var first = new Thread(delegate() { gate.Request(delegate { inside.Set(); leave.WaitOne(); return null; }, t); }); first.Start(); inside.WaitOne();
            second = gate.Request(ask, t); leave.Set(); first.Join();
            Assert(Wire.Text(second, "error") == FullRequestGate.Waiting && asks == 2, "One prompt at a time");
            gate.Record(Elevation.Declined, t + 5);
            Assert(Wire.Text(gate.Request(ask, t + 6), "error") == FullRequestGate.Cooling && asks == 2, "A later decline starts the cooldown too");
            gate = new FullRequestGate(); gate.Record(Elevation.NoAnswer, t);
            Assert(Wire.Text(gate.Request(ask, t + 1), "error") == "asked" && asks == 3, "No answer starts no cooldown");
            // A UAC prompt the app stopped waiting for: no new request while it is open; a No on it starts the cooldown.
            // The No counts at once, at the time the prompt ended: a request right after it, with no wait, gets the cooldown.
            var stale = new ManualResetEvent(false); int staleOutcome = Elevation.Declined; long staleEnded = t + 1000;
            gate.Leave(stale, delegate { return staleOutcome; }, delegate { return staleEnded; });
            Assert(Wire.Text(gate.Request(ask, t + 900), "error") == FullRequestGate.StillOpen && asks == 3, "No second prompt while an earlier one is open");
            stale.Set();
            Assert(Wire.Text(gate.Request(ask, t + 1001), "error") == FullRequestGate.Cooling && asks == 3, "A No on the earlier prompt starts the cooldown before the next request");
            Assert(Wire.Text(gate.Request(ask, t + 1000 + FullRequestGate.CooldownMs), "error") == "asked" && asks == 4, "The minute counts from when the prompt ended");
            gate = new FullRequestGate(); stale = new ManualResetEvent(false); staleOutcome = Elevation.NoAnswer;
            gate.Leave(stale, delegate { return staleOutcome; }, delegate { return staleEnded; }); stale.Set();
            Assert(Wire.Text(gate.Request(ask, t + 1001), "error") == "asked" && asks == 5, "A prompt Windows dropped (no answer) starts no cooldown");
        }
        AttemptTests();
        Console.WriteLine("PASS an elevation attempt: the drop time, a withdrawal while it stages, Discard and the sweep of staged copies");
        Console.WriteLine("PASS request_full_control: the full cap, a declined request, the silent handover, the cooldown after any decline");
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
    static string ForegroundInfo() { IntPtr fg = Win.GetForegroundWindow(); uint pid; Win.GetWindowThreadProcessId(fg, out pid); var t = new StringBuilder(200); GetWindowText(fg, t, 200); string name = ""; try { name = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { } return fg + " pid " + pid + " " + name + " \"" + t + "\" (this process " + Process.GetCurrentProcess().Id + ")"; }
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
            Assert(!Wire.Flag(key, "ok") && Wire.Text(key, "error").Contains("support window has the keyboard focus"), "Keystrokes while this process has the focus must be refused: " + Wire.Text(key, "error") + " foreground " + ForegroundInfo());
            Assert(!Wire.Flag(tree, "ok") && Wire.Text(tree, "error").Contains("support window"), "ui_tree must not read this process's window: " + Wire.Text(tree, "error"));
        }
        Console.WriteLine("PASS live screen: capture, zoom, exact cursor mapping, pause and own-window guards");
        // The corner window never takes the focus when it appears, keeps a taskbar button, and gives the focus back after
        // the customer keeps the session: asking to end activates it, Keep connected returns the focus to the window it came
        // from. That window belongs to another process (a peer started from this exe), because a window of this process is never given the focus back.
        {
            var info = new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, "--peer " + Process.GetCurrentProcess().Id) { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
            var lines = new List<string>(); Process peer = Process.Start(info);
            peer.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) lock (lines) lines.Add(e.Data); };
            peer.BeginOutputReadLine();
            try {
                var end = DateTime.UtcNow.AddSeconds(15); bool ready = false;
                while (!ready && DateTime.UtcNow < end) { lock (lines) ready = lines.Contains("ready"); Thread.Sleep(25); }
                Assert(ready, "Test setup: the peer window opened");
                peer.Refresh(); IntPtr peerWindow = peer.MainWindowHandle;
                bool styled = false, stillPeer = false, active = true, confirmActive = false, restored = false, usable = false, wrongIds = true, olderKept = false, tuckBack = false;
                var t = new Thread(delegate() {
                    Screen.Dpi();
                    Action pump = delegate { for (int i = 0; i < 20; i++) { Application.DoEvents(); System.Windows.Threading.Dispatcher.CurrentDispatcher.Invoke(System.Windows.Threading.DispatcherPriority.Background, new Action(delegate { })); Thread.Sleep(25); } };
                    pump();
                    Win.SetForegroundWindow(peerWindow); pump();
                    var window = new SupportWindow(Palette.Detect(), false, false, null);
                    window.Show(); pump();
                    IntPtr handle = new System.Windows.Interop.WindowInteropHelper(window).Handle;
                    int ex = Win.GetWindowLong(handle, -20);
                    styled = (ex & unchecked((int)Win.NoActivate)) != 0 && (ex & unchecked((int)Win.AppWindow)) != 0;
                    stillPeer = Win.GetForegroundWindow() == peerWindow; active = window.IsActive;
                    uint peerPid; uint peerThread = Win.GetWindowThreadProcessId(peerWindow, out peerPid);
                    usable = FocusReturn.Usable(peerWindow, peerPid, peerThread);
                    wrongIds = FocusReturn.Usable(peerWindow, peerPid + 1, peerThread) || FocusReturn.Usable(peerWindow, peerPid, peerThread + 1) || FocusReturn.Usable(IntPtr.Zero, 0, 0);
                    window.AskToEnd(); pump();
                    confirmActive = Win.GetForegroundWindow() == handle;
                    window.KeepConnected(); pump();
                    restored = Win.GetForegroundWindow() == peerWindow;
                    // The customer leaves the window while the confirm is open and comes back to it (a click on Keep activates it
                    // again): Keep must not pull the focus to the older window.
                    Win.SetForegroundWindow(peerWindow); pump();
                    window.AskToEnd(); pump();
                    using (var elsewhere = new Form { StartPosition = FormStartPosition.Manual, Location = new System.Drawing.Point(display.X + 60, display.Y + 400), Size = new System.Drawing.Size(200, 150), TopMost = true }) {
                        elsewhere.Show(); elsewhere.Activate(); pump();
                        window.Activate(); pump();
                        window.KeepConnected(); pump();
                        olderKept = Win.GetForegroundWindow() != peerWindow;
                    }
                    // A second confirm and Keep (tucking the window while it is open calls the same method) gives the focus back again.
                    Win.SetForegroundWindow(peerWindow); pump();
                    window.AskToEnd(); pump();
                    window.KeepConnected(); pump();
                    tuckBack = Win.GetForegroundWindow() == peerWindow;
                    window.CloseQuietly();
                }); t.SetApartmentState(ApartmentState.STA); t.Start(); t.Join();
                Assert(styled, "The corner window must have WS_EX_NOACTIVATE and WS_EX_APPWINDOW");
                Assert(stillPeer && !active, "Showing the corner window must leave the focus where it was");
                Assert(confirmActive, "Asking to end must give the confirm the focus");
                Assert(restored, "Keep connected must give the focus back to the window that had it");
                Assert(usable && !wrongIds, "A remembered window is usable only with the same process and thread ids");
                Assert(olderKept, "Keep must not pull the focus to an older window after the customer left the support window");
                Assert(tuckBack, "Closing the confirm gives the focus back again");
            } finally { try { peer.Kill(); } catch (Exception) { } peer.Dispose(); }
        }
        Console.WriteLine("PASS the corner window does not take the focus, keeps its taskbar button, and Keep connected gives the focus back");
        QuestionTests();
        Console.WriteLine("PASS the full-control question stays open as the owner of the UAC prompt");

        // A key the app pressed whose up never arrived (a desktop switch) neither pauses support nor stays down:
        // Unstick sends the up. A key no one released and no input for 10 s is stuck and stops pausing. F23 and F22 are harmless.
        using (var screen = new Screen()) {
            screen.Start(); var stop = new ManualResetEvent(false);
            var t = new Thread(delegate() {
                Screen.Send(Screen.KeyEvent(0x86, 0, 0));
                Assert((Win.GetAsyncKeyState(0x86) & 0x8000) != 0, "Test setup: F23 is down");
                Assert(screen.PausedForMs == 0, "The app's own key left down is not the customer's");
                Screen.Unstick();
                Assert((Win.GetAsyncKeyState(0x86) & 0x8000) == 0, "Unstick sent its up");
                var raw = new Win.In[] { Screen.KeyEvent(0x85, 0, 0) }; Win.SendInput(1, raw, Marshal.SizeOf(typeof(Win.In))); // not through Send: not the app's
                screen.Watch.Clock.Touch(-100000);
                Assert(screen.PausedForMs > 0, "A key someone else holds pauses support");
                Thread.Sleep((int)InputIdle.StuckMs + 1000);
                long left = screen.PausedForMs;
                raw[0] = Screen.KeyEvent(0x85, 0, 2); Win.SendInput(1, raw, Marshal.SizeOf(typeof(Win.In)));
                Assert(left == 0, "After 10 s with no input it is stuck and pauses nothing: " + left);
            }); t.Start(); t.Join();
        }
        Console.WriteLine("PASS a key the app left down is released, and a stuck key stops pausing after 10 s");
    }
    static T Find<T>(System.Windows.DependencyObject root, Func<T, bool> match) where T : System.Windows.DependencyObject {
        foreach (object child in System.Windows.LogicalTreeHelper.GetChildren(root)) {
            var hit = child as T; if (hit != null && match(hit)) return hit;
            var node = child as System.Windows.DependencyObject; if (node == null) continue;
            var found = Find<T>(node, match); if (found != null) return found;
        }
        return null;
    }
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    static void Press(System.Windows.Controls.Button button) { button.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent)); }
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
    // A window of another process: the focus-return test starts this exe again with --peer <parent pid>. It lets the
    // parent take the foreground, and prints "ready" once its window is shown.
    static int PeerWindow(int parent) {
        Application.EnableVisualStyles();
        var display = Screen.Monitors()[0];
        using (var form = new Form { Text = "focus peer", StartPosition = FormStartPosition.Manual, Location = new System.Drawing.Point(display.X + 400, display.Y + 60), Size = new System.Drawing.Size(300, 200), TopMost = true }) {
            form.Shown += delegate { form.Activate(); AllowSetForegroundWindow(parent); Console.Out.WriteLine("ready"); Console.Out.Flush(); };
            Application.Run(form);
        }
        return 0;
    }
    public static int Main(string[] args) {
        if (args.Length == 2 && args[0] == "--peer") { Screen.Dpi(); return PeerWindow(int.Parse(args[1])); }
        if (args.Length == 2 && args[0] == "--settle") { Thread.Sleep(250); File.WriteAllText(args[1], "done"); return 0; }
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
            foreach (bool administrator in new bool[] { false, true }) {
                string without = SupportAccess.ConsentMessage(administrator, false);
                Assert(!without.Contains("see your screen") && without.Contains("run commands") && without.Contains("stay off") && without.Contains("with administrator rights?") == administrator, "A reconnect without screen consent must not promise it: " + without);
                Assert(SupportAccess.ConsentMessage(administrator) == SupportAccess.ConsentMessage(administrator, true), "The default consent names screen control");
                string shown = null; SupportAccess.Confirm(administrator, true, false, delegate(string message) { shown = message; return DialogResult.No; });
                Assert(administrator ? shown == without : shown == null, "The prompt for a reconnect without screen consent says so");
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
                SettleTests(relay, dir);
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
            FullControlTests(dir);
            ClientRuleTests(dir);
            LaneTests();
            LiveScreenTests();
            FooterReaderTests();
            DeviceLinkTests();
            SetupRuleTests();
            DeviceInstallTests();
            DeviceServiceTests(dir);
            TrayTests();
            UninstallTests(dir);
            DeviceServiceLiveTests(dir);
            // The downloaded PE overlay must be readable by the actual .NET client.
            string overlay = Path.Combine(dir, "overlay.exe"); byte[] cfg = Encoding.UTF8.GetBytes(Wire.Json().Serialize(Wire.Map("sid", new string('a', 64), "key", new string('b', 64), "origin", "https://support.example.com", "startup_expires_at", Client.UnixNow() + 10000)));
            using (var f = File.Create(overlay)) { f.WriteByte(77); f.WriteByte(90); f.Write(cfg, 0, cfg.Length); byte[] n = BitConverter.GetBytes(cfg.Length); f.Write(n, 0, n.Length); byte[] footer = Encoding.ASCII.GetBytes(Wire.Footer); f.Write(footer, 0, footer.Length); }
            Assert(Wire.Text(Wire.ReadConfig(overlay), "sid") == new string('a', 64), "Overlay configuration");
            Console.WriteLine("PASS executable session overlay"); return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        finally { Directory.Delete(dir, true); }
    }
}
