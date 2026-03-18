import { useState, useEffect, useCallback, useRef } from "react";

const P = {
  sage50: "#f0f5f0", sage100: "#dce8dc", sage200: "#b8d4b8", sage300: "#8aba8a", sage400: "#5c9e5c", sage500: "#4a8c4a",
  blue50: "#eef4fb", blue100: "#d4e4f7", blue200: "#a8c8ee", blue300: "#7baee5", blue400: "#4e93dc", blue500: "#3b7cc8",
  slate50: "#f8fafb", slate100: "#eef2f5", slate200: "#dde4ea", slate300: "#b8c5d0", slate400: "#8a9baa", slate500: "#5f7282",
  rose300: "#f0a8a8", rose400: "#e87878", rose500: "#d94f4f",
  amber300: "#f5d486", amber400: "#eec05a",
  white: "#ffffff", glass: "rgba(255,255,255,0.42)", glassBorder: "rgba(255,255,255,0.6)",
};

const STATUS_CONFIG = {
  interview: { label: "Interview", color: P.sage500, bg: "rgba(90,160,90,0.12)", border: "rgba(90,160,90,0.25)", icon: "🤝" },
  rejected: { label: "Rejected", color: P.rose500, bg: "rgba(217,79,79,0.08)", border: "rgba(217,79,79,0.2)", icon: "✕" },
  viewed: { label: "Viewed", color: P.amber400, bg: "rgba(238,192,90,0.12)", border: "rgba(238,192,90,0.25)", icon: "👁" },
  pending: { label: "Applied", color: P.blue500, bg: "rgba(59,124,200,0.08)", border: "rgba(59,124,200,0.2)", icon: "◷" },
  stale: { label: "No Response", color: P.rose400, bg: "rgba(232,120,120,0.08)", border: "rgba(232,120,120,0.18)", icon: "⏳" },
};

const SOURCE_STYLES = {
  linkedin: { label: "LinkedIn", color: "#0a66c2", bg: "rgba(10,102,194,0.08)" },
  direct: { label: "Direct", color: P.sage500, bg: "rgba(74,140,74,0.08)" },
  ziprecruiter: { label: "ZipRecruiter", color: "#4a9960", bg: "rgba(74,153,96,0.08)" },
  indeed: { label: "Indeed", color: P.blue500, bg: "rgba(59,124,200,0.08)" },
};

// 4-month cutoff date (computed once)
const CUTOFF = new Date();
CUTOFF.setMonth(CUTOFF.getMonth() - 4);
CUTOFF.setHours(0, 0, 0, 0);

function applyStaleRule(apps) {
  return apps.map(app => {
    // Only convert pending or viewed — interviews and explicit rejections stay as-is
    if (app.status !== "pending" && app.status !== "viewed") return app;
    if (!app.date) return app;
    const d = new Date(app.date + "T00:00:00");
    if (isNaN(d.getTime())) return app;
    if (d < CUTOFF) {
      return { ...app, status: "stale", note: "No response (4+ months)" };
    }
    return app;
  });
}

function extractJSON(text) {
  if (!text) throw new Error("Empty response");
  try { const p = JSON.parse(text); if (Array.isArray(p)) return p; } catch {}
  let c = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { const p = JSON.parse(c); if (Array.isArray(p)) return p; } catch {}
  const s = c.indexOf("["), e = c.lastIndexOf("]");
  if (s !== -1 && e > s) {
    const sl = c.substring(s, e + 1);
    try { return JSON.parse(sl); } catch {}
    try { let f = sl.replace(/,\s*\]/, "]"); return JSON.parse(f); } catch {}
  }
  throw new Error("Could not parse classifier output");
}

// Today's date for the classifier to use
const TODAY = new Date().toISOString().split("T")[0];
const CUTOFF_STR = CUTOFF.toISOString().split("T")[0];

const SYS = `You are a strict JSON-only classifier. Output MUST start with [ and end with ]. No text, no markdown, no preamble.

TODAY is ${TODAY}. CUTOFF date is ${CUTOFF_STR} (4 months ago).

Rules:
- Deduplicate same company+role, keep latest status (interview > rejected > viewed > pending)
- Status classification:
  * "interview" — invited to interview, scheduling, active recruiter back-and-forth
  * "rejected" — explicitly rejected, moved on, position closed, OR any "pending"/"viewed" app with date BEFORE ${CUTOFF_STR} (these are stale — no response means rejected)
  * "viewed" — application viewed by employer, date must be AFTER ${CUTOFF_STR}
  * "pending" — application received/confirmed, date must be AFTER ${CUTOFF_STR}
- IMPORTANT: Any application dated before ${CUTOFF_STR} that is not an interview or explicit rejection MUST be classified as "rejected" with note "No response (4+ months)"
- Skip non-job emails (OTPs, newsletters, Reddit, school, dental, airlines, furniture, LinkedIn weekly summaries, talent community signups, Adobe ID creation)
- Source: "linkedin" if from jobs-noreply@linkedin.com, "ziprecruiter" if from ziprecruiter, "indeed" if from indeed.com, "direct" otherwise
- Extract actual job title from subject line

Output: [{"company":"X","role":"Y","status":"pending","date":"2026-03-17","source":"direct","note":"Short note"}]`;

function Glass({ children, style, className, onClick }) {
  return <div onClick={onClick} className={className || ""} style={{
    background: P.glass, backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)",
    border: `1px solid ${P.glassBorder}`, borderRadius: 16, ...style,
  }}>{children}</div>;
}

function SectionHead({ title, subtitle }) {
  return <div style={{ marginBottom: 16 }}>
    <h2 style={{ fontSize: 18, fontWeight: 700, color: P.slate500, letterSpacing: -0.3 }}>{title}</h2>
    {subtitle && <p style={{ fontSize: 13, color: P.slate400, marginTop: 2 }}>{subtitle}</p>}
  </div>;
}

export default function JobTrackerDashboard() {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("date");
  const [searchTerm, setSearchTerm] = useState("");
  const [animateIn, setAnimateIn] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("all");
  const hasFetched = useRef(false);

  const fetchApplications = useCallback(async () => {
    setLoading(true); setError(null); setAnimateIn(false);
    try {
      // Use /api/claude proxy on Vercel, or direct Anthropic URL inside Claude.ai artifacts
      const API_URL = window.location.hostname === 'localhost' || window.location.hostname.includes('vercel')
        ? '/api/claude'
        : 'https://api.anthropic.com/v1/messages';

      const sr = await fetch(API_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000,
          messages: [{ role: "user", content: `Do these 4 Gmail searches and return ALL results:
1. from:jobs-noreply@linkedin.com subject:(application) after:2025/1/1 — max 50
2. subject:(application OR applied OR interview OR offer OR rejected OR submission OR "we received") after:2025/1/1 — max 50
3. subject:("thank you for applying" OR "thanks for applying" OR "Thank You For Applying" OR "your interest") after:2025/1/1 — max 50
4. subject:(interview OR screening OR "next steps" OR "move forward") after:2025/1/1 — max 30
Execute all four searches.` }],
          mcp_servers: [{ type: "url", url: "https://gmail.mcp.claude.com/mcp", name: "gmail" }] })
      });
      const sd = await sr.json();
      const tr = sd.content?.filter(i => i.type === "mcp_tool_result")?.map(i => { try { return i.content?.[0]?.text || ""; } catch { return ""; } }).join("\n---SEP---\n");
      const tx = sd.content?.filter(i => i.type === "text")?.map(i => i.text).join("\n");
      const all = (tr || "") + "\n" + (tx || "");
      if (!all || all.trim().length < 50) throw new Error("Gmail returned insufficient data");

      const cr = await fetch(API_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 8000, system: SYS,
          messages: [
            { role: "user", content: `Classify every unique job application. Any app before ${CUTOFF_STR} without an interview or explicit rejection = "rejected". Output ONLY JSON array:\n\n${all}` },
            { role: "assistant", content: "[" }
          ] })
      });
      const cd = await cr.json();
      const rt = cd.content?.filter(i => i.type === "text")?.map(i => i.text).join("") || "";
      const parsed = extractJSON("[" + rt);
      // Double-enforce stale rule client-side in case classifier misses any
      const final = applyStaleRule(parsed);
      if (final.length > 0) { setApplications(final); setLastFetched(new Date()); setTimeout(() => setAnimateIn(true), 100); }
      else throw new Error("Empty result");
    } catch (err) {
      console.error(err); setError(err.message);
      if (applications.length === 0) { setApplications(applyStaleRule(FALLBACK_DATA)); setLastFetched(new Date()); setTimeout(() => setAnimateIn(true), 100); }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (!hasFetched.current) { hasFetched.current = true; fetchApplications(); } }, [fetchApplications]);

  const filtered = applications
    .filter(a => { if (filter === "all") return true; if (filter === "rejected") return a.status === "rejected" || a.status === "stale"; return a.status === filter; })
    .filter(a => sourceFilter === "all" || a.source === sourceFilter)
    .filter(a => searchTerm === "" || a.company?.toLowerCase().includes(searchTerm.toLowerCase()) || a.role?.toLowerCase().includes(searchTerm.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === "date") return (b.date || "").localeCompare(a.date || "");
      if (sortBy === "company") return (a.company || "").localeCompare(b.company || "");
      if (sortBy === "status") { const o = { interview: 0, viewed: 1, pending: 2, stale: 3, rejected: 4 }; return (o[a.status] ?? 5) - (o[b.status] ?? 5); }
      return 0;
    });

  const staleCount = applications.filter(a => a.status === "stale").length;
  const counts = { all: applications.length, interview: applications.filter(a => a.status === "interview").length, viewed: applications.filter(a => a.status === "viewed").length, pending: applications.filter(a => a.status === "pending").length, rejected: applications.filter(a => a.status === "rejected" || a.status === "stale").length };
  const srcCounts = { all: applications.length, linkedin: applications.filter(a => a.source === "linkedin").length, direct: applications.filter(a => a.source === "direct").length, ziprecruiter: applications.filter(a => a.source === "ziprecruiter").length, indeed: applications.filter(a => a.source === "indeed").length };

  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentApps = applications.filter(a => a.date && new Date(a.date + "T00:00:00") >= sevenDaysAgo).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const responseRate = applications.length > 0 ? Math.round(((counts.interview + counts.viewed) / applications.length) * 100) : 0;

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", minHeight: "100vh", background: `linear-gradient(145deg, ${P.sage50} 0%, ${P.blue50} 40%, ${P.slate50} 100%)`, padding: "0 0 48px 0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=DM+Sans:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${P.slate300};border-radius:3px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
        .glass-card{transition:transform .25s ease,box-shadow .25s ease}
        .glass-card:hover{transform:translateY(-3px);box-shadow:0 12px 32px rgba(90,130,120,0.12)}
        .row-hover{transition:background .2s ease,transform .15s ease}.row-hover:hover{background:rgba(255,255,255,0.65)!important;transform:translateX(2px)}
        .chip-hover{transition:all .2s ease}.chip-hover:hover{transform:scale(1.04);box-shadow:0 2px 8px rgba(0,0,0,0.06)}
        .sort-btn{transition:all .2s ease}.sort-btn:hover{background:rgba(255,255,255,0.7)!important}
        .kpi-ring{transition:all .3s ease}.kpi-ring:hover{transform:scale(1.05)}
      `}</style>

      {/* HERO */}
      <div style={{ background: `linear-gradient(135deg, ${P.sage200} 0%, ${P.blue200} 50%, ${P.sage100} 100%)`, padding: "40px 32px 48px", borderRadius: "0 0 32px 32px", boxShadow: "0 8px 40px rgba(90,140,120,0.15)", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -60, right: -40, width: 200, height: 200, borderRadius: "50%", background: "rgba(255,255,255,0.15)" }} />
        <div style={{ position: "absolute", bottom: -30, left: "20%", width: 120, height: 120, borderRadius: "50%", background: "rgba(255,255,255,0.1)" }} />
        <div style={{ maxWidth: 1100, margin: "0 auto", position: "relative", zIndex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 32 }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: 3, color: "rgba(255,255,255,0.7)", fontFamily: "JetBrains Mono", marginBottom: 6, textTransform: "uppercase" }}>Mission Control</div>
              <h1 style={{ fontSize: 32, fontWeight: 700, color: P.white, letterSpacing: -0.5 }}>Job Applications</h1>
              {lastFetched && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", marginTop: 6, fontFamily: "JetBrains Mono" }}>
                Synced {lastFetched.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{staleCount > 0 && ` · ${staleCount} auto-rejected (4+ mo)`}
              </div>}
            </div>
            <button onClick={fetchApplications} disabled={loading} style={{
              background: "rgba(255,255,255,0.25)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.4)",
              color: P.white, padding: "11px 22px", borderRadius: 12, fontSize: 13, fontFamily: "DM Sans", fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer", opacity: loading ? .6 : 1, transition: "all .2s",
            }}>
              <span style={{ display: "inline-block", animation: loading ? "spin 1s linear infinite" : "none", marginRight: 8, fontSize: 15 }}>⟳</span>
              {loading ? "Syncing..." : "Sync Gmail"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            {[
              { value: counts.all, label: "Total Applied", sub: `${counts.pending} active` },
              { value: counts.interview, label: "Interviews", sub: `${responseRate}% response rate` },
              { value: recentApps.length, label: "This Week", sub: "applications sent" },
            ].map((kpi, i) => (
              <div key={i} className="kpi-ring" style={{ flex: 1, minWidth: 180, padding: "24px 28px", borderRadius: 20, background: "linear-gradient(135deg, rgba(255,255,255,0.35), rgba(255,255,255,0.15))", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.35)" }}>
                <div style={{ fontSize: 42, fontWeight: 700, color: P.white, fontFamily: "JetBrains Mono", lineHeight: 1 }}>{kpi.value}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "rgba(255,255,255,0.9)", marginTop: 6 }}>{kpi.label}</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 2, fontFamily: "JetBrains Mono" }}>{kpi.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px 0" }}>
        {error && <div style={{ background: "rgba(217,79,79,0.08)", border: "1px solid rgba(217,79,79,0.2)", borderRadius: 12, padding: "12px 18px", marginBottom: 24, fontSize: 13, color: P.rose500, display: "flex", justifyContent: "space-between" }}>
          <span>⚠ {error}</span><span style={{ color: P.slate400, fontSize: 12 }}>Showing cached data</span>
        </div>}

        {/* OVERVIEW */}
        <SectionHead title="Overview" subtitle="Status breakdown and source channels" />
        <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
          {[
            { key: "all", label: "Total", count: counts.all, color: P.slate500, accent: P.slate300 },
            { key: "interview", label: "Interview", count: counts.interview, color: P.sage500, accent: P.sage300 },
            { key: "viewed", label: "Viewed", count: counts.viewed, color: "#c49520", accent: P.amber300 },
            { key: "pending", label: "Applied", count: counts.pending, color: P.blue500, accent: P.blue300 },
            { key: "rejected", label: "Rejected", count: counts.rejected, color: P.rose500, accent: P.rose300 },
          ].map(s => (
            <Glass key={s.key} className="glass-card" onClick={() => { setFilter(s.key); setSourceFilter("all"); }}
              style={{ flex: 1, minWidth: 100, padding: "18px 20px", cursor: "pointer", borderColor: filter === s.key && sourceFilter === "all" ? s.accent : P.glassBorder, boxShadow: filter === s.key ? `0 4px 16px ${s.accent}33` : "0 2px 8px rgba(0,0,0,0.04)" }}>
              <div style={{ fontSize: 30, fontWeight: 700, color: s.color, fontFamily: "JetBrains Mono" }}>{s.count}</div>
              <div style={{ fontSize: 11, color: P.slate400, textTransform: "uppercase", letterSpacing: 1.2, marginTop: 4, fontFamily: "JetBrains Mono" }}>{s.label}</div>
            </Glass>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 32, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: P.slate400, fontFamily: "JetBrains Mono", letterSpacing: 1, marginRight: 6 }}>SOURCE</span>
          {Object.entries({ all: { label: "All", color: P.slate500, bg: "rgba(0,0,0,0.03)" }, ...SOURCE_STYLES }).map(([k, c]) => {
            const n = srcCounts[k] || 0; const a = sourceFilter === k;
            if (k !== "all" && n === 0) return null;
            return <button key={k} className="chip-hover" onClick={() => { setSourceFilter(k); setFilter("all"); }}
              style={{ border: `1px solid ${a ? c.color + "44" : P.slate200}`, background: a ? c.bg : "rgba(255,255,255,0.5)", color: a ? c.color : P.slate400, padding: "6px 14px", borderRadius: 20, fontSize: 12, fontFamily: "JetBrains Mono", fontWeight: 500, cursor: "pointer" }}>
              {c.label} <span style={{ opacity: .5 }}>({n})</span></button>;
          })}
        </div>

        {/* ACTIVITY */}
        <SectionHead title="Activity" subtitle={`${recentApps.length} applications this week`} />
        {recentApps.length > 0 && (
          <div style={{ display: "flex", gap: 12, marginBottom: 32, overflowX: "auto", paddingBottom: 8 }}>
            {recentApps.slice(0, 6).map((app, i) => {
              const c = STATUS_CONFIG[app.status] || STATUS_CONFIG.pending;
              return (
                <Glass key={i} className="glass-card" style={{ minWidth: 200, padding: "16px 18px", flexShrink: 0, animation: animateIn ? `fadeUp .4s ease forwards` : "none", animationDelay: `${i * .06}s`, opacity: animateIn ? 0 : 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: P.slate500, marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{app.company}</div>
                  <div style={{ fontSize: 12, color: P.slate400, marginBottom: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{app.role}</div>
                  <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 8, fontSize: 10, fontWeight: 600, fontFamily: "JetBrains Mono", color: c.color, background: c.bg, border: `1px solid ${c.border}`, textTransform: "uppercase" }}>{c.icon} {c.label}</span>
                </Glass>
              );
            })}
          </div>
        )}

        {/* ALL APPLICATIONS */}
        <SectionHead title="All Applications" subtitle={`${filtered.length} of ${applications.length} shown`} />
        <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: 1, minWidth: 220 }}>
            <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: P.slate400, fontSize: 15 }}>⌕</span>
            <input type="text" placeholder="Search company or role..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              style={{ width: "100%", background: P.glass, backdropFilter: "blur(12px)", border: `1px solid ${P.glassBorder}`, borderRadius: 12, padding: "11px 14px 11px 38px", color: P.slate500, fontSize: 13, fontFamily: "DM Sans", outline: "none" }} />
          </div>
          <div style={{ display: "flex", gap: 2, background: P.glass, backdropFilter: "blur(12px)", borderRadius: 12, border: `1px solid ${P.glassBorder}`, overflow: "hidden" }}>
            {[{ k: "date", l: "Recent" }, { k: "company", l: "A→Z" }, { k: "status", l: "Status" }].map(s => (
              <button key={s.k} className="sort-btn" onClick={() => setSortBy(s.k)}
                style={{ border: "none", padding: "11px 16px", fontSize: 12, fontFamily: "JetBrains Mono", fontWeight: 500, cursor: "pointer", background: sortBy === s.k ? "rgba(255,255,255,0.7)" : "transparent", color: sortBy === s.k ? P.slate500 : P.slate400 }}>{s.l}</button>
            ))}
          </div>
        </div>

        {loading && applications.length === 0 && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[...Array(6)].map((_, i) => <div key={i} style={{ height: 52, borderRadius: 12, animation: "shimmer 1.5s ease-in-out infinite", animationDelay: `${i * .1}s`, background: `linear-gradient(90deg, ${P.slate100} 25%, ${P.slate50} 50%, ${P.slate100} 75%)`, backgroundSize: "200% 100%" }} />)}
        </div>}

        {(!loading || applications.length > 0) && (
          <Glass style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 10, padding: "12px 20px", fontSize: 10, letterSpacing: 1.5, color: P.slate400, fontFamily: "JetBrains Mono", fontWeight: 600, alignItems: "center", borderBottom: `1px solid ${P.slate200}`, background: "rgba(255,255,255,0.3)" }}>
              <div style={{ width: 28 }}></div>
              <div style={{ flex: 2, minWidth: 110 }}>COMPANY</div>
              <div style={{ flex: 3, minWidth: 140 }}>ROLE</div>
              <div style={{ width: 84, textAlign: "center" }}>SOURCE</div>
              <div style={{ flex: 2, minWidth: 80 }}>NOTE</div>
              <div style={{ width: 96, textAlign: "center" }}>STATUS</div>
              <div style={{ width: 72, textAlign: "right" }}>DATE</div>
            </div>
            <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
              {filtered.length === 0 ? <div style={{ padding: 48, textAlign: "center", color: P.slate400, fontSize: 14 }}>{searchTerm ? `No results for "${searchTerm}"` : "No applications here"}</div> :
                filtered.map((app, i) => {
                  const c = STATUS_CONFIG[app.status] || STATUS_CONFIG.pending;
                  const src = SOURCE_STYLES[app.source] || SOURCE_STYLES.direct;
                  const dim = app.status === "stale";
                  return (
                    <div key={`${app.company}-${app.role}-${i}`} className="row-hover"
                      style={{ display: "flex", gap: 10, padding: "13px 20px", alignItems: "center", borderBottom: `1px solid ${P.slate100}`, cursor: "default",
                        animation: animateIn ? `fadeUp .35s ease forwards` : "none", animationDelay: `${i * .015}s`, opacity: animateIn ? 0 : 1 }}>
                      <div style={{ width: 28, fontSize: 13, textAlign: "center", flexShrink: 0 }}>{c.icon}</div>
                      <div style={{ flex: 2, fontWeight: 600, color: dim ? P.slate400 : P.slate500, fontSize: 13, minWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.company}</div>
                      <div style={{ flex: 3, color: dim ? P.slate300 : P.slate400, fontSize: 12, minWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.role}</div>
                      <div style={{ width: 84, textAlign: "center", flexShrink: 0 }}>
                        <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 600, fontFamily: "JetBrains Mono", color: src.color, background: src.bg }}>{src.label}</span></div>
                      <div style={{ flex: 2, color: dim ? P.slate300 : P.slate400, fontSize: 11, minWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.note}</div>
                      <div style={{ width: 96, textAlign: "center", flexShrink: 0 }}>
                        <span style={{ display: "inline-block", padding: "4px 10px", borderRadius: 8, fontSize: 10, fontWeight: 600, fontFamily: "JetBrains Mono", color: c.color, background: c.bg, border: `1px solid ${c.border}`, textTransform: "uppercase" }}>{c.label}</span></div>
                      <div style={{ width: 72, textAlign: "right", color: P.slate400, fontSize: 11, fontFamily: "JetBrains Mono", flexShrink: 0 }}>{app.date ? fmtDate(app.date) : "—"}</div>
                    </div>);
                })}
            </div>
          </Glass>
        )}
        <div style={{ marginTop: 20, fontSize: 12, color: P.slate400, fontFamily: "JetBrains Mono", textAlign: "center" }}>
          {filtered.length} of {applications.length}{filter !== "all" && ` · ${filter === "rejected" ? "Rejected + No Response" : STATUS_CONFIG[filter]?.label}`}{sourceFilter !== "all" && ` · ${SOURCE_STYLES[sourceFilter]?.label}`}
        </div>
      </div>
    </div>
  );
}

function fmtDate(d) { try { return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch { return d; } }

const FALLBACK_DATA = [
  { company: "GM Financial", role: "Account Manager - Protection, Inland Empire", status: "interview", date: "2026-03-10", source: "direct", note: "Discussing June 22 start and comp with Robyn" },
  { company: "Reynolds and Reynolds", role: "Sales Representative", status: "interview", date: "2025-07-29", source: "direct", note: "Zoom interview completed with Cam Garcia" },
  { company: "Graybar", role: "Sales - Diamond Bar Office", status: "interview", date: "2025-04-11", source: "direct", note: "In-person interview scheduled" },
  { company: "Aspire", role: "Recruiter Call / Next Steps", status: "interview", date: "2025-05-07", source: "direct", note: "Recruiter wanted to set up a call" },
  { company: "Celonis", role: "Account Executive - Automotive", status: "rejected", date: "2026-03-18", source: "direct", note: "Not moving forward" },
  { company: "Conversica", role: "Customer Success Manager, Automotive", status: "rejected", date: "2026-03-18", source: "direct", note: "Competitive selection, not moving forward" },
  { company: "Netradyne", role: "Sales Onboarding & Enablement Manager", status: "rejected", date: "2026-03-17", source: "direct", note: "Moving forward with other candidates" },
  { company: "Capital One", role: "Dealer Success Manager - LA & Fresno", status: "rejected", date: "2026-03-11", source: "direct", note: "Moving forward with other candidates" },
  { company: "Capital One", role: "Dealer Success Manager - San Diego", status: "rejected", date: "2026-03-11", source: "direct", note: "Moving forward with other candidates" },
  { company: "Capital One", role: "Dealer Success Manager - Orange County", status: "rejected", date: "2026-03-11", source: "direct", note: "Moving forward with other candidates" },
  { company: "GM Financial", role: "Separate Position (Status Update)", status: "rejected", date: "2026-03-12", source: "direct", note: "Moving forward with another candidate" },
  { company: "Capital One", role: "Area Sales Manager - SoCal", status: "rejected", date: "2026-02-03", source: "direct", note: "Moving forward with other candidates" },
  { company: "Capital One", role: "Area Sales Manager - Costa Mesa/Irvine", status: "rejected", date: "2026-02-03", source: "direct", note: "Moving forward with other candidates" },
  { company: "Confidential", role: "Finance and Compliance Manager - Auto", status: "rejected", date: "2026-02-05", source: "indeed", note: "Moved to next step without you" },
  { company: "Tesla", role: "Sales Manager", status: "rejected", date: "2025-11-23", source: "direct", note: "Competitive pool, not moving forward" },
  { company: "Capital One", role: "Sr. Associate Product Manager", status: "rejected", date: "2025-06-12", source: "direct", note: "Moving forward with other applicants" },
  { company: "Lundbeck", role: "Psychiatry Account Manager - Ontario, CA", status: "rejected", date: "2025-04-06", source: "direct", note: "Pursuing other candidates" },
  { company: "AutoFi", role: "Position Closed", status: "rejected", date: "2025-04-07", source: "direct", note: "Position has been closed" },
  { company: "Hopper", role: "Fraud Operations Analyst", status: "rejected", date: "2025-04-05", source: "direct", note: "Moving forward with other candidates" },
  { company: "Relativity", role: "Financial Analyst - Pricing", status: "rejected", date: "2025-04-09", source: "direct", note: "Moving forward with other candidates" },
  { company: "PNC", role: "Syndicated Loan Support Analyst Sr", status: "rejected", date: "2025-04-08", source: "direct", note: "Not moving forward" },
  { company: "InterMotive Vehicle Controls", role: "National Sales Manager - Technical Sales", status: "viewed", date: "2026-03-16", source: "linkedin", note: "Application viewed by employer" },
  { company: "Galley", role: "LinkedIn Application", status: "viewed", date: "2026-03-16", source: "linkedin", note: "Application viewed by employer" },
  { company: "NCC | ProMax", role: "Account Executive - Auto SaaS (Hunter)", status: "viewed", date: "2026-03-09", source: "linkedin", note: "Application viewed" },
  { company: "Confidential Company", role: "LinkedIn Application", status: "viewed", date: "2025-04-08", source: "linkedin", note: "Application viewed" },
  { company: "Lendbuzz", role: "National Account Manager - Auto Finance", status: "viewed", date: "2025-03-31", source: "linkedin", note: "Application viewed" },
  { company: "Adobe", role: "Product Specialist - Firefly Enterprise Sales", status: "pending", date: "2026-03-17", source: "direct", note: "Application received" },
  { company: "Vercel", role: "Account Executive - Startups, Install Base", status: "pending", date: "2026-03-17", source: "direct", note: "Application confirmed" },
  { company: "Lytx", role: "Customer Success Platform Manager", status: "pending", date: "2026-03-17", source: "direct", note: "Application received" },
  { company: "Reddit", role: "Client Account Manager, Large Customer Sales (Auto)", status: "pending", date: "2026-03-17", source: "direct", note: "Application under review" },
  { company: "Salesforce", role: "Signature Success, Sales Executive", status: "pending", date: "2026-03-17", source: "direct", note: "Application confirmed" },
  { company: "Pivotal Solutions", role: "LinkedIn Application", status: "pending", date: "2026-03-17", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Tyler Technologies", role: "Client Success Account Manager - Riverside", status: "pending", date: "2026-03-17", source: "direct", note: "Application under review" },
  { company: "Amazon", role: "Sr. Customer Success Manager, Robotics", status: "pending", date: "2026-03-17", source: "direct", note: "Application confirmed" },
  { company: "Hyundai Autoever America", role: "Key Account Manager", status: "pending", date: "2026-03-17", source: "direct", note: "Resume received" },
  { company: "Intterra", role: "LinkedIn Application", status: "pending", date: "2026-03-17", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Orama Solutions", role: "Enterprise Account Executive", status: "pending", date: "2026-03-16", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Cars Commerce", role: "Client Partner, Media & Digital Solutions", status: "pending", date: "2026-03-15", source: "direct", note: "Application received" },
  { company: "Better Car People", role: "Dealer Performance Coach - Toyota Smart Path", status: "pending", date: "2026-03-15", source: "direct", note: "Application submitted" },
  { company: "Razer", role: "Category Manager (PC Gaming Peripherals)", status: "pending", date: "2026-03-14", source: "direct", note: "Application received" },
  { company: "Helm", role: "Software Sales Executive - Automotive SaaS", status: "pending", date: "2026-03-14", source: "direct", note: "Application received" },
  { company: "Synthevo", role: "Sales Executive (Car2Go.ai)", status: "pending", date: "2026-03-14", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Halla Uriman Inc.", role: "LinkedIn Application", status: "pending", date: "2026-03-13", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Lendbuzz", role: "Dealership Account Manager - Riverside", status: "pending", date: "2026-03-12", source: "direct", note: "Application received" },
  { company: "VETTX", role: "Account Executive (Remote - Automotive SaaS)", status: "pending", date: "2026-03-12", source: "ziprecruiter", note: "Application complete" },
  { company: "Safe-Guard Products", role: "National Trainer - Automotive F&I", status: "pending", date: "2026-03-12", source: "direct", note: "Resume submitted" },
  { company: "Cox Automotive", role: "Client Solutions Manager - Autotrader", status: "pending", date: "2026-03-12", source: "direct", note: "Application received" },
  { company: "Spare", role: "Customer Success Manager", status: "pending", date: "2026-03-11", source: "direct", note: "Application under review" },
  { company: "Amazon", role: "Principal Sales Rep, Automotive Greenfield", status: "pending", date: "2026-03-11", source: "direct", note: "Application confirmed" },
  { company: "Salesforce", role: "SMB Account Executive, Employee Service", status: "pending", date: "2026-03-10", source: "direct", note: "Application confirmed" },
  { company: "Tekion", role: "Customer Success Manager (Onboarding)", status: "pending", date: "2026-03-09", source: "direct", note: "Under review" },
  { company: "Demand Local", role: "LinkedIn Application", status: "pending", date: "2026-03-07", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Electrify America", role: "LinkedIn Application", status: "pending", date: "2026-03-07", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Deloitte Open Talent", role: "Dealership Software Installation Facilitator", status: "pending", date: "2026-03-07", source: "direct", note: "Contractor position" },
  { company: "DriveCentric", role: "Account Manager", status: "pending", date: "2026-03-06", source: "direct", note: "Application received" },
  { company: "BizzyCar", role: "Role via Rippling", status: "pending", date: "2026-03-06", source: "direct", note: "Application received" },
  { company: "Valsoft Corporation", role: "AI Account Executive", status: "pending", date: "2026-03-06", source: "direct", note: "Application submitted" },
  { company: "Salesforce", role: "Informatica Account Executive, Commercial", status: "pending", date: "2026-03-02", source: "direct", note: "Application confirmed" },
  { company: "Porsche Riverside", role: "LinkedIn Application", status: "pending", date: "2025-12-05", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "UPS", role: "Regional Account Manager", status: "pending", date: "2025-12-13", source: "direct", note: "Application received" },
  { company: "Ally Financial", role: "Senior Underwriter", status: "pending", date: "2025-11-26", source: "direct", note: "Application being reviewed" },
  { company: "Ally Financial", role: "L&D Manager - Dealer Training", status: "pending", date: "2025-11-21", source: "direct", note: "Application being reviewed" },
  { company: "Mercedes-Benz of Ontario", role: "Position (Nov)", status: "pending", date: "2025-11-21", source: "direct", note: "Application received" },
  { company: "Mercedes-Benz of Ontario", role: "Position (Aug)", status: "pending", date: "2025-08-15", source: "direct", note: "Application received" },
  { company: "Mercedes-Benz of Ontario", role: "Position (May)", status: "pending", date: "2025-05-29", source: "direct", note: "Application received" },
  { company: "Lendbuzz", role: "Financial Operations Specialist", status: "pending", date: "2025-05-11", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Sunflower Bank", role: "Credit Underwriter III", status: "pending", date: "2025-05-06", source: "direct", note: "Application received" },
  { company: "TEC Equipment", role: "Leasing Sales", status: "pending", date: "2025-04-11", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Yendo", role: "LinkedIn Application", status: "pending", date: "2025-04-11", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Agile Resources, Inc.", role: "LinkedIn Application", status: "pending", date: "2025-04-11", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Lendbuzz", role: "Account Manager", status: "pending", date: "2025-04-10", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "S&P Global", role: "Dealer Relations Manager", status: "pending", date: "2025-04-08", source: "direct", note: "Application received" },
  { company: "Tandem Diabetes Care", role: "Territory Manager - Riverside", status: "pending", date: "2025-04-08", source: "direct", note: "Application confirmed" },
  { company: "Steno", role: "Finance Manager", status: "pending", date: "2025-04-08", source: "direct", note: "Application received" },
  { company: "Fortis Capital Advisors", role: "LinkedIn Application", status: "pending", date: "2025-04-08", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Project Resources Corp.", role: "LinkedIn Application", status: "pending", date: "2025-04-08", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Aspire General Insurance", role: "Career Application", status: "pending", date: "2025-04-05", source: "direct", note: "Application received" },
  { company: "AlphaSense", role: "Financial Systems & Analytics Analyst", status: "pending", date: "2025-04-05", source: "direct", note: "Under review" },
  { company: "Ally Financial", role: "Underwriter - Consumer", status: "pending", date: "2025-04-05", source: "direct", note: "Application being reviewed" },
  { company: "First Advantage", role: "LinkedIn Application", status: "pending", date: "2025-04-05", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Toma", role: "Digital/Scaled CS Manager (Automation & AI)", status: "pending", date: "2025-04-05", source: "direct", note: "Application received" },
  { company: "Toma", role: "Founding Recruiter", status: "pending", date: "2025-04-05", source: "direct", note: "Application received" },
  { company: "Pulley", role: "Role via Greenhouse", status: "pending", date: "2025-04-06", source: "direct", note: "Application under review" },
  { company: "Mainstay", role: "Pricing Analyst", status: "pending", date: "2025-04-04", source: "direct", note: "Application received" },
  { company: "Canaan Inc.", role: "LinkedIn Application", status: "pending", date: "2025-04-03", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Hopper", role: "LinkedIn Application", status: "pending", date: "2025-04-03", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "eCapital Corp.", role: "LinkedIn Application", status: "pending", date: "2025-04-03", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Lendbuzz", role: "National Account Manager - Auto Finance", status: "pending", date: "2025-04-03", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Chevron FCU", role: "Fraud Prevention Analyst", status: "pending", date: "2025-04-01", source: "direct", note: "Application received" },
  { company: "Goldschmitt & Associates", role: "LinkedIn Application", status: "pending", date: "2025-03-31", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Lendbuzz Inc", role: "LinkedIn Application", status: "pending", date: "2025-03-31", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Upgrade, Inc.", role: "LinkedIn Application", status: "pending", date: "2025-03-31", source: "linkedin", note: "Applied via LinkedIn" },
  { company: "Cox Automotive", role: "Talent Community / Next Steps", status: "pending", date: "2025-03-19", source: "direct", note: "Application follow-up" },
];
