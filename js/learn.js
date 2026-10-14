// Shared client for the course builder + library. Anonymous sign-in, no email.
(function () {
  const URL_ = "https://xooqrijbzkqkznvfzcym.supabase.co";
  const KEY = "sb_publishable_bhBn-9fo17FS90et-ilSRQ_fIAwokqu";
  const sb = window.supabase.createClient(URL_, KEY, { auth: { persistSession: true, autoRefreshToken: true } });

  async function ensureUser() {
    const { data } = await sb.auth.getSession();
    if (data.session) return data.session.user;
    const r = await sb.auth.signInAnonymously();
    if (r.error) throw new Error("Could not start a session: " + r.error.message);
    return r.data.user;
  }

  async function call(body) {
    await ensureUser();
    const { data: s } = await sb.auth.getSession();
    const res = await fetch(URL_ + "/functions/v1/course-builder", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: KEY, Authorization: "Bearer " + s.session.access_token },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || "Request failed (" + res.status + ")");
    return j;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  window.Learn = { sb, ensureUser, call, esc };
})();
