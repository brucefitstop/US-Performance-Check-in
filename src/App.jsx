import { useState, useEffect, useCallback, useRef } from "react";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const US_LOCS = [
  { id: "santa-monica",   name: "Santa Monica",       state: "CA", addr: "3032 Wilshire Blvd" },
  { id: "hermosa-beach",  name: "Hermosa Beach",      state: "CA", addr: "1310 Pacific Coast Hwy" },
  { id: "woodland-hills", name: "Woodland Hills",     state: "CA", addr: "21524 Ventura Blvd" },
  { id: "la-jolla",       name: "La Jolla",           state: "CA", addr: "7547 Girard Ave" },
  { id: "cherry-hill",    name: "Cherry Hill",        state: "NJ", addr: "2240 Marlton Pike W" },
  { id: "northern-lib",   name: "Northern Liberties", state: "PA", addr: "456 N 5th St, Philadelphia" },
];
const PRESALES_LOCS = [
  { id: "playa-del-rey",  name: "Playa del Rey",      state: "CA", addr: "Los Angeles, CA",  presales: true },
  { id: "memorial",       name: "Memorial",           state: "TX", addr: "Houston, TX",       presales: true },
];
const ALL_LOCS = [...US_LOCS, ...PRESALES_LOCS];

const BLANK_DATA = () => ({
  date: "", type: "Monthly Review",
  membership: "", revenue: "", ops: "", growth: "",
  tps: [], notes: "", questions: "",
  sentiment: null, members: "", newMTD: "", ret: "", rev: "",
  recapNotes: "", actions: [], history: [],
});

const SENTIMENTS = [
  { key: "strong", label: "Firing",      icon: "🔥", active: "bg-green-900/30 border-green-600 text-green-400" },
  { key: "good",   label: "On Track",    icon: "📈", active: "bg-orange-900/20 border-orange-500 text-orange-400" },
  { key: "needs",  label: "Needs Focus", icon: "⚠️", active: "bg-yellow-900/20 border-yellow-600 text-yellow-400" },
  { key: "concern",label: "Concern",     icon: "🚨", active: "bg-red-900/20 border-red-700 text-red-400" },
];
const SENTIMENT_TAGS = {
  strong:  { cls: "bg-green-900/30 text-green-400",   label: "Firing" },
  good:    { cls: "bg-orange-900/20 text-orange-400", label: "On Track" },
  needs:   { cls: "bg-yellow-900/20 text-yellow-400", label: "Needs Focus" },
  concern: { cls: "bg-red-900/20 text-red-400",       label: "Concern" },
};

// ─── GITHUB GIST STORAGE ─────────────────────────────────────────────────────
const GIST_FILENAME = "fitstop-checkins.json";
const TOKEN_KEY     = "fitstop-gh-token";
const GIST_ID_KEY   = "fitstop-gh-gist-id";

function localGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function localSet(key, val) { try { localStorage.setItem(key, val); } catch {} }
function localDel(key) { try { localStorage.removeItem(key); } catch {} }

async function ghRequest(token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

async function findOrCreateGist(token) {
  let page = 1;
  while (true) {
    const gists = await ghRequest(token, "GET", `/gists?per_page=100&page=${page}`);
    if (!gists.length) break;
    const found = gists.find(g => g.files?.[GIST_FILENAME]);
    if (found) return found.id;
    if (gists.length < 100) break;
    page++;
  }
  const created = await ghRequest(token, "POST", "/gists", {
    description: "Fitstop Performance Check-Ins",
    public: false,
    files: { [GIST_FILENAME]: { content: JSON.stringify({}) } },
  });
  return created.id;
}

async function gistRead(token, gistId) {
  const gist = await ghRequest(token, "GET", `/gists/${gistId}`);
  const content = gist.files?.[GIST_FILENAME]?.content || "{}";
  return JSON.parse(content);
}

async function gistWrite(token, gistId, data) {
  await ghRequest(token, "PATCH", `/gists/${gistId}`, {
    files: { [GIST_FILENAME]: { content: JSON.stringify(data, null, 2) } },
  });
}

async function validateToken(token) {
  const user = await ghRequest(token, "GET", "/user");
  return user.login;
}

// ─── AI PREP GENERATOR ───────────────────────────────────────────────────────
// Calls Anthropic API with Gmail + Drive + Circleback + Calendar MCP servers
// to gather last-14-days context for a location, then drafts full prep.
async function generatePrepFromSources(locName, locAddr, history) {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const lastCheckin = history?.[0];

  const systemPrompt = `You are an AI assistant helping a Fitstop US regional manager prepare for a performance check-in at Fitstop ${locName} (${locAddr}).

Search ALL available tools — Gmail, Google Drive, Google Calendar, and Circleback — for any emails, documents, meeting notes, or calendar events related to "Fitstop ${locName}" or "${locName}" from the last 14 days (since ${since}).

Based on everything you find, return ONLY a valid JSON object (no markdown, no explanation) with this exact structure:
{
  "membership": "2-3 sentences on membership trends, retention issues, churn, or wins surfaced in the data",
  "revenue": "2-3 sentences on revenue performance, PT sales, upsells, or financial concerns",
  "ops": "2-3 sentences on staffing, scheduling, facility, equipment issues or updates",
  "growth": "2-3 sentences on leads, referrals, marketing, community events or growth initiatives",
  "tps": ["talking point 1", "talking point 2", "talking point 3", "talking point 4", "talking point 5"],
  "notes": "2-4 sentences of overall context and prep notes — key themes, watch-outs, recent incidents",
  "questions": "3-5 open questions to ask the location manager, one per line",
  "actions": [
    {"text": "specific follow-up action", "owner": "person or role"},
    {"text": "specific follow-up action", "owner": "person or role"}
  ]
}

If a source has no relevant data, skip it and use what you find elsewhere. If nothing is found at all, return sensible defaults based on standard Fitstop check-in practice.${lastCheckin ? `\n\nContext from last check-in (${lastCheckin.date}): ${lastCheckin.recapNotes || "No notes"}. Previous actions: ${(lastCheckin.actions || []).map(a => a.text).join(", ") || "none"}.` : ""}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: `Generate prep for my check-in at Fitstop ${locName}. Search Gmail, Google Drive, Google Calendar, and Circleback for anything related to this location in the last 14 days.` }],
      mcp_servers: [
        { type: "url", url: "https://gmailmcp.googleapis.com/mcp/v1",        name: "gmail" },
        { type: "url", url: "https://drivemcp.googleapis.com/mcp/v1",        name: "google-drive" },
        { type: "url", url: "https://calendarmcp.googleapis.com/mcp/v1",     name: "google-calendar" },
        { type: "url", url: "https://app.circleback.ai/api/mcp",             name: "circleback" },
      ],
    }),
  });

  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  const txt = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  const clean = txt.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── SMALL UI COMPONENTS ─────────────────────────────────────────────────────
const SectionHeading = ({ children }) => (
  <div className="flex items-center gap-3 mb-3">
    <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#F26722" }}>
      {children}
    </span>
    <div style={{ flex: 1, height: 1, background: "rgba(242,103,34,0.35)" }} />
  </div>
);

const FocusCard = ({ icon, label, value, onChange, placeholder }) => (
  <div style={{ background: "#242424", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: 12, transition: "border-color 0.15s" }}
    onFocus={e => e.currentTarget.style.borderColor = "rgba(242,103,34,0.45)"}
    onBlur={e => e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <div style={{ width: 28, height: 28, background: "rgba(242,103,34,0.15)", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>{icon}</div>
      <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</span>
    </div>
    <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={3}
      style={{ width: "100%", background: "transparent", border: "none", color: "rgba(255,255,255,0.75)", fontFamily: "'Barlow', sans-serif", fontSize: 12, lineHeight: 1.6, resize: "none", outline: "none", minHeight: 60 }} />
  </div>
);

const NotesBlock = ({ value, onChange, placeholder, rows = 4 }) => (
  <div style={{ background: "#242424", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: 12, marginBottom: 16, transition: "border-color 0.15s" }}
    onFocus={e => e.currentTarget.style.borderColor = "rgba(242,103,34,0.45)"}
    onBlur={e => e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"}
  >
    <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows}
      style={{ width: "100%", background: "transparent", border: "none", color: "rgba(255,255,255,0.75)", fontFamily: "'Barlow', sans-serif", fontSize: 13, lineHeight: 1.7, resize: "none", outline: "none" }} />
  </div>
);

const MetricCard = ({ label, value, onChange, suffix, large }) => (
  <div style={{ background: "#242424", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: 12, textAlign: "center" }}>
    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#888", marginBottom: 6 }}>{label}</div>
    <input value={value} onChange={e => onChange(e.target.value)} placeholder="—" maxLength={5}
      style={{ width: 54, background: "transparent", border: "none", borderBottom: "1.5px solid rgba(255,255,255,0.12)", color: "#F26722", fontFamily: "'Barlow Condensed', sans-serif", fontSize: large ? 19 : 26, fontWeight: 800, textAlign: "center", outline: "none", padding: 0 }} />
    <div style={{ fontSize: 11, color: "#888", marginTop: 3 }}>{suffix}</div>
  </div>
);

// ─── GENERATE PREP BUTTON ────────────────────────────────────────────────────
function GeneratePrepBanner({ locName, locAddr, history, onGenerated, onError }) {
  const [status, setStatus] = useState("idle"); // idle | scanning | done | error
  const [sources, setSources] = useState([]);
  const D = { fontFamily: "'Barlow Condensed', sans-serif" };

  const SOURCE_STEPS = [
    { key: "gmail",    icon: "✉️",  label: "Gmail" },
    { key: "drive",    icon: "📂",  label: "Google Drive" },
    { key: "calendar", icon: "📅",  label: "Calendar" },
    { key: "cb",       icon: "⭕",  label: "Circleback" },
  ];

  async function generate() {
    setStatus("scanning");
    setSources([]);

    // Animate source scanning
    for (let i = 0; i < SOURCE_STEPS.length; i++) {
      await new Promise(r => setTimeout(r, 600));
      setSources(prev => [...prev, SOURCE_STEPS[i].key]);
    }

    try {
      const result = await generatePrepFromSources(locName, locAddr, history);
      setStatus("done");
      onGenerated(result);
    } catch (e) {
      setStatus("error");
      onError(e.message);
    }
  }

  if (status === "idle") return (
    <div style={{ background: "linear-gradient(135deg, rgba(242,103,34,0.1), rgba(242,103,34,0.04))", border: "0.5px solid rgba(242,103,34,0.35)", borderRadius: 8, padding: "14px 16px", marginBottom: 20, display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ flex: 1 }}>
        <div style={{ ...D, fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#F26722", marginBottom: 3 }}>✦ AI Prep Generator</div>
        <div style={{ fontSize: 12, color: "#888", lineHeight: 1.5 }}>Scans your Gmail, Drive, Calendar & Circleback from the last 14 days to draft your full prep automatically.</div>
      </div>
      <button onClick={generate}
        style={{ background: "#F26722", border: "none", borderRadius: 5, color: "#fff", ...D, fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "9px 18px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>
        ⚡ Generate Prep
      </button>
    </div>
  );

  if (status === "scanning") return (
    <div style={{ background: "rgba(242,103,34,0.06)", border: "0.5px solid rgba(242,103,34,0.35)", borderRadius: 8, padding: "14px 16px", marginBottom: 20 }}>
      <div style={{ ...D, fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#F26722", marginBottom: 10 }}>⚡ Scanning sources…</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {SOURCE_STEPS.map(s => (
          <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 5, background: sources.includes(s.key) ? "rgba(99,153,34,0.15)" : "rgba(255,255,255,0.04)", border: `0.5px solid ${sources.includes(s.key) ? "rgba(99,153,34,0.4)" : "rgba(255,255,255,0.08)"}`, borderRadius: 4, padding: "5px 10px", transition: "all 0.3s" }}>
            <span style={{ fontSize: 12 }}>{s.icon}</span>
            <span style={{ ...D, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: sources.includes(s.key) ? "#97C459" : "#555" }}>{s.label}</span>
            {sources.includes(s.key) && <span style={{ color: "#97C459", fontSize: 10 }}>✓</span>}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "#555", marginTop: 10 }}>Drafting your prep — this takes about 15–30 seconds…</div>
    </div>
  );

  if (status === "done") return (
    <div style={{ background: "rgba(99,153,34,0.08)", border: "0.5px solid rgba(99,153,34,0.3)", borderRadius: 8, padding: "10px 16px", marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ color: "#97C459", fontSize: 14 }}>✓</span>
      <span style={{ fontSize: 12, color: "#97C459" }}>Prep drafted from Gmail, Drive, Calendar & Circleback — review and edit below</span>
      <button onClick={() => setStatus("idle")} style={{ marginLeft: "auto", background: "transparent", border: "none", color: "#555", fontSize: 11, cursor: "pointer", ...D, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>Regenerate</button>
    </div>
  );

  if (status === "error") return (
    <div style={{ background: "rgba(226,75,74,0.08)", border: "0.5px solid rgba(226,75,74,0.3)", borderRadius: 8, padding: "10px 16px", marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ color: "#E24B4A", fontSize: 14 }}>⚠</span>
      <span style={{ fontSize: 12, color: "#E24B4A" }}>Could not generate prep — enter manually or try again</span>
      <button onClick={() => setStatus("idle")} style={{ marginLeft: "auto", background: "transparent", border: "none", color: "#888", fontSize: 11, cursor: "pointer", ...D, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>Try Again</button>
    </div>
  );
}

// ─── GITHUB SETUP SCREEN ─────────────────────────────────────────────────────
function GitHubSetup({ onConnect }) {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const D = { fontFamily: "'Barlow Condensed', sans-serif" };
  const S = { fontFamily: "'Barlow', sans-serif" };

  async function connect() {
    if (!token.trim()) return;
    setStatus("checking");
    setErrorMsg("");
    try {
      await validateToken(token.trim());
      const gistId = await findOrCreateGist(token.trim());
      localSet(TOKEN_KEY, token.trim());
      localSet(GIST_ID_KEY, gistId);
      onConnect(token.trim(), gistId);
    } catch (e) {
      setStatus("error");
      setErrorMsg(e.message || "Could not connect. Check your token and try again.");
    }
  }

  return (
    <div style={{ ...S, background: "#111", color: "#fff", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ background: "#1A1A1A", borderBottom: "2px solid #F26722", padding: "13px 24px", display: "flex", alignItems: "center", gap: 16, flexShrink: 0 }}>
        <div style={{ ...D, fontWeight: 800, fontSize: 22, letterSpacing: "0.04em", textTransform: "uppercase", color: "#F26722" }}>Fitstop</div>
        <div style={{ width: 1, height: 28, background: "rgba(255,255,255,0.08)" }} />
        <div style={{ ...D, fontSize: 17, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>Performance Check-Ins</div>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ width: "100%", maxWidth: 480 }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={{ width: 56, height: 56, background: "rgba(242,103,34,0.12)", border: "1px solid rgba(242,103,34,0.3)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 26 }}>🐙</div>
            <div style={{ ...D, fontSize: 22, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Connect GitHub</div>
            <div style={{ fontSize: 13, color: "#888", lineHeight: 1.7 }}>Your check-in data syncs to a private GitHub Gist —<br />accessible from any device, any browser.</div>
          </div>
          <div style={{ background: "#1A1A1A", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 20, marginBottom: 20 }}>
            <div style={{ ...D, fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#F26722", marginBottom: 14 }}>How to get a token</div>
            {[
              { n: "1", text: <span>Go to <a href="https://github.com/settings/tokens/new" target="_blank" rel="noreferrer" style={{ color: "#F26722", textDecoration: "none" }}>github.com/settings/tokens/new</a></span> },
              { n: "2", text: <span>Set a note like <b style={{ color: "#fff", fontWeight: 600 }}>"Fitstop Check-Ins"</b> and an expiry</span> },
              { n: "3", text: <span>Under <b style={{ color: "#fff", fontWeight: 600 }}>Scopes</b>, tick <b style={{ color: "#fff", fontWeight: 600 }}>gist</b> only</span> },
              { n: "4", text: <span>Click <b style={{ color: "#fff", fontWeight: 600 }}>Generate token</b>, copy it, paste below</span> },
            ].map(({ n, text }) => (
              <div key={n} style={{ display: "flex", gap: 12, marginBottom: 10, alignItems: "flex-start" }}>
                <div style={{ width: 22, height: 22, background: "rgba(242,103,34,0.15)", border: "0.5px solid rgba(242,103,34,0.3)", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, ...D, fontSize: 11, fontWeight: 800, color: "#F26722" }}>{n}</div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", lineHeight: 1.6, paddingTop: 2 }}>{text}</div>
              </div>
            ))}
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", ...D, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#888", marginBottom: 6 }}>Personal Access Token</label>
            <input type="password" value={token} onChange={e => { setToken(e.target.value); setStatus(null); }} onKeyDown={e => e.key === "Enter" && connect()}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              style={{ width: "100%", background: "#1A1A1A", border: `0.5px solid ${status === "error" ? "#E24B4A" : "rgba(255,255,255,0.12)"}`, borderRadius: 5, color: "#fff", fontFamily: "monospace", fontSize: 13, padding: "10px 12px", outline: "none" }} />
            {status === "error" && <div style={{ fontSize: 12, color: "#E24B4A", marginTop: 6 }}>⚠ {errorMsg}</div>}
          </div>
          <button onClick={connect} disabled={!token.trim() || status === "checking"}
            style={{ width: "100%", background: status === "checking" ? "rgba(242,103,34,0.5)" : "#F26722", border: "none", borderRadius: 5, color: "#fff", ...D, fontSize: 14, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "11px 0", cursor: !token.trim() || status === "checking" ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            {status === "checking" ? "Connecting…" : "🔗 Connect & Sync"}
          </button>
          <div style={{ fontSize: 11, color: "#555", textAlign: "center", marginTop: 14, lineHeight: 1.6 }}>Token stored in browser localStorage only.<br />Data syncs to a private Gist only you can see.</div>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [ghToken, setGhToken]     = useState(null);
  const [ghGistId, setGhGistId]   = useState(null);
  const [setupDone, setSetupDone] = useState(false);
  const [allData, setAllData]     = useState({});
  const [locId, setLocId]         = useState("santa-monica");
  const [view, setView]           = useState("prep");
  const [tab, setTab]             = useState("focus");
  const [draft, setDraft]         = useState(BLANK_DATA());
  const [loading, setLoading]     = useState(true);
  const [syncing, setSyncing]     = useState(false);
  const [toast, setToast]         = useState(null);

  const [cbQuery, setCbQuery]         = useState("");
  const [cbSearching, setCbSearching] = useState(false);
  const [cbMeetings, setCbMeetings]   = useState([]);
  const [cbSelected, setCbSelected]   = useState(null);
  const [cbImporting, setCbImporting] = useState(false);

  const toastRef = useRef();
  const D = { fontFamily: "'Barlow Condensed', sans-serif" };
  const S = { fontFamily: "'Barlow', sans-serif" };

  useEffect(() => {
    const token  = localGet(TOKEN_KEY);
    const gistId = localGet(GIST_ID_KEY);
    if (token && gistId) {
      setGhToken(token); setGhGistId(gistId); setSetupDone(true);
      gistRead(token, gistId)
        .then(data => {
          setAllData(data);
          const loc = ALL_LOCS[0];
          setDraft(data[loc.id] ? { ...BLANK_DATA(), ...data[loc.id] } : BLANK_DATA());
          setCbQuery(loc.name + " check-in");
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  function onConnect(token, gistId) {
    setGhToken(token); setGhGistId(gistId); setSetupDone(true);
    setLoading(true);
    gistRead(token, gistId)
      .then(data => {
        setAllData(data);
        const loc = ALL_LOCS[0];
        setDraft(data[loc.id] ? { ...BLANK_DATA(), ...data[loc.id] } : BLANK_DATA());
        setCbQuery(loc.name + " check-in");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  function disconnect() {
    localDel(TOKEN_KEY); localDel(GIST_ID_KEY);
    setGhToken(null); setGhGistId(null); setSetupDone(false);
    setAllData({}); setDraft(BLANK_DATA());
  }

  const showToast = useCallback((msg, isError = false) => {
    setToast({ msg, isError });
    clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const currentLoc = ALL_LOCS.find(l => l.id === locId);

  function selectLoc(id) {
    setLocId(id);
    const saved = allData[id];
    setDraft(saved ? { ...BLANK_DATA(), ...saved } : BLANK_DATA());
    const l = ALL_LOCS.find(x => x.id === id);
    setCbQuery(l.name + " check-in");
    setCbMeetings([]); setCbSelected(null);
  }

  async function save(data = draft) {
    const updated = { ...allData, [locId]: { ...data } };
    setAllData(updated);
    if (ghToken && ghGistId) {
      setSyncing(true);
      try { await gistWrite(ghToken, ghGistId, updated); }
      catch { showToast("Sync failed — check connection", true); }
      finally { setSyncing(false); }
    }
    return updated;
  }

  async function saveAndToast() { await save(); showToast("Saved & synced to GitHub ✓"); }

  async function archive() {
    const snap = { date: draft.date, type: draft.type, sentiment: draft.sentiment, recapNotes: draft.recapNotes, actions: [...draft.actions], members: draft.members };
    const history = [snap, ...(draft.history || [])];
    const reset = { ...BLANK_DATA(), history };
    setDraft(reset);
    await save(reset);
    setView("history");
    showToast("Check-in archived & synced ✓");
  }

  // Called when AI prep generation completes
  function onPrepGenerated(result) {
    setDraft(d => ({
      ...d,
      membership: result.membership || d.membership,
      revenue:    result.revenue    || d.revenue,
      ops:        result.ops        || d.ops,
      growth:     result.growth     || d.growth,
      tps:        result.tps?.length ? result.tps : d.tps,
      notes:      result.notes      || d.notes,
      questions:  result.questions  || d.questions,
      actions:    result.actions?.length
        ? [...d.actions, ...result.actions.map(a => ({ text: a.text || "", owner: a.owner || "", done: false }))]
        : d.actions,
    }));
    showToast("Prep drafted from your emails, docs & meetings ✓");
  }

  async function cbSearch() {
    if (!cbQuery.trim()) return;
    setCbSearching(true); setCbMeetings([]); setCbSelected(null);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1000,
          system: `Search Circleback for meetings matching the query. Return ONLY a JSON array (no markdown) of up to 5 objects: [{"meetingId": number, "name": string, "date": string, "excerpt": string}]. If none found, return [].`,
          messages: [{ role: "user", content: `Search Circleback for: "${cbQuery}"` }],
          mcp_servers: [{ type: "url", url: "https://app.circleback.ai/api/mcp", name: "circleback" }],
        }),
      });
      const data = await res.json();
      const txt = (data.content || []).map(c => c.text || "").join("");
      try { const m = JSON.parse(txt.replace(/```json|```/g, "").trim()); setCbMeetings(Array.isArray(m) ? m : []); }
      catch { setCbMeetings([]); }
    } catch { setCbMeetings([]); }
    setCbSearching(false);
  }

  async function cbImport() {
    if (cbSelected === null) return;
    const meeting = cbMeetings[cbSelected];
    setCbImporting(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1000,
          system: `Fetch the meeting by ID from Circleback and return ONLY valid JSON (no markdown): {"notes": "2-4 sentence summary", "actions": [{"text": "action description", "owner": "person or role"}]}`,
          messages: [{ role: "user", content: `Fetch meeting ID ${meeting.meetingId} and return structured JSON.` }],
          mcp_servers: [{ type: "url", url: "https://app.circleback.ai/api/mcp", name: "circleback" }],
        }),
      });
      const data = await res.json();
      const txt = (data.content || []).map(c => c.text || "").join("");
      let parsed = { notes: "", actions: [] };
      try { parsed = JSON.parse(txt.replace(/```json|```/g, "").trim()); } catch {}
      setDraft(d => ({
        ...d,
        recapNotes: d.recapNotes ? d.recapNotes + "\n\n" + parsed.notes : (parsed.notes || d.recapNotes),
        actions: [...d.actions, ...(parsed.actions || []).map(a => ({ text: a.text || "", owner: a.owner || "", done: false }))],
      }));
      showToast("Imported from Circleback ✓");
    } catch { showToast("Import failed — enter notes manually", true); }
    setCbImporting(false);
  }

  function addTP() { setDraft(d => ({ ...d, tps: [...d.tps, ""] })); }
  function updateTP(i, v) { setDraft(d => { const tps = [...d.tps]; tps[i] = v; return { ...d, tps }; }); }
  function delTP(i) { setDraft(d => ({ ...d, tps: d.tps.filter((_, x) => x !== i) })); }
  function addAction() { setDraft(d => ({ ...d, actions: [...d.actions, { text: "", owner: "", done: false }] })); }
  function updateAction(i, key, val) { setDraft(d => { const actions = d.actions.map((a, x) => x === i ? { ...a, [key]: val } : a); return { ...d, actions }; }); }
  function toggleAction(i) { updateAction(i, "done", !draft.actions[i].done); }
  function delAction(i) { setDraft(d => ({ ...d, actions: d.actions.filter((_, x) => x !== i) })); }

  function locBadge(l) {
    if (l.presales) return { cls: "text-blue-400 bg-blue-900/20 border border-blue-800/40", label: "Presales" };
    const d = allData[l.id];
    if (d?.history?.length) return { cls: "text-green-400 bg-green-900/20", label: `${d.history.length} check-in${d.history.length > 1 ? "s" : ""}` };
    if (d?.date || d?.membership || d?.notes) return { cls: "text-orange-400 bg-orange-900/20", label: "Prep ready" };
    return { cls: "text-zinc-500 bg-zinc-800", label: "No prep" };
  }

  if (!setupDone) return <GitHubSetup onConnect={onConnect} />;

  if (loading) return (
    <div style={{ background: "#111", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ ...D, color: "#F26722", fontSize: 14, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>Loading from GitHub…</div>
    </div>
  );

  return (
    <div style={{ ...S, background: "#111", color: "#fff", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>

      {/* HEADER */}
      <div style={{ background: "#1A1A1A", borderBottom: "2px solid #F26722", padding: "13px 24px", display: "flex", alignItems: "center", gap: 16, flexShrink: 0 }}>
        <div style={{ ...D, fontWeight: 800, fontSize: 22, letterSpacing: "0.04em", textTransform: "uppercase", color: "#F26722" }}>Fitstop</div>
        <div style={{ width: 1, height: 28, background: "rgba(255,255,255,0.08)" }} />
        <div style={{ ...D, fontSize: 17, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", flex: 1 }}>Performance Check-Ins</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: syncing ? "rgba(242,103,34,0.1)" : "rgba(99,153,34,0.1)", border: `0.5px solid ${syncing ? "rgba(242,103,34,0.3)" : "rgba(99,153,34,0.3)"}`, borderRadius: 4, padding: "4px 10px" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: syncing ? "#F26722" : "#97C459", animation: syncing ? "pulse 1s infinite" : "none" }} />
            <span style={{ ...D, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: syncing ? "#F26722" : "#97C459" }}>{syncing ? "Syncing…" : "GitHub Sync"}</span>
          </div>
          <button onClick={disconnect} style={{ background: "transparent", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 4, color: "#555", ...D, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "4px 8px", cursor: "pointer" }}>⎋ Disconnect</button>
        </div>
        <span style={{ ...D, background: "rgba(242,103,34,0.15)", border: "0.5px solid rgba(242,103,34,0.4)", color: "#F26722", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", padding: "4px 10px", borderRadius: 3 }}>🇺🇸 US Locations</span>
        <div style={{ display: "flex", gap: 4 }}>
          {["prep", "recap", "history"].map(v => (
            <button key={v} onClick={() => { if (v === "history") save(); setView(v); }}
              style={{ background: view === v ? "#F26722" : "transparent", border: `0.5px solid ${view === v ? "#F26722" : "rgba(255,255,255,0.08)"}`, color: view === v ? "#fff" : "#888", ...D, fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "6px 14px", borderRadius: 4, cursor: "pointer" }}>
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* MAIN */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* SIDEBAR */}
        <div style={{ width: 218, background: "#1A1A1A", borderRight: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", flexShrink: 0, overflowY: "auto" }}>
          <div style={{ ...D, fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#888", padding: "16px 16px 8px" }}>US Locations</div>
          {US_LOCS.map(l => {
            const { cls, label } = locBadge(l);
            return (
              <div key={l.id} onClick={() => selectLoc(l.id)}
                style={{ padding: "10px 16px", cursor: "pointer", borderLeft: `3px solid ${locId === l.id ? "#F26722" : "transparent"}`, background: locId === l.id ? "#242424" : "transparent", transition: "all 0.15s" }}>
                <div style={{ ...D, fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>{l.name}</div>
                <div style={{ fontSize: 11, color: "#888", marginTop: 1 }}>{l.state} · {l.addr}</div>
                <span style={{ ...D, fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 6px", borderRadius: 3, marginTop: 4, display: "inline-block" }} className={cls}>{label}</span>
              </div>
            );
          })}
          <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "8px 16px" }} />
          <div style={{ ...D, fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#888", padding: "4px 16px 8px" }}>Presales</div>
          {PRESALES_LOCS.map(l => {
            const { cls, label } = locBadge(l);
            return (
              <div key={l.id} onClick={() => selectLoc(l.id)}
                style={{ padding: "10px 16px", cursor: "pointer", borderLeft: `3px solid ${locId === l.id ? "#F26722" : "transparent"}`, background: locId === l.id ? "#242424" : "transparent", transition: "all 0.15s" }}>
                <div style={{ ...D, fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "rgba(255,255,255,0.7)" }}>{l.name}</div>
                <div style={{ fontSize: 11, color: "#888", marginTop: 1 }}>{l.state} · {l.addr}</div>
                <span style={{ ...D, fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 6px", borderRadius: 3, marginTop: 4, display: "inline-block" }} className={cls}>{label}</span>
              </div>
            );
          })}
        </div>

        {/* CONTENT */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* PREP VIEW */}
          {view === "prep" && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.08)", background: "#1A1A1A", flexShrink: 0 }}>
                {[{ k: "focus", icon: "🎯", label: "Focus Areas" }, { k: "talking", icon: "💬", label: "Talking Points" }, { k: "notes", icon: "📝", label: "Prep Notes" }].map(t => (
                  <button key={t.k} onClick={() => setTab(t.k)}
                    style={{ background: "transparent", border: "none", borderBottom: `2px solid ${tab === t.k ? "#F26722" : "transparent"}`, color: tab === t.k ? "#F26722" : "#888", ...D, fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "11px 18px", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>

                {tab === "focus" && (
                  <>
                    {/* AI GENERATE BANNER */}
                    <GeneratePrepBanner
                      locName={currentLoc?.name}
                      locAddr={currentLoc?.addr}
                      history={draft.history}
                      onGenerated={onPrepGenerated}
                      onError={msg => showToast(msg || "Generation failed", true)}
                    />

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
                      {[
                        { label: "Location", el: <input value={`Fitstop ${currentLoc?.name}`} readOnly style={{ width: "100%", background: "#242424", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 4, color: "#fff", fontFamily: "'Barlow', sans-serif", fontSize: 13, padding: "8px 10px", outline: "none" }} /> },
                        { label: "Check-In Date", el: <input type="date" value={draft.date} onChange={e => setDraft(d => ({ ...d, date: e.target.value }))} style={{ width: "100%", background: "#242424", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 4, color: "#fff", fontFamily: "'Barlow', sans-serif", fontSize: 13, padding: "8px 10px", outline: "none", colorScheme: "dark" }} /> },
                        { label: "Meeting Type", el: (
                          <select value={draft.type} onChange={e => setDraft(d => ({ ...d, type: e.target.value }))}
                            style={{ width: "100%", background: "#242424", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 4, color: "#fff", fontFamily: "'Barlow', sans-serif", fontSize: 13, padding: "8px 10px", outline: "none" }}>
                            {["Monthly Review", "Quarterly Check-In", "Performance Deep-Dive", "Ad Hoc", currentLoc?.presales ? "Presales Check-In" : null].filter(Boolean).map(o => <option key={o}>{o}</option>)}
                          </select>
                        )},
                      ].map(({ label, el }) => (
                        <div key={label}>
                          <label style={{ display: "block", fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#888", marginBottom: 5, fontFamily: "'Barlow', sans-serif" }}>{label}</label>
                          {el}
                        </div>
                      ))}
                    </div>

                    <SectionHeading>Focus Areas</SectionHeading>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
                      <FocusCard icon="👥" label="Membership" value={draft.membership} onChange={v => setDraft(d => ({ ...d, membership: v }))} placeholder="Member numbers, retention, churn concerns..." />
                      <FocusCard icon="💰" label="Revenue" value={draft.revenue} onChange={v => setDraft(d => ({ ...d, revenue: v }))} placeholder={currentLoc?.presales ? "Presale targets, deposit holders, pricing..." : "Revenue targets, upsells, PT sessions..."} />
                      <FocusCard icon="⚙️" label="Operations" value={draft.ops} onChange={v => setDraft(d => ({ ...d, ops: v }))} placeholder={currentLoc?.presales ? "Build timeline, equipment orders, staffing plan..." : "Staffing, scheduling, equipment, facility..."} />
                      <FocusCard icon="📊" label="Growth" value={draft.growth} onChange={v => setDraft(d => ({ ...d, growth: v }))} placeholder={currentLoc?.presales ? "Lead gen, community building, launch event..." : "Leads, referrals, marketing, community events..."} />
                    </div>
                  </>
                )}

                {tab === "talking" && (
                  <>
                    <SectionHeading>Talking Points</SectionHeading>
                    <div style={{ marginBottom: 12 }}>
                      {draft.tps.map((tp, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: "0.5px solid rgba(255,255,255,0.08)" }}>
                          <div style={{ width: 6, height: 6, background: "#F26722", borderRadius: "50%", marginTop: 7, flexShrink: 0 }} />
                          <input value={tp} onChange={e => updateTP(i, e.target.value)} placeholder="Talking point..."
                            style={{ flex: 1, background: "transparent", border: "none", color: "#fff", fontFamily: "'Barlow', sans-serif", fontSize: 13, outline: "none", padding: 0, lineHeight: 1.5 }} />
                          <button onClick={() => delTP(i)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.2)", cursor: "pointer", fontSize: 13, padding: 0 }}>✕</button>
                        </div>
                      ))}
                      {draft.tps.length === 0 && (
                        <div style={{ fontSize: 12, color: "#555", padding: "12px 0" }}>No talking points yet — use ⚡ Generate Prep on the Focus Areas tab to draft them automatically.</div>
                      )}
                    </div>
                    <button onClick={addTP} style={{ background: "transparent", border: "0.5px dashed rgba(255,255,255,0.15)", borderRadius: 4, color: "#888", ...D, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "7px 14px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>+ Add point</button>
                  </>
                )}

                {tab === "notes" && (
                  <>
                    <SectionHeading>Context & Prep Notes</SectionHeading>
                    <NotesBlock value={draft.notes} onChange={v => setDraft(d => ({ ...d, notes: v }))} rows={5} placeholder="Context from emails, docs and meetings will appear here after generating prep..." />
                    <SectionHeading>Questions to Ask</SectionHeading>
                    <NotesBlock value={draft.questions} onChange={v => setDraft(d => ({ ...d, questions: v }))} rows={4} placeholder="Questions drafted from your sources will appear here..." />
                  </>
                )}
              </div>
            </div>
          )}

          {/* RECAP VIEW */}
          {view === "recap" && (
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
              <div style={{ background: "linear-gradient(135deg,rgba(242,103,34,0.08),rgba(242,103,34,0.03))", border: "0.5px solid rgba(242,103,34,0.4)", borderRadius: 8, padding: 16, marginBottom: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={{ ...D, background: "rgba(242,103,34,0.15)", color: "#F26722", fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "3px 10px", borderRadius: 3 }}>⭕ Circleback</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.8)" }}>Pull from a meeting recording</span>
                </div>
                <div style={{ fontSize: 12, color: "#888", lineHeight: 1.6, marginBottom: 12 }}>Search your Circleback meetings to auto-populate notes and action items from a recorded check-in.</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={cbQuery} onChange={e => setCbQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && cbSearch()}
                    placeholder="Search meetings..." style={{ flex: 1, background: "#242424", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 4, color: "#fff", fontFamily: "'Barlow', sans-serif", fontSize: 13, padding: "8px 10px", outline: "none" }} />
                  <button onClick={cbSearch} disabled={cbSearching}
                    style={{ background: cbSearching ? "rgba(242,103,34,0.5)" : "#F26722", border: "none", borderRadius: 4, color: "#fff", ...D, fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "8px 16px", cursor: cbSearching ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                    {cbSearching ? "Searching…" : "🔍 Search"}
                  </button>
                </div>
                {cbMeetings.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    {cbMeetings.map((m, i) => (
                      <div key={i} onClick={() => setCbSelected(i)}
                        style={{ background: cbSelected === i ? "rgba(242,103,34,0.08)" : "#242424", border: `0.5px solid ${cbSelected === i ? "#F26722" : "rgba(255,255,255,0.08)"}`, borderRadius: 5, padding: "10px 12px", marginBottom: 8, cursor: "pointer", transition: "all 0.15s" }}>
                        <div style={{ ...D, fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>{m.name || "Untitled"}</div>
                        <div style={{ fontSize: 11, color: "#888" }}>{m.date}</div>
                        {m.excerpt && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", marginTop: 4, lineHeight: 1.5 }}>{m.excerpt.substring(0, 100)}…</div>}
                      </div>
                    ))}
                    <button onClick={cbImport} disabled={cbSelected === null || cbImporting}
                      style={{ width: "100%", marginTop: 4, background: "rgba(242,103,34,0.15)", border: "0.5px solid rgba(242,103,34,0.4)", borderRadius: 4, color: "#F26722", ...D, fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: 9, cursor: cbSelected === null ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, opacity: cbSelected === null ? 0.4 : 1 }}>
                      {cbImporting ? "Importing…" : "⬇ Import Notes & Action Items"}
                    </button>
                  </div>
                )}
                {!cbSearching && cbMeetings.length === 0 && cbQuery && (
                  <div style={{ fontSize: 12, color: "#888", marginTop: 10 }}>Hit Search to look up your Circleback meetings, or enter notes manually below.</div>
                )}
              </div>

              <SectionHeading>Meeting Sentiment</SectionHeading>
              <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
                {SENTIMENTS.map(({ key, label, icon, active }) => (
                  <button key={key} onClick={() => setDraft(d => ({ ...d, sentiment: d.sentiment === key ? null : key }))}
                    style={{ flex: 1, background: "#242424", border: `0.5px solid ${draft.sentiment === key ? "currentColor" : "rgba(255,255,255,0.08)"}`, borderRadius: 5, ...D, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "8px 4px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
                    className={draft.sentiment === key ? active : "text-zinc-500 hover:text-white"}>
                    {icon} {label}
                  </button>
                ))}
              </div>

              <SectionHeading>Key Metrics</SectionHeading>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 20 }}>
                <MetricCard label="Members"   value={draft.members} onChange={v => setDraft(d => ({ ...d, members: v }))} suffix="total" />
                <MetricCard label="New MTD"   value={draft.newMTD}  onChange={v => setDraft(d => ({ ...d, newMTD: v }))}  suffix="joins" />
                <MetricCard label="Retention" value={draft.ret}     onChange={v => setDraft(d => ({ ...d, ret: v }))}     suffix="%" />
                <MetricCard label="Revenue"   value={draft.rev}     onChange={v => setDraft(d => ({ ...d, rev: v }))}     suffix="$k MTD" large />
              </div>

              <SectionHeading>Meeting Notes</SectionHeading>
              <NotesBlock value={draft.recapNotes} onChange={v => setDraft(d => ({ ...d, recapNotes: v }))} rows={4} placeholder="Key discussion points, outcomes, what was agreed..." />

              <SectionHeading>Action Items</SectionHeading>
              <div style={{ marginBottom: 12 }}>
                {draft.actions.map((a, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: "0.5px solid rgba(255,255,255,0.08)" }}>
                    <div onClick={() => toggleAction(i)}
                      style={{ width: 16, height: 16, border: `1.5px solid ${a.done ? "#F26722" : "rgba(255,255,255,0.2)"}`, borderRadius: 3, background: a.done ? "#F26722" : "transparent", flexShrink: 0, marginTop: 2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 10 }}>
                      {a.done && "✓"}
                    </div>
                    <div style={{ flex: 1, display: "flex", gap: 8 }}>
                      <input value={a.text} onChange={e => updateAction(i, "text", e.target.value)} placeholder="Action item..."
                        style={{ flex: 1, background: "transparent", border: "none", color: a.done ? "rgba(255,255,255,0.3)" : "#fff", fontFamily: "'Barlow', sans-serif", fontSize: 13, outline: "none", padding: 0, lineHeight: 1.5, textDecoration: a.done ? "line-through" : "none" }} />
                      <input value={a.owner} onChange={e => updateAction(i, "owner", e.target.value)} placeholder="Owner"
                        style={{ width: 100, background: "#333", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 3, color: "rgba(255,255,255,0.6)", fontFamily: "'Barlow', sans-serif", fontSize: 11, padding: "3px 6px", outline: "none", textAlign: "center" }} />
                    </div>
                    <button onClick={() => delAction(i)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.2)", cursor: "pointer", fontSize: 13, padding: 0 }}>✕</button>
                  </div>
                ))}
              </div>
              <button onClick={addAction} style={{ background: "transparent", border: "0.5px dashed rgba(255,255,255,0.15)", borderRadius: 4, color: "#888", ...D, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "7px 14px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>+ Add action item</button>
            </div>
          )}

          {/* HISTORY VIEW */}
          {view === "history" && (
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
              <SectionHeading>Past Check-Ins — {currentLoc?.name}</SectionHeading>
              {(!draft.history || draft.history.length === 0) ? (
                <div style={{ textAlign: "center", padding: "48px 24px", color: "#888" }}>
                  <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.3 }}>📋</div>
                  <div style={{ ...D, fontSize: 14, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>No past check-ins yet</div>
                  <div style={{ fontSize: 12, lineHeight: 1.6 }}>Complete a recap and archive it<br />to start building history for this location.</div>
                </div>
              ) : draft.history.map((h, i) => {
                const tag = SENTIMENT_TAGS[h.sentiment] || { cls: "bg-orange-900/20 text-orange-400", label: "Check-In" };
                return (
                  <div key={i} style={{ background: "#242424", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "14px 16px", marginBottom: 10, cursor: "pointer", transition: "border-color 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(242,103,34,0.4)"}
                    onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                      <div style={{ ...D, fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", flex: 1 }}>{h.date || "Undated"} — {h.type || "Check-In"}</div>
                      <span style={{ ...D, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 3 }} className={tag.cls}>{tag.label}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#888", lineHeight: 1.5 }}>{(h.recapNotes || "No notes recorded.").substring(0, 120)}{h.recapNotes?.length > 120 ? "…" : ""}</div>
                    <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.3)", display: "flex", alignItems: "center", gap: 5 }}>
                      ☑ {(h.actions || []).length} action items{h.members ? ` · ${h.members} members` : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

        </div>
      </div>

      {/* BOTTOM BAR */}
      <div style={{ background: "#1A1A1A", borderTop: "1px solid rgba(255,255,255,0.08)", padding: "12px 24px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        {view === "prep" && <>
          <button onClick={saveAndToast} style={{ background: "#F26722", border: "none", borderRadius: 4, color: "#fff", ...D, fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "9px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>{syncing ? "⟳ Syncing…" : "💾 Save Prep"}</button>
          <button onClick={() => { save(); setView("recap"); }} style={{ background: "transparent", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 4, color: "#888", ...D, fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "9px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>📋 Go to Recap</button>
        </>}
        {view === "recap" && <>
          <button onClick={saveAndToast} style={{ background: "#F26722", border: "none", borderRadius: 4, color: "#fff", ...D, fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "9px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>{syncing ? "⟳ Syncing…" : "💾 Save Recap"}</button>
          <button onClick={archive} style={{ background: "transparent", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 4, color: "#888", ...D, fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "9px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>📦 Archive Check-In</button>
        </>}
        {view === "history" && <button onClick={() => setView("prep")} style={{ background: "#F26722", border: "none", borderRadius: 4, color: "#fff", ...D, fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "9px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>+ New Check-In</button>}
        <span style={{ fontSize: 12, color: "#888", marginLeft: "auto" }}>Fitstop {currentLoc?.name}, {currentLoc?.state}{currentLoc?.presales ? " · Presales" : ""}</span>
      </div>

      {/* TOAST */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: "#1A1A1A", border: `0.5px solid ${toast.isError ? "rgba(226,75,74,0.4)" : "rgba(242,103,34,0.4)"}`, borderRadius: 6, padding: "12px 16px", fontSize: 13, color: "#fff", display: "flex", alignItems: "center", gap: 10, zIndex: 100, boxShadow: "0 4px 24px rgba(0,0,0,0.4)" }}>
          <span style={{ color: toast.isError ? "#E24B4A" : "#F26722" }}>{toast.isError ? "⚠" : "✓"}</span> {toast.msg}
        </div>
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </div>
  );
}
