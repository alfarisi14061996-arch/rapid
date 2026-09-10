import React, { useState, useEffect, useMemo, useRef } from "react";
import { Plus, Search, ClipboardList, ChevronRight, X, FileDown, LayoutDashboard, Calendar, Trash2, AlertCircle, UserCheck, Camera, Image as ImageIcon, Upload, LogIn, LogOut, Paperclip, FileText, Download, Archive, ChevronLeft, Home, ArrowRight, CheckCircle2 } from "lucide-react";
import { supabase } from "./supabaseClient";
import { exportMeetingToDocx } from "./lib/exportDocx";
import { exportMeetingToCombinedPdf } from "./lib/exportCombinedPdf";
import logo from "./logo.png";
import { HAKIM_ROSTER, PEGAWAI_ROSTER } from "./staffRoster";
import JSZip from "jszip";
import { saveAs } from "file-saver";

const DOCS_BUCKET = "notea-dokumentasi";
const ATTACHMENTS_BUCKET = "rapid-lampiran";
const ROSTER_ORDER_LIST = [...HAKIM_ROSTER, ...PEGAWAI_ROSTER];
const ROSTER_NAMES = new Set(ROSTER_ORDER_LIST.map((p) => p.name));
const ROSTER_ORDER = new Map(ROSTER_ORDER_LIST.map((p, idx) => [p.name, idx]));

// Urutkan daftar hadir mengikuti hierarki roster (Ketua, Hakim, lalu Pegawai
// sesuai urutan di staffRoster.js). Peserta di luar roster (tamu) ditaruh
// paling akhir, urutan penambahan tetap dipertahankan di antara sesama tamu.
function sortAttendees(attendees) {
  const NOT_IN_ROSTER = ROSTER_ORDER_LIST.length + 1;
  return attendees
    .slice()
    .sort((a, b) => {
      const ai = ROSTER_ORDER.has(a.name) ? ROSTER_ORDER.get(a.name) : NOT_IN_ROSTER;
      const bi = ROSTER_ORDER.has(b.name) ? ROSTER_ORDER.get(b.name) : NOT_IN_ROSTER;
      return ai - bi;
    });
}

const MEETING_CATEGORIES = ["Rapat Pimpinan", "Rapat Rutin", "Rapat Evaluasi", "Rapat Koordinasi", "Lainnya"];

const CATEGORY_COLORS = {
  "Rapat Rutin": "bg-stone-100 text-stone-600",
  "Rapat Monitoring dan Evaluasi": "bg-amber-100 text-amber-700",
  "Rapat Koordinasi": "bg-sky-100 text-sky-700",
  Lainnya: "bg-stone-100 text-stone-600",
};

const emptyDraft = () => ({
  id: null,
  title: "",
  date: todayLocalStr(),
  leader: "",
  category: MEETING_CATEGORIES[1],
  agenda: "",
  discussion: "",
  attendees: [],
  documents: [],
  attachments: [],
});

const emptyAttendee = () => ({
  id: `new-${crypto.randomUUID()}`,
  name: "",
  position: "",
});

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

// Tanggal hari ini menurut zona waktu LOKAL browser (bukan UTC).
// toISOString() bawaan JS selalu mengonversi ke UTC, yang salah untuk WIB/WITA/WIT
// (misal jam 02:00 WIB tanggal 28 masih tercatat UTC tanggal 27).
function todayLocalStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Ubah baris dari Supabase (snake_case, relasi terpisah) menjadi bentuk state di UI
function mapMeetingFromDb(row) {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    leader: row.leader || "",
    category: row.category || MEETING_CATEGORIES[1],
    agenda: row.agenda || "",
    discussion: row.discussion || "",
    attendees: sortAttendees(
      (row.attendees || []).map((a) => ({ id: a.id, name: a.name, position: a.position || "" }))
    ),
    documents: (row.meeting_documents || [])
      .slice()
      .sort((a, b) => (a.created_at > b.created_at ? 1 : -1))
      .map((d) => ({
        id: d.id,
        filePath: d.file_path,
        fileName: d.file_name,
        url: supabase.storage.from(DOCS_BUCKET).getPublicUrl(d.file_path).data.publicUrl,
      })),
    attachments: (row.meeting_attachments || [])
      .slice()
      .sort((a, b) => (a.created_at > b.created_at ? 1 : -1))
      .map((d) => ({
        id: d.id,
        filePath: d.file_path,
        fileName: d.file_name,
        url: supabase.storage.from(ATTACHMENTS_BUCKET).getPublicUrl(d.file_path).data.publicUrl,
      })),
  };
}

export default function ENotulen() {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState("home"); // home | list | dashboard | calendar | form | detail
  const [draft, setDraft] = useState(emptyDraft());
  const [editingId, setEditingId] = useState(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("Semua");
  const [selectedId, setSelectedId] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [toast, setToast] = useState("");
  const [uploadingDocs, setUploadingDocs] = useState(false);
  const [zippingId, setZippingId] = useState(null);
  const [mergingId, setMergingId] = useState(null);
  const [mergeStatus, setMergeStatus] = useState("");
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const fileInputRef = useRef(null);
  const attachmentInputRef = useRef(null);

  const [session, setSession] = useState(undefined); // undefined = belum dicek, null = tidak login
  const [showLogin, setShowLogin] = useState(false);
  const isAdmin = !!session;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // Kalau bukan admin (misal baru logout) dan sedang di tampilan khusus admin, pindah ke arsip
  useEffect(() => {
    if (!isAdmin && (view === "dashboard" || view === "form")) {
      setView("list");
    }
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleLogout() {
    await supabase.auth.signOut();
    showToast("Berhasil keluar");
  }

  async function loadMeetings() {
    setLoading(true);
    const { data, error } = await supabase
      .from("meetings")
      .select("*, attendees(*), meeting_documents(*), meeting_attachments(*)")
      .order("date", { ascending: false });
    if (error) {
      setLoadError(true);
    } else {
      setLoadError(false);
      setMeetings((data || []).map(mapMeetingFromDb));
    }
    setLoading(false);
  }

  useEffect(() => {
    loadMeetings();
  }, []);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 2200);
  }

  function startNew() {
    setDraft(emptyDraft());
    setEditingId(null);
    setView("form");
  }

  function startEdit(meeting) {
    setDraft({
      ...meeting,
      attendees: meeting.attendees.map((a) => ({ ...a })),
      documents: meeting.documents.map((d) => ({ ...d })),
      attachments: meeting.attachments.map((d) => ({ ...d })),
    });
    setEditingId(meeting.id);
    setView("form");
  }

  async function saveDraft() {
    if (!draft.title.trim()) {
      showToast("Judul rapat wajib diisi");
      return;
    }
    setSaving(true);
    const meetingPayload = {
      title: draft.title,
      date: draft.date,
      leader: draft.leader,
      category: draft.category,
      agenda: draft.agenda,
      discussion: draft.discussion,
    };
    const cleanAttendees = draft.attendees.filter((a) => a.name.trim());

    let meetingId = editingId;
    let err = null;

    if (editingId) {
      const { error } = await supabase.from("meetings").update(meetingPayload).eq("id", editingId);
      err = error;
      if (!err) {
        await supabase.from("attendees").delete().eq("meeting_id", editingId);
      }
    } else {
      const { data, error } = await supabase.from("meetings").insert(meetingPayload).select().single();
      err = error;
      if (!err) meetingId = data.id;
    }

    if (!err && cleanAttendees.length > 0) {
      const attendeesPayload = cleanAttendees.map((a) => ({
        meeting_id: meetingId,
        name: a.name,
        position: a.position,
      }));
      const { error: attErr } = await supabase.from("attendees").insert(attendeesPayload);
      err = attErr;
    }

    // Hapus dokumentasi yang dihapus pengguna dari draft (dibandingkan data asli)
    if (!err && editingId) {
      const original = meetings.find((m) => m.id === editingId);
      const removed = (original?.documents || []).filter(
        (od) => !draft.documents.some((dd) => dd.id === od.id)
      );
      if (removed.length > 0) {
        await supabase.storage.from(DOCS_BUCKET).remove(removed.map((r) => r.filePath));
        await supabase.from("meeting_documents").delete().in("id", removed.map((r) => r.id));
      }
    }

    // Unggah dokumentasi baru yang ditambahkan (punya properti .file)
    const newDocs = draft.documents.filter((d) => d.file);
    if (!err && newDocs.length > 0) {
      setUploadingDocs(true);
      for (const d of newDocs) {
        const ext = d.file.name.split(".").pop();
        const path = `${meetingId}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage.from(DOCS_BUCKET).upload(path, d.file);
        if (upErr) {
          err = upErr;
          break;
        }
        const { error: insErr } = await supabase
          .from("meeting_documents")
          .insert({ meeting_id: meetingId, file_path: path, file_name: d.file.name });
        if (insErr) {
          err = insErr;
          break;
        }
      }
      setUploadingDocs(false);
    }

    // Hapus lampiran yang dihapus pengguna dari draft (dibandingkan data asli)
    if (!err && editingId) {
      const original = meetings.find((m) => m.id === editingId);
      const removedAtt = (original?.attachments || []).filter(
        (oa) => !draft.attachments.some((da) => da.id === oa.id)
      );
      if (removedAtt.length > 0) {
        await supabase.storage.from(ATTACHMENTS_BUCKET).remove(removedAtt.map((r) => r.filePath));
        await supabase.from("meeting_attachments").delete().in("id", removedAtt.map((r) => r.id));
      }
    }

    // Unggah lampiran baru yang ditambahkan (punya properti .file)
    const newAttachments = draft.attachments.filter((d) => d.file);
    if (!err && newAttachments.length > 0) {
      setUploadingDocs(true);
      for (const d of newAttachments) {
        const ext = d.file.name.split(".").pop();
        const path = `${meetingId}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage.from(ATTACHMENTS_BUCKET).upload(path, d.file);
        if (upErr) {
          err = upErr;
          break;
        }
        const { error: insErr } = await supabase
          .from("meeting_attachments")
          .insert({ meeting_id: meetingId, file_path: path, file_name: d.file.name });
        if (insErr) {
          err = insErr;
          break;
        }
      }
      setUploadingDocs(false);
    }

    setSaving(false);

    if (err) {
      showToast("Gagal menyimpan: periksa koneksi Supabase");
      return;
    }

    await loadMeetings();
    showToast(editingId ? "Notulen diperbarui" : "Notulen tersimpan");
    setSelectedId(meetingId);
    setView("detail");
  }

  async function deleteMeeting(id) {
    const meeting = meetings.find((m) => m.id === id);
    if (meeting?.documents?.length) {
      await supabase.storage.from(DOCS_BUCKET).remove(meeting.documents.map((d) => d.filePath));
    }
    if (meeting?.attachments?.length) {
      await supabase.storage.from(ATTACHMENTS_BUCKET).remove(meeting.attachments.map((d) => d.filePath));
    }
    const { error } = await supabase.from("meetings").delete().eq("id", id);
    if (error) {
      showToast("Gagal menghapus notulen");
      return;
    }
    await loadMeetings();
    setView("list");
    showToast("Notulen dihapus");
  }

  async function downloadAllAsZip(meeting) {
    const totalFiles = meeting.documents.length + meeting.attachments.length;
    if (totalFiles === 0) {
      showToast("Belum ada dokumentasi atau lampiran untuk diunduh");
      return;
    }
    setZippingId(meeting.id);
    try {
      const zip = new JSZip();
      const docFolder = zip.folder("Dokumentasi");
      const attFolder = zip.folder("Lampiran");

      const usedNames = new Set();
      function uniqueName(folder, name) {
        let candidate = name || "berkas";
        let i = 1;
        while (usedNames.has(`${folder}/${candidate}`)) {
          const dot = name.lastIndexOf(".");
          candidate = dot > -1 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
          i++;
        }
        usedNames.add(`${folder}/${candidate}`);
        return candidate;
      }

      for (const d of meeting.documents) {
        const res = await fetch(d.url);
        const blob = await res.blob();
        docFolder.file(uniqueName("Dokumentasi", d.fileName || `foto-${d.id}.jpg`), blob);
      }
      for (const a of meeting.attachments) {
        const res = await fetch(a.url);
        const blob = await res.blob();
        attFolder.file(uniqueName("Lampiran", a.fileName || `lampiran-${a.id}`), blob);
      }

      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, `${meeting.title || "rapat"} - Dokumentasi & Lampiran.zip`);
    } catch (e) {
      showToast("Gagal membuat file ZIP");
    } finally {
      setZippingId(null);
    }
  }

  async function downloadCombinedPdf(meeting) {
    setMergingId(meeting.id);
    setMergeStatus("Menyiapkan...");
    try {
      const { skipped } = await exportMeetingToCombinedPdf(meeting, { onProgress: setMergeStatus });
      showToast(
        skipped > 0
          ? `PDF gabungan tersimpan (${skipped} berkas non-PDF/gambar ditandai, unduh terpisah lewat ZIP)`
          : "PDF gabungan tersimpan"
      );
    } catch (e) {
      showToast("Gagal membuat PDF gabungan");
    } finally {
      setMergingId(null);
      setMergeStatus("");
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return meetings.filter((m) => {
      if (categoryFilter !== "Semua" && m.category !== categoryFilter) return false;
      if (!q) return true;
      return [m.title, m.leader, m.agenda, m.discussion, m.attendees.map((a) => a.name).join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [meetings, search, categoryFilter]);

  const stats = useMemo(() => {
    const now = new Date();
    const thisMonth = meetings.filter((m) => {
      const d = new Date(m.date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    return { thisMonthCount: thisMonth.length };
  }, [meetings]);

  const selectedMeeting = meetings.find((m) => m.id === selectedId);

  const manualAttendees = draft.attendees.filter((a) => !ROSTER_NAMES.has(a.name));

  function toggleRosterPerson(person) {
    const exists = draft.attendees.some((a) => a.name === person.name);
    if (exists) {
      setDraft({ ...draft, attendees: draft.attendees.filter((a) => a.name !== person.name) });
    } else {
      setDraft({
        ...draft,
        attendees: [...draft.attendees, { id: `new-${crypto.randomUUID()}`, name: person.name, position: person.position }],
      });
    }
  }

  function toggleRosterGroup(roster, selectAll) {
    if (selectAll) {
      const toAdd = roster
        .filter((p) => !draft.attendees.some((a) => a.name === p.name))
        .map((p) => ({ id: `new-${crypto.randomUUID()}`, name: p.name, position: p.position }));
      setDraft({ ...draft, attendees: [...draft.attendees, ...toAdd] });
    } else {
      const rosterNames = new Set(roster.map((p) => p.name));
      setDraft({ ...draft, attendees: draft.attendees.filter((a) => !rosterNames.has(a.name)) });
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <div className="text-stone-400 text-sm tracking-wide">Memuat data…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-800">
      <div
        className="text-stone-50 relative overflow-hidden"
        style={{ background: "linear-gradient(135deg, #052e21 0%, #0b4a37 55%, #0f5c44 100%)" }}
      >
        <div
          className="absolute inset-0 opacity-[0.07] pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 20%, #ffffff 1px, transparent 1px), radial-gradient(circle at 60% 70%, #ffffff 1px, transparent 1px)",
            backgroundSize: "48px 48px, 64px 64px",
          }}
        />
        <div className="max-w-5xl mx-auto px-6 pt-7 pb-6 flex items-center justify-between relative">
          <div className="flex items-center gap-3.5">
            <img src={logo} alt="Logo RAPID" className="w-12 h-12 shrink-0 drop-shadow-lg" />
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-emerald-300 font-semibold">Pengadilan Agama Purwokerto</div>
              <h1 className="text-2xl font-extrabold leading-tight tracking-tight" style={{ fontFamily: "Merriweather, Georgia, serif" }}>RAPID</h1>
              <div className="text-[12px] text-emerald-200/90 leading-tight">Rapat Digital Terintegrasi</div>
            </div>
          </div>
          {isAdmin && (
            <button
              onClick={startNew}
              className="flex items-center gap-1.5 bg-emerald-400 hover:bg-emerald-300 text-emerald-950 font-semibold text-sm px-4 py-2.5 rounded-lg shadow-md shadow-emerald-900/30 transition-all hover:-translate-y-0.5"
            >
              <Plus size={16} /> Rapat Baru
            </button>
          )}
        </div>
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-between border-t border-white/10 relative">
          <div className="flex gap-1">
            {[
              { key: "home", label: "Beranda", icon: Home },
              ...(isAdmin ? [{ key: "dashboard", label: "Dasbor", icon: LayoutDashboard }] : []),
              { key: "list", label: "Arsip Notulen", icon: ClipboardList },
              { key: "calendar", label: "Kalender", icon: Calendar },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => setView(t.key)}
                className={`flex items-center gap-1.5 text-sm font-medium px-3.5 py-3 border-b-2 transition-colors ${
                  view === t.key || (t.key === "list" && (view === "detail" || view === "form"))
                    ? "border-emerald-400 text-emerald-300"
                    : "border-transparent text-emerald-200/70 hover:text-emerald-300"
                }`}
              >
                <t.icon size={14} /> {t.label}
              </button>
            ))}
          </div>
          <div className="py-1.5">
            {isAdmin ? (
              <button onClick={handleLogout} className="flex items-center gap-1.5 text-xs text-emerald-200/80 hover:text-white px-2 py-1">
                <LogOut size={13} /> Keluar
              </button>
            ) : (
              <button onClick={() => setShowLogin(true)} className="flex items-center gap-1.5 text-xs text-emerald-200/80 hover:text-white px-2 py-1">
                <LogIn size={13} /> Masuk sebagai Admin
              </button>
            )}
          </div>
        </div>
      </div>

      {showLogin && <LoginModal onClose={() => setShowLogin(false)} onSuccess={() => { setShowLogin(false); showToast("Berhasil masuk"); }} />}

      {loadError && (
        <div className="max-w-5xl mx-auto px-6 pt-3">
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded-md">
            <AlertCircle size={14} /> Tidak dapat terhubung ke Supabase. Periksa VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY di file .env.
          </div>
        </div>
      )}

      {view === "home" && (
        <HomeView
          isAdmin={isAdmin}
          meetings={meetings}
          onGoToArsip={() => setView("list")}
          onGoToKalender={() => setView("calendar")}
          onNewMeeting={startNew}
          onSelectMeeting={(id) => {
            setSelectedId(id);
            setView("detail");
          }}
        />
      )}

      {view !== "home" && (
      <div className="max-w-5xl mx-auto px-6 py-6">
        {view === "dashboard" && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <StatCard label="Rapat Bulan Ini" value={stats.thisMonthCount} icon={Calendar} />
              <StatCard label="Total Rapat Tercatat" value={meetings.length} icon={ClipboardList} />
            </div>

            <div className="bg-white rounded-lg border border-stone-200 p-4">
              <h3 className="text-sm font-semibold text-stone-700 mb-3">Rapat Terbaru</h3>
              {meetings.slice(0, 5).length === 0 ? (
                <p className="text-sm text-stone-400">Belum ada notulen tersimpan.</p>
              ) : (
                <div className="divide-y divide-stone-100">
                  {meetings.slice(0, 5).map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        setSelectedId(m.id);
                        setView("detail");
                      }}
                      className="w-full flex items-center justify-between py-2 text-left hover:text-emerald-800 group"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{m.title || "(tanpa judul)"}</div>
                        <div className="text-xs text-stone-400">{formatDate(m.date)}</div>
                      </div>
                      <ChevronRight size={14} className="text-stone-300 group-hover:text-emerald-800 shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {view === "calendar" && (
          <MeetingCalendar
            meetings={meetings}
            onSelectMeeting={(id) => {
              setSelectedId(id);
              setView("detail");
            }}
          />
        )}

        {view === "list" && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Cari judul, topik, atau peserta..."
                  className="w-full pl-10 pr-3 py-2.5 text-sm border border-stone-300 rounded-xl bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-800/40 focus:border-emerald-800"
                />
              </div>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="text-sm border border-stone-300 rounded-xl px-3 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-800/40 focus:border-emerald-800 bg-white"
              >
                <option value="Semua">Semua Kategori</option>
                {MEETING_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {filtered.length === 0 ? (
              <div className="text-center py-16 text-stone-400 text-sm">
                {meetings.length === 0 ? 'Belum ada notulen. Klik "Rapat Baru" untuk memulai.' : "Tidak ada hasil yang cocok."}
              </div>
            ) : (
              <div className="space-y-2">
                {filtered.map((m) => {
                  return (
                    <button
                      key={m.id}
                      onClick={() => {
                        setSelectedId(m.id);
                        setView("detail");
                      }}
                      className="w-full text-left bg-white border border-stone-200/70 rounded-2xl p-4 shadow-sm hover:shadow-md hover:border-emerald-800/30 hover:-translate-y-0.5 transition-all flex items-center justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-medium text-stone-800 truncate">{m.title || "(tanpa judul)"}</div>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${CATEGORY_COLORS[m.category] || CATEGORY_COLORS.Lainnya}`}>
                            {m.category}
                          </span>
                        </div>
                        <div className="text-xs text-stone-400 mt-0.5">
                          {formatDate(m.date)} {m.leader && `· Dipimpin oleh ${m.leader}`}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-3">
                        {m.attendees.length > 0 && (
                          <span className="text-xs text-stone-400 flex items-center gap-1">
                            <UserCheck size={12} /> {m.attendees.length}
                          </span>
                        )}
                        {m.documents.length > 0 && (
                          <span className="text-xs text-stone-400 flex items-center gap-1">
                            <ImageIcon size={12} /> {m.documents.length}
                          </span>
                        )}
                        {m.attachments.length > 0 && (
                          <span className="text-xs text-stone-400 flex items-center gap-1">
                            <Paperclip size={12} /> {m.attachments.length}
                          </span>
                        )}
                        <ChevronRight size={16} className="text-stone-300" />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {view === "form" && (
          <div className="bg-white border border-stone-200/70 rounded-2xl p-6 space-y-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-stone-800" style={{ fontFamily: "Merriweather, Georgia, serif" }}>
                {editingId ? "Edit Notulen" : "Notulen Rapat Baru"}
              </h2>
              <button onClick={() => setView(editingId ? "detail" : "list")} className="text-stone-400 hover:text-stone-600">
                <X size={18} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Judul Rapat">
                <input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="Contoh: Rapat Koordinasi Kesekretariatan"
                  className="input"
                />
              </Field>
              <Field label="Tanggal">
                <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} className="input" />
              </Field>
              <Field label="Pemimpin Rapat">
                <input value={draft.leader} onChange={(e) => setDraft({ ...draft, leader: e.target.value })} className="input" />
              </Field>
              <Field label="Kategori Rapat">
                <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className="input">
                  {MEETING_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Agenda">
              <textarea value={draft.agenda} onChange={(e) => setDraft({ ...draft, agenda: e.target.value })} rows={2} className="input resize-none" />
            </Field>
            <Field label="Pembahasan">
              <textarea value={draft.discussion} onChange={(e) => setDraft({ ...draft, discussion: e.target.value })} rows={4} className="input resize-none" />
            </Field>

            {/* Daftar Hadir */}
            <div>
              <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide flex items-center gap-1.5 mb-2">
                <UserCheck size={13} /> Daftar Hadir
                <span className="text-emerald-700 font-medium normal-case">({draft.attendees.filter((a) => a.name.trim()).length} dicentang)</span>
              </label>

              <RosterGroup
                title="Hakim"
                roster={HAKIM_ROSTER}
                checkedNames={new Set(draft.attendees.map((a) => a.name))}
                onToggle={toggleRosterPerson}
                onToggleAll={(selectAll) => toggleRosterGroup(HAKIM_ROSTER, selectAll)}
              />
              <RosterGroup
                title="Pegawai"
                roster={PEGAWAI_ROSTER}
                checkedNames={new Set(draft.attendees.map((a) => a.name))}
                onToggle={toggleRosterPerson}
                onToggleAll={(selectAll) => toggleRosterGroup(PEGAWAI_ROSTER, selectAll)}
              />

              {/* Tamu / peserta luar roster */}
              <div className="mt-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-stone-500">Tamu / Peserta Luar (opsional)</span>
                  <button
                    onClick={() => setDraft({ ...draft, attendees: [...draft.attendees, emptyAttendee()] })}
                    className="text-xs text-emerald-800 hover:underline flex items-center gap-1"
                  >
                    <Plus size={12} /> Tambah
                  </button>
                </div>
                <div className="space-y-2">
                  {manualAttendees.map((att) => {
                    const idx = draft.attendees.findIndex((a) => a.id === att.id);
                    return (
                      <div key={att.id} className="flex gap-2 items-start bg-stone-50 border border-stone-200 rounded-md p-2.5">
                        <input
                          value={att.name}
                          onChange={(e) => {
                            const items = [...draft.attendees];
                            items[idx] = { ...att, name: e.target.value };
                            setDraft({ ...draft, attendees: items });
                          }}
                          placeholder="Nama tamu"
                          className="flex-1 text-sm px-2 py-1.5 border border-stone-300 rounded focus:outline-none focus:ring-1 focus:ring-emerald-800"
                        />
                        <input
                          value={att.position}
                          onChange={(e) => {
                            const items = [...draft.attendees];
                            items[idx] = { ...att, position: e.target.value };
                            setDraft({ ...draft, attendees: items });
                          }}
                          placeholder="Instansi / keterangan"
                          className="w-48 text-sm px-2 py-1.5 border border-stone-300 rounded focus:outline-none focus:ring-1 focus:ring-emerald-800"
                        />
                        <button
                          onClick={() => setDraft({ ...draft, attendees: draft.attendees.filter((a) => a.id !== att.id) })}
                          className="text-stone-400 hover:text-red-500 p-1.5"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Dokumentasi Rapat */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide flex items-center gap-1.5">
                  <Camera size={13} /> Dokumentasi Rapat
                </label>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="text-xs text-emerald-800 hover:underline flex items-center gap-1"
                >
                  <Upload size={12} /> Unggah Foto
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    const entries = files.map((file) => ({
                      id: `new-${crypto.randomUUID()}`,
                      file,
                      fileName: file.name,
                      url: URL.createObjectURL(file),
                    }));
                    setDraft((d) => ({ ...d, documents: [...d.documents, ...entries] }));
                    e.target.value = "";
                  }}
                />
              </div>
              {draft.documents.length === 0 ? (
                <p className="text-sm text-stone-400">Belum ada foto dokumentasi.</p>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {draft.documents.map((doc) => (
                    <div key={doc.id} className="relative group aspect-square rounded-md overflow-hidden border border-stone-200 bg-stone-100">
                      <img src={doc.url} alt={doc.fileName} className="w-full h-full object-cover" />
                      <button
                        onClick={() => setDraft({ ...draft, documents: draft.documents.filter((d) => d.id !== doc.id) })}
                        className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Lampiran Rapat */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide flex items-center gap-1.5">
                  <Paperclip size={13} /> Lampiran Rapat
                </label>
                <button
                  onClick={() => attachmentInputRef.current?.click()}
                  className="text-xs text-emerald-800 hover:underline flex items-center gap-1"
                >
                  <Upload size={12} /> Unggah Lampiran
                </button>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    const entries = files.map((file) => ({
                      id: `new-${crypto.randomUUID()}`,
                      file,
                      fileName: file.name,
                      url: URL.createObjectURL(file),
                    }));
                    setDraft((d) => ({ ...d, attachments: [...d.attachments, ...entries] }));
                    e.target.value = "";
                  }}
                />
              </div>
              <p className="text-xs text-stone-400 mb-2">Undangan, surat, atau dokumen pendukung lain (PDF, Word, dll).</p>
              {draft.attachments.length === 0 ? (
                <p className="text-sm text-stone-400">Belum ada lampiran.</p>
              ) : (
                <div className="space-y-1.5">
                  {draft.attachments.map((att) => (
                    <div key={att.id} className="flex items-center gap-2 bg-stone-50 border border-stone-200 rounded-md px-3 py-2">
                      <FileText size={15} className="text-stone-400 shrink-0" />
                      <span className="text-sm text-stone-700 truncate flex-1">{att.fileName}</span>
                      <button
                        onClick={() => setDraft({ ...draft, attachments: draft.attachments.filter((a) => a.id !== att.id) })}
                        className="text-stone-400 hover:text-red-500 p-1"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-stone-100">
              <button onClick={() => setView(editingId ? "detail" : "list")} className="px-4 py-2 text-sm text-stone-600 hover:bg-stone-100 rounded-md">
                Batal
              </button>
              <button
                onClick={saveDraft}
                disabled={saving}
                className="px-5 py-2.5 text-sm bg-emerald-800 hover:bg-emerald-900 disabled:opacity-60 text-white rounded-lg font-semibold shadow-sm hover:shadow transition-all"
              >
                {saving ? (uploadingDocs ? "Mengunggah foto..." : "Menyimpan...") : "Simpan Notulen"}
              </button>
            </div>
          </div>
        )}

        {view === "detail" && selectedMeeting && (
          <div className="bg-white border border-stone-200/70 rounded-2xl p-6 space-y-5 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-semibold text-stone-800" style={{ fontFamily: "Merriweather, Georgia, serif" }}>
                    {selectedMeeting.title}
                  </h2>
                  <span className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${CATEGORY_COLORS[selectedMeeting.category] || CATEGORY_COLORS.Lainnya}`}>
                    {selectedMeeting.category}
                  </span>
                </div>
                <p className="text-sm text-stone-400 mt-0.5">
                  {formatDate(selectedMeeting.date)} {selectedMeeting.leader && `· Dipimpin oleh ${selectedMeeting.leader}`}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => exportMeetingToDocx(selectedMeeting)}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 border border-stone-300 rounded-lg hover:bg-stone-50 hover:border-stone-400 text-stone-600 transition-colors"
                >
                  <FileDown size={13} /> Ekspor ke Word
                </button>
                {(selectedMeeting.documents.length + selectedMeeting.attachments.length) > 0 && (
                  <button
                    onClick={() => downloadAllAsZip(selectedMeeting)}
                    disabled={zippingId === selectedMeeting.id}
                    className="flex items-center gap-1 text-xs px-2.5 py-1.5 border border-stone-300 rounded-lg hover:bg-stone-50 hover:border-stone-400 text-stone-600 transition-colors disabled:opacity-60"
                  >
                    <Archive size={13} /> {zippingId === selectedMeeting.id ? "Menyiapkan..." : "Unduh Semua (ZIP)"}
                  </button>
                )}
                <button
                  onClick={() => downloadCombinedPdf(selectedMeeting)}
                  disabled={mergingId === selectedMeeting.id}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 border border-stone-300 rounded-lg hover:bg-stone-50 hover:border-stone-400 text-stone-600 transition-colors disabled:opacity-60"
                >
                  <FileText size={13} /> {mergingId === selectedMeeting.id ? mergeStatus || "Menyiapkan..." : "Unduh PDF Gabungan"}
                </button>
                {isAdmin && (
                  <>
                    <button onClick={() => startEdit(selectedMeeting)} className="text-xs px-2.5 py-1.5 border border-stone-300 rounded-lg hover:bg-stone-50 hover:border-stone-400 text-stone-600 transition-colors">
                      Edit
                    </button>
                    <button onClick={() => deleteMeeting(selectedMeeting.id)} className="text-xs px-2.5 py-1.5 border border-red-200 text-red-600 rounded-lg hover:bg-red-50 transition-colors">
                      Hapus
                    </button>
                  </>
                )}
              </div>
            </div>

            {selectedMeeting.attendees.length > 0 && (
              <div className="text-sm text-stone-500">
                <span className="font-medium text-stone-600">{selectedMeeting.attendees.length} peserta hadir</span>
              </div>
            )}

            <DetailBlock label="Agenda" text={selectedMeeting.agenda} />
            <DetailBlock label="Pembahasan" text={selectedMeeting.discussion} />

            <div>
              <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <UserCheck size={13} /> Daftar Hadir
              </label>
              {selectedMeeting.attendees.length === 0 ? (
                <p className="text-sm text-stone-400">Belum ada daftar hadir dicatat.</p>
              ) : (
                <div className="border border-stone-200 rounded-md overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-stone-50 text-stone-500 text-xs uppercase tracking-wide">
                        <th className="text-left px-3 py-1.5 w-10">No</th>
                        <th className="text-left px-3 py-1.5">Nama</th>
                        <th className="text-left px-3 py-1.5">Jabatan / Unit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedMeeting.attendees.map((a, idx) => (
                        <tr key={a.id} className="border-t border-stone-100">
                          <td className="px-3 py-1.5 text-stone-400">{idx + 1}</td>
                          <td className="px-3 py-1.5 text-stone-800">{a.name}</td>
                          <td className="px-3 py-1.5 text-stone-500">{a.position || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <ImageIcon size={13} /> Dokumentasi Rapat
              </label>
              {selectedMeeting.documents.length === 0 ? (
                <p className="text-sm text-stone-400">Belum ada foto dokumentasi.</p>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {selectedMeeting.documents.map((doc) => (
                    <button
                      key={doc.id}
                      onClick={() => setLightboxUrl(doc.url)}
                      className="aspect-square rounded-md overflow-hidden border border-stone-200 bg-stone-100 hover:opacity-90"
                    >
                      <img src={doc.url} alt={doc.fileName} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Paperclip size={13} /> Lampiran Rapat
              </label>
              {selectedMeeting.attachments.length === 0 ? (
                <p className="text-sm text-stone-400">Belum ada lampiran.</p>
              ) : (
                <div className="space-y-1.5">
                  {selectedMeeting.attachments.map((att) => (
                    <a
                      key={att.id}
                      href={att.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 bg-stone-50 border border-stone-200 rounded-md px-3 py-2 hover:border-emerald-800/40"
                    >
                      <FileText size={15} className="text-stone-400 shrink-0" />
                      <span className="text-sm text-stone-700 truncate flex-1">{att.fileName}</span>
                      <Download size={14} className="text-stone-400 shrink-0" />
                    </a>
                  ))}
                </div>
              )}
            </div>

            <button onClick={() => setView("list")} className="text-sm text-emerald-800 hover:underline">
              ← Kembali ke arsip
            </button>
          </div>
        )}
      </div>
      )}

      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-6 cursor-zoom-out"
        >
          <img src={lightboxUrl} alt="Dokumentasi" className="max-w-full max-h-full rounded-md shadow-2xl" />
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 bg-emerald-900 text-white text-sm px-4 py-2 rounded-md shadow-lg">{toast}</div>
      )}

      <style>{`
        .input {
          width: 100%;
          font-size: 0.875rem;
          padding: 0.6rem 0.85rem;
          border: 1px solid #d6d3d1;
          border-radius: 0.65rem;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .input:focus {
          border-color: #065f46;
          box-shadow: 0 0 0 3px rgba(6,95,70,0.12);
        }
      `}</style>
    </div>
  );
}

function HomeView({ isAdmin, meetings, onGoToArsip, onGoToKalender, onNewMeeting, onSelectMeeting }) {
  const recent = meetings.slice(0, 3);

  const features = [
    {
      icon: ClipboardList,
      title: "Notulen Digital",
      desc: "Catat agenda, pembahasan, dan hasil rapat secara terstruktur — tersimpan rapi dan mudah dicari kembali kapan saja.",
    },
    {
      icon: UserCheck,
      title: "Daftar Hadir",
      desc: "Tinggal centang dari daftar Hakim & Pegawai, tanpa perlu tulis nama manual satu per satu.",
    },
    {
      icon: Camera,
      title: "Dokumentasi & Lampiran",
      desc: "Unggah foto kegiatan dan dokumen pendukung seperti undangan, semuanya tersimpan bersama notulennya.",
    },
    {
      icon: Calendar,
      title: "Kalender Rapat",
      desc: "Lihat jadwal rapat mendatang dan telusuri riwayat rapat yang sudah berlangsung dalam satu tampilan.",
    },
  ];

  return (
    <div>
      {/* HERO */}
      <div
        className="relative overflow-hidden text-stone-50"
        style={{ background: "linear-gradient(135deg, #052e21 0%, #0b4a37 55%, #0f5c44 100%)" }}
      >
        <div
          className="absolute inset-0 opacity-[0.06] pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle at 15% 25%, #ffffff 1px, transparent 1px), radial-gradient(circle at 75% 65%, #ffffff 1px, transparent 1px)",
            backgroundSize: "44px 44px, 60px 60px",
          }}
        />
        <div className="max-w-5xl mx-auto px-6 py-16 md:py-20 grid md:grid-cols-2 gap-10 items-center relative">
          <div>
            <div className="inline-block text-[11px] uppercase tracking-[0.2em] text-emerald-300 font-semibold bg-white/5 border border-white/10 rounded-full px-3 py-1 mb-4">
              Pengadilan Agama Purwokerto
            </div>
            <h1 className="text-3xl md:text-4xl font-extrabold leading-tight tracking-tight mb-4" style={{ fontFamily: "Merriweather, Georgia, serif" }}>
              Solusi Terintegrasi untuk Rapat &amp; Notulen Anda
            </h1>
            <p className="text-emerald-100/80 text-sm md:text-base leading-relaxed mb-7 max-w-md">
              RAPID menyatukan notulen, daftar hadir, dokumentasi, dan lampiran rapat dalam satu
              arsip digital yang rapi, aman, dan mudah ditelusuri kembali kapan saja.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={onGoToArsip}
                className="flex items-center gap-1.5 bg-emerald-400 hover:bg-emerald-300 text-emerald-950 font-semibold text-sm px-5 py-3 rounded-lg shadow-md shadow-emerald-900/30 transition-all hover:-translate-y-0.5"
              >
                Lihat Arsip Notulen <ArrowRight size={16} />
              </button>
              <button
                onClick={onGoToKalender}
                className="flex items-center gap-1.5 text-sm font-medium text-emerald-100 hover:text-white px-4 py-3 rounded-lg border border-white/20 hover:border-white/40 transition-colors"
              >
                <Calendar size={15} /> Lihat Kalender
              </button>
              {isAdmin && (
                <button
                  onClick={onNewMeeting}
                  className="flex items-center gap-1.5 text-sm font-medium text-emerald-100 hover:text-white px-4 py-3 rounded-lg border border-white/20 hover:border-white/40 transition-colors"
                >
                  <Plus size={15} /> Rapat Baru
                </button>
              )}
            </div>
          </div>

          {/* Mockup card */}
          <div className="relative hidden md:block h-72">
            <div className="absolute top-6 right-2 w-56 rotate-3 bg-white rounded-2xl shadow-2xl p-4 text-stone-800">
              <div className="flex items-center gap-1.5 mb-3">
                <span className="w-2 h-2 rounded-full bg-red-300" />
                <span className="w-2 h-2 rounded-full bg-amber-300" />
                <span className="w-2 h-2 rounded-full bg-emerald-300" />
              </div>
              <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                <span className="font-semibold text-sm">Rapat Koordinasi</span>
                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700">Koordinasi</span>
              </div>
              <div className="text-[11px] text-stone-400 mb-3">12 Agustus 2026 · Ketua PA</div>
              <div className="space-y-1.5">
                {["Evaluasi capaian triwulan", "Rencana kerja bulan depan", "Pembagian tugas piket"].map((t) => (
                  <div key={t} className="flex items-center gap-1.5 text-[11px] text-stone-600">
                    <CheckCircle2 size={12} className="text-emerald-600 shrink-0" /> {t}
                  </div>
                ))}
              </div>
            </div>
            <div className="absolute bottom-4 left-2 w-40 -rotate-6 bg-white rounded-xl shadow-xl p-3 text-stone-800">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-stone-600 mb-1.5">
                <UserCheck size={13} className="text-emerald-700" /> Daftar Hadir
              </div>
              <div className="text-lg font-extrabold text-stone-800">18<span className="text-xs font-medium text-stone-400"> / 22 hadir</span></div>
            </div>
          </div>
        </div>
      </div>

      {/* FITUR */}
      <div className="max-w-5xl mx-auto px-6 py-14">
        <div className="text-center mb-10">
          <h2 className="text-xl font-bold text-stone-800">
            FITUR <span className="text-emerald-700">RAPID</span>
          </h2>
          <p className="text-sm text-stone-400 mt-1">Semua kebutuhan pencatatan rapat, dalam satu aplikasi</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {features.map((f) => (
            <div key={f.title} className="bg-white border border-stone-200/70 rounded-2xl p-5 text-center shadow-sm hover:shadow-md transition-shadow">
              <div className="w-14 h-14 rounded-full bg-emerald-50 text-emerald-800 flex items-center justify-center mx-auto mb-3">
                <f.icon size={22} />
              </div>
              <div className="text-sm font-semibold text-stone-800 mb-1">{f.title}</div>
              <div className="text-xs text-stone-500 leading-relaxed">{f.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* RAPAT TERBARU */}
      {recent.length > 0 && (
        <div className="max-w-5xl mx-auto px-6 pb-16">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-stone-700">Rapat Terbaru</h2>
            <button onClick={onGoToArsip} className="text-xs text-emerald-800 hover:underline flex items-center gap-1">
              Lihat semua <ArrowRight size={12} />
            </button>
          </div>
          <div className="grid md:grid-cols-3 gap-4">
            {recent.map((m) => (
              <button
                key={m.id}
                onClick={() => onSelectMeeting(m.id)}
                className="text-left bg-white border border-stone-200/70 rounded-2xl p-4 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all"
              >
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${CATEGORY_COLORS[m.category] || CATEGORY_COLORS.Lainnya}`}>
                  {m.category}
                </span>
                <div className="font-medium text-stone-800 mt-2 truncate">{m.title || "(tanpa judul)"}</div>
                <div className="text-xs text-stone-400 mt-0.5">{formatDate(m.date)}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MeetingCalendar({ meetings, onSelectMeeting }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(null);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const meetingsByDate = useMemo(() => {
    const map = {};
    meetings.forEach((m) => {
      if (!map[m.date]) map[m.date] = [];
      map[m.date].push(m);
    });
    return map;
  }, [meetings]);

  const upcoming = useMemo(() => {
    const todayStr = todayLocalStr();
    return meetings
      .filter((m) => m.date >= todayStr)
      .sort((a, b) => (a.date > b.date ? 1 : -1))
      .slice(0, 8);
  }, [meetings]);

  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay(); // 0 = Minggu
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const monthLabel = cursor.toLocaleDateString("id-ID", { month: "long", year: "numeric" });
  const weekdayLabels = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

  function dateStr(d) {
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  const selectedMeetings = selectedDay ? meetingsByDate[selectedDay] || [] : [];

  return (
    <div className="space-y-4">
      <div className="bg-white border border-stone-200/70 rounded-2xl p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => {
              setCursor(new Date(year, month - 1, 1));
              setSelectedDay(null);
            }}
            className="p-1.5 rounded hover:bg-stone-100 text-stone-500"
          >
            <ChevronLeft size={16} />
          </button>
          <h3 className="text-sm font-semibold text-stone-700 capitalize">{monthLabel}</h3>
          <button
            onClick={() => {
              setCursor(new Date(year, month + 1, 1));
              setSelectedDay(null);
            }}
            className="p-1.5 rounded hover:bg-stone-100 text-stone-500"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-stone-400 mb-1">
          {weekdayLabels.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, idx) => {
            if (d === null) return <div key={`empty-${idx}`} />;
            const ds = dateStr(d);
            const dayMeetings = meetingsByDate[ds] || [];
            const isToday = ds === todayLocalStr();
            const isSelected = ds === selectedDay;
            return (
              <button
                key={ds}
                onClick={() => setSelectedDay(dayMeetings.length ? ds : null)}
                className={`aspect-square rounded-md flex flex-col items-center justify-center text-xs relative ${
                  isSelected
                    ? "bg-emerald-800 text-white"
                    : isToday
                    ? "bg-emerald-50 text-emerald-800 font-semibold"
                    : dayMeetings.length
                    ? "hover:bg-stone-100 text-stone-700"
                    : "text-stone-400"
                }`}
              >
                {d}
                {dayMeetings.length > 0 && (
                  <span className={`w-1.5 h-1.5 rounded-full mt-0.5 ${isSelected ? "bg-white" : "bg-emerald-600"}`} />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {selectedDay && selectedMeetings.length > 0 && (
        <div className="bg-white border border-stone-200/70 rounded-2xl p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-stone-700 mb-2">{formatDate(selectedDay)}</h3>
          <div className="space-y-1.5">
            {selectedMeetings.map((m) => (
              <button
                key={m.id}
                onClick={() => onSelectMeeting(m.id)}
                className="w-full flex items-center justify-between text-left p-2 rounded hover:bg-stone-50"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${CATEGORY_COLORS[m.category] || CATEGORY_COLORS.Lainnya}`}>
                    {m.category}
                  </span>
                  <span className="text-sm text-stone-800 truncate">{m.title || "(tanpa judul)"}</span>
                </div>
                <ChevronRight size={14} className="text-stone-300 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white border border-stone-200/70 rounded-2xl p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-stone-700 mb-3">Rapat Mendatang</h3>
        {upcoming.length === 0 ? (
          <p className="text-sm text-stone-400">Tidak ada rapat terjadwal ke depan.</p>
        ) : (
          <div className="divide-y divide-stone-100">
            {upcoming.map((m) => (
              <button
                key={m.id}
                onClick={() => onSelectMeeting(m.id)}
                className="w-full flex items-center justify-between py-2 text-left hover:text-emerald-800 group"
              >
                <div className="min-w-0 flex items-center gap-2">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${CATEGORY_COLORS[m.category] || CATEGORY_COLORS.Lainnya}`}>
                    {m.category}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{m.title || "(tanpa judul)"}</div>
                    <div className="text-xs text-stone-400">{formatDate(m.date)}</div>
                  </div>
                </div>
                <ChevronRight size={14} className="text-stone-300 group-hover:text-emerald-800 shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, accent }) {
  const accentMap = {
    default: "text-emerald-800 bg-emerald-50",
    amber: "text-amber-700 bg-amber-50",
    red: "text-red-600 bg-red-50",
  };
  const cls = accentMap[accent] || accentMap.default;
  return (
    <div className="bg-white border border-stone-200/70 rounded-2xl p-5 flex items-center gap-4 shadow-sm hover:shadow-md transition-shadow">
      <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 ${cls}`}>
        <Icon size={20} />
      </div>
      <div>
        <div className="text-2xl font-extrabold text-stone-800 leading-tight">{value}</div>
        <div className="text-xs text-stone-400 font-medium">{label}</div>
      </div>
    </div>
  );
}

const AUTH_EMAIL_DOMAIN = "rapid.internal";

function usernameToEmail(username) {
  const clean = username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return `${clean}@${AUTH_EMAIL_DOMAIN}`;
}

function LoginModal({ onClose, onSuccess }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setError("");
    if (!username.trim() || !password) {
      setError("Username dan password wajib diisi.");
      return;
    }
    setLoading(true);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    });
    setLoading(false);
    if (err) {
      setError("Username atau password salah.");
      return;
    }
    onSuccess();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleLogin}
        className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-stone-800" style={{ fontFamily: "Merriweather, Georgia, serif" }}>
            Masuk sebagai Admin
          </h2>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-stone-400 -mt-2">Hanya admin yang bisa menambah/mengubah notulen. Publik tetap bisa melihat arsip tanpa login.</p>

        <div>
          <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-1 block">Username</label>
          <input
            type="text"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="input"
            autoFocus
            autoCapitalize="none"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-1 block">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 text-sm bg-emerald-800 hover:bg-emerald-900 disabled:opacity-60 text-white rounded-lg font-semibold shadow-sm hover:shadow transition-all"
        >
          {loading ? "Memeriksa..." : "Masuk"}
        </button>
      </form>
    </div>
  );
}

function RosterGroup({ title, roster, checkedNames, onToggle, onToggleAll }) {
  const checkedCount = roster.filter((p) => checkedNames.has(p.name)).length;
  const allChecked = checkedCount === roster.length;
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-stone-500">
          {title} <span className="text-stone-400">({checkedCount}/{roster.length})</span>
        </span>
        <button onClick={() => onToggleAll(!allChecked)} className="text-xs text-emerald-800 hover:underline">
          {allChecked ? "Kosongkan" : "Pilih Semua"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5 bg-stone-50 border border-stone-200 rounded-md p-2.5">
        {roster.map((person) => {
          const checked = checkedNames.has(person.name);
          return (
            <label
              key={person.name}
              className={`flex items-start gap-2 text-sm px-2 py-1.5 rounded cursor-pointer ${checked ? "bg-emerald-50" : "hover:bg-stone-100"}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(person)}
                className="mt-0.5 accent-emerald-700"
              />
              <span className="min-w-0">
                <span className="block text-stone-800 leading-tight">{person.name}</span>
                <span className="block text-xs text-stone-400 leading-tight">{person.position}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-1 block">{label}</label>
      {children}
    </div>
  );
}

function DetailBlock({ label, text }) {
  return (
    <div>
      <label className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-1 block">{label}</label>
      <p className="text-sm text-stone-700 whitespace-pre-wrap">{text || "-"}</p>
    </div>
  );
}
