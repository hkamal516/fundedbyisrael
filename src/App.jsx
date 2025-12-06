import React, { useEffect, useMemo, useState } from "react";

// NOTE FOR HASSAN
// -----------------
// This is a single-page React app for fundedbyisrael.com.
//
// How it’s designed to work once you export it:
// - Put your two CSV files in a public "data" folder in your project:
//     /public/data/Money from Pro-Israel to US Representatives, 1990-2024.csv
//     /public/data/Money from Pro-Israel to US Senators, 1990-2024.csv
// - Deploy on Vercel (or similar). The app will fetch and parse those CSVs
//   at runtime, build a unified dataset, and power the screener + detail pages.
// - In the canvas / sandbox preview environment, those CSV paths are not
//   available, so the app will *gracefully* fall back to a small in‑memory
//   sample dataset. This is *not* treated as a hard error.
//
// Images / headshots
// -------------------
// There is a `photoUrl` property wired into the components. Right now it is
// undefined for all rows (including the fallback sample), so the UI falls back
// to initials in a circle. Once you have a mapping of member → image URL
// (e.g., via a JSON file or added column), you can:
//   - extend `normalizeCsvRow` to read that field, or
//   - merge an external lookup table, and
// any member with `photoUrl` set will automatically display their photo in the
// table + detail view.
//
// Later, if you want, we can evolve this into a Next.js app with real
// file-based routes for each member for even stronger SEO. For now this
// SPA version already creates clean /member/[slug] URLs using
// window.history.pushState + document.title changes.

// ---------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0]
    .split(",")
    .map((h) => h.replace(/^"|"$/g, ""));

  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, ""));
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

function parseAmount(amountStr) {
  if (!amountStr) return 0;
  const cleaned = amountStr.replace(/[$,]/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : 0;
}

function extractPartyFromName(name) {
  if (!name) return "Unknown";
  const match = name.match(/\(([A-Z]+)(?:-[A-Z]{2})?\)/);
  if (!match) return "Unknown";
  const code = match[1];
  if (code.startsWith("D")) return "Democratic";
  if (code.startsWith("R")) return "Republican";
  if (code.startsWith("I")) return "Independent";
  return "Other";
}

function cleanDisplayName(name) {
  if (!name) return "";
  return name.replace(/\s*\([^)]+\)\s*$/, "");
}

function slugify(name, chamber) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
  return `${base}-${chamber}`;
}

function formatCurrency(amount) {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function computePercentileRank(sortedByAmountDesc, member) {
  const n = sortedByAmountDesc.length;
  if (!n) return 0;
  const index = sortedByAmountDesc.findIndex((m) => m.id === member.id);
  if (index === -1) return 0;
  const percentileFromTop = ((index + 1) / n) * 100;
  return Math.round(percentileFromTop);
}

function getSeverityLabel(amount, chamberMax) {
  if (amount <= 0)
    return {
      label: "No AIPAC money",
      color: "bg-emerald-100 text-emerald-800",
    };
  const ratio = amount / chamberMax;
  if (ratio > 0.5)
    return {
      label: "Extremely high funding",
      color: "bg-red-100 text-red-800",
    };
  if (ratio > 0.2)
    return {
      label: "Very high funding",
      color: "bg-orange-100 text-orange-800",
    };
  if (ratio > 0.05)
    return {
      label: "Moderate funding",
      color: "bg-amber-100 text-amber-800",
    };
  return {
    label: "Low but present funding",
    color: "bg-yellow-100 text-yellow-800",
  };
}

// ---------------------------------------------------------------------
// Sample fallback data for preview (used when CSVs cannot be fetched)
// ---------------------------------------------------------------------

const FALLBACK_ROWS = [
  {
    id: "bell-wesley-house",
    nameRaw: "Bell Wesley (D-MO)",
    name: "Wesley Bell",
    chamber: "house",
    state: "Missouri",
    party: "Democratic",
    amount: 2744534,
  },
  {
    id: "latimer-george-house",
    nameRaw: "Latimer George (D-NY)",
    name: "George Latimer",
    chamber: "house",
    state: "New York",
    party: "Democratic",
    amount: 2538736,
  },
  {
    id: "menendez-robert-house",
    nameRaw: "Menendez Robert (I-NJ)",
    name: "Robert Menendez",
    chamber: "house",
    state: "New Jersey",
    party: "Independent",
    amount: 2507647,
  },
  {
    id: "biden-joe-senate",
    nameRaw: "Biden Joe (D)",
    name: "Joe Biden",
    chamber: "senate",
    state: "Delaware",
    party: "Democratic",
    amount: 4226576,
  },
  {
    id: "clinton-hillary-senate",
    nameRaw: "Clinton Hillary (D-NY)",
    name: "Hillary Clinton",
    chamber: "senate",
    state: "New York",
    party: "Democratic",
    amount: 2352302,
  },
];

// ---------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------

const App = () => {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadWarning, setLoadWarning] = useState(null);

  const [chamberFilter, setChamberFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [partyFilter, setPartyFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [sortKey, setSortKey] = useState("amountDesc");

  const [selectedMemberId, setSelectedMemberId] = useState(null);
  const [showDonateModal, setShowDonateModal] = useState(false);

  const applyFallback = (reason) => {
    const withRanks = addRanks(FALLBACK_ROWS);
    setMembers(withRanks);
    setLoading(false);
    if (reason) {
      console.warn("CSV data unavailable, using fallback sample:", reason);
      setLoadWarning(
        "CSV files could not be loaded in this environment. Showing a small sample dataset instead."
      );
    }
  };

  useEffect(() => {
    let cancelled = false;

    async function loadAll() {
      try {
        const [repsResp, sensResp] = await Promise.allSettled([
          fetch(
            "/data/Money from Pro-Israel to US Representatives, 1990-2024.csv"
          ),
          fetch("/data/Money from Pro-Israel to US Senators, 1990-2024.csv"),
        ]);

        if (cancelled) return;

        const repsOk =
          repsResp.status === "fulfilled" && repsResp.value && repsResp.value.ok;
        const sensOk =
          sensResp.status === "fulfilled" && sensResp.value && sensResp.value.ok;

        if (!repsOk || !sensOk) {
          applyFallback("One or both CSV HTTP responses were not OK.");
          return;
        }

        const [repsText, sensText] = await Promise.all([
          repsResp.value.text(),
          sensResp.value.text(),
        ]);

        if (cancelled) return;

        const repsRows = parseCsv(repsText);
        const sensRows = parseCsv(sensText);

        const normalized = [
          ...repsRows.map((row) => normalizeCsvRow(row, "house")),
          ...sensRows.map((row) => normalizeCsvRow(row, "senate")),
        ].filter((m) => m.name);

        const withRanks = addRanks(normalized);
        setMembers(withRanks);
        setLoading(false);
        setLoadWarning(null);
      } catch (err) {
        if (cancelled) return;
        applyFallback(err?.message || "Unexpected error while loading CSVs.");
      }
    }

    loadAll();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!members.length) return;
    const path = window.location.pathname;
    const match = path.match(/^\/member\/([^/]+)/);
    if (match) {
      const slug = match[1];
      const found = members.find((m) => m.slug === slug);
      if (found) {
        setSelectedMemberId(found.id);
      }
    }
  }, [members]);

  const selectedMember = useMemo(
    () => members.find((m) => m.id === selectedMemberId) || null,
    [members, selectedMemberId]
  );

  useEffect(() => {
    if (selectedMember) {
      document.title = `${selectedMember.name} | fundedbyisrael.com`;
    } else {
      document.title = "fundedbyisrael.com | AIPAC Contribution Screener";
    }
  }, [selectedMember]);

  const stateOptions = useMemo(() => {
    const set = new Set();
    members.forEach((m) => {
      if (m.state) set.add(m.state);
    });
    return Array.from(set).sort();
  }, [members]);

  const partyOptions = useMemo(() => {
    const set = new Set();
    members.forEach((m) => {
      if (m.party) set.add(m.party);
    });
    return ["all", ...Array.from(set).sort()];
  }, [members]);

  const filteredAndSorted = useMemo(() => {
    let data = members;

    if (chamberFilter !== "all") {
      data = data.filter((m) => m.chamber === chamberFilter);
    }
    if (stateFilter !== "all") {
      data = data.filter((m) => m.state === stateFilter);
    }
    if (partyFilter !== "all") {
      data = data.filter((m) => m.party === partyFilter);
    }
    if (searchTerm.trim()) {
      const term = searchTerm.trim().toLowerCase();
      data = data.filter(
        (m) =>
          m.name.toLowerCase().includes(term) ||
          m.nameRaw.toLowerCase().includes(term)
      );
    }

    let sorted = [...data];
    if (sortKey === "amountDesc") {
      sorted.sort((a, b) => b.amount - a.amount);
    } else if (sortKey === "amountAsc") {
      sorted.sort((a, b) => a.amount - b.amount);
    } else if (sortKey === "nameAsc") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }

    return sorted;
  }, [
    members,
    chamberFilter,
    stateFilter,
    partyFilter,
    searchTerm,
    sortKey,
  ]);

  const chamberMaxMap = useMemo(() => {
    const map = { house: 0, senate: 0 };
    members.forEach((m) => {
      if (m.amount > map[m.chamber]) map[m.chamber] = m.amount;
    });
    return map;
  }, [members]);

  const handleSelectMember = (member) => {
    setSelectedMemberId(member.id);
    const newPath = `/member/${member.slug}`;
    window.history.pushState({}, "", newPath);
  };

  const handleBackToScreener = () => {
    setSelectedMemberId(null);
    window.history.pushState({}, "", "/");
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur sticky top-0 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-emerald-500 flex items-center justify-center text-white font-black text-xl">
                ₪
              </div>
              <div className="flex flex-col">
                <span className="font-semibold tracking-tight">
                  fundedbyisrael.com
                </span>
                <span className="text-xs text-slate-500">
                  Follow the money from pro-Israel PACs to Congress
                </span>
              </div>
            </div>
          </div>
          <nav className="hidden sm:flex items-center gap-4 text-xs text-slate-500">
            <span className="uppercase tracking-[0.16em]">
              Campaign finance database
            </span>
            <button
              onClick={() => setShowDonateModal(true)}
              className="inline-flex items-center rounded-full bg-emerald-500 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm hover:bg-emerald-600"
            >
              Donate
            </button>
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 pb-16">
        {!selectedMember && (
          <>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <div>
                <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-1">
                  AIPAC & Pro-Israel Contributions Screener
                </h1>
                <p className="text-sm text-slate-600 max-w-3xl">
                  See which members of the U.S. House and Senate have received
                  money from pro-Israel groups.
                </p>
              </div>
              <div className="sm:hidden">
                <button
                  onClick={() => setShowDonateModal(true)}
                  className="inline-flex items-center rounded-full bg-emerald-500 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-600"
                >
                  Donate
                </button>
              </div>
            </div>

            <section className="border border-slate-200 rounded-2xl bg-white p-3 sm:p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-3">
                <div className="flex flex-col gap-1">
                  <h2 className="text-sm font-semibold tracking-tight">
                    Members of Congress
                  </h2>
                  <span className="text-[11px] text-slate-500">
                    {loading
                      ? "Loading dataset…"
                      : `${filteredAndSorted.length.toLocaleString()} of ${members.length.toLocaleString()} members shown`}
                  </span>
                </div>

                <div className="flex flex-col gap-2 w-full sm:w-auto">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                    Filters
                  </span>
                  <div className="flex flex-wrap gap-2 w-full">
                    <select
                      className="flex-1 min-w-[120px] bg-white border border-slate-300 rounded-full px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      value={chamberFilter}
                      onChange={(e) => setChamberFilter(e.target.value)}
                    >
                      <option value="all">All chambers</option>
                      <option value="house">House</option>
                      <option value="senate">Senate</option>
                    </select>

                    <select
                      className="flex-1 min-w-[120px] bg-white border border-slate-300 rounded-full px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      value={stateFilter}
                      onChange={(e) => setStateFilter(e.target.value)}
                    >
                      <option value="all">All states</option>
                      {stateOptions.map((state) => (
                        <option key={state} value={state}>
                          {state}
                        </option>
                      ))}
                    </select>

                    <select
                      className="flex-1 min-w-[120px] bg-white border border-slate-300 rounded-full px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      value={partyFilter}
                      onChange={(e) => setPartyFilter(e.target.value)}
                    >
                      <option value="all">All parties</option>
                      {partyOptions
                        .filter((p) => p !== "all")
                        .map((party) => (
                          <option key={party} value={party}>
                            {party}
                          </option>
                        ))}
                    </select>

                    <input
                      type="text"
                      placeholder="Search by name"
                      className="flex-1 min-w-[160px] bg-white border border-slate-300 rounded-full px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                    />

                    <select
                      className="w-full sm:w-auto bg-white border border-slate-300 rounded-full px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      value={sortKey}
                      onChange={(e) => setSortKey(e.target.value)}
                    >
                      <option value="amountDesc">Sort: highest funding</option>
                      <option value="amountAsc">Sort: lowest funding</option>
                      <option value="nameAsc">Sort: name A–Z</option>
                    </select>
                  </div>
                </div>
              </div>

              {loadWarning && (
                <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  {loadWarning} Once deployed with your real CSVs in
                  <code className="ml-1">public/data</code>, the screener will
                  use the complete dataset.
                </div>
              )}

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr className="text-[11px] text-slate-600">
                      <th className="px-3 py-2 text-left font-medium">Name</th>
                      <th className="px-3 py-2 text-left font-medium">
                        Chamber
                      </th>
                      <th className="px-3 py-2 text-left font-medium">Party</th>
                      <th className="px-3 py-2 text-left font-medium">State</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Total received
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Chamber rank
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-3 py-8 text-center text-slate-500"
                        >
                          Loading data…
                        </td>
                      </tr>
                    ) : filteredAndSorted.length === 0 ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-3 py-8 text-center text-slate-500"
                        >
                          No members match your filters.
                        </td>
                      </tr>
                    ) : (
                      filteredAndSorted.map((m) => (
                        <tr
                          key={m.id}
                          className="border-t border-slate-200 hover:bg-slate-50 cursor-pointer"
                          onClick={() => handleSelectMember(m)}
                        >
                          <td className="px-3 py-2 align-middle">
                            <div className="flex items-center gap-2">
                              {m.photoUrl ? (
                                <img
                                  src={m.photoUrl}
                                  alt={m.name}
                                  className="h-7 w-7 rounded-full object-cover border border-slate-200"
                                />
                              ) : (
                                <div className="h-7 w-7 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-semibold text-slate-700">
                                  {getInitials(m.name)}
                                </div>
                              )}
                              <div className="flex flex-col">
                                <span className="font-medium text-[13px] text-slate-900">
                                  {m.name}
                                </span>
                                <span className="text-[10px] text-slate-500">
                                  {m.nameRaw.replace(m.name, "").trim()}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2 align-middle text-[11px] text-slate-700">
                            {m.chamber === "house" ? "House" : "Senate"}
                          </td>
                          <td className="px-3 py-2 align-middle text-[11px] text-slate-700">
                            {m.party}
                          </td>
                          <td className="px-3 py-2 align-middle text-[11px] text-slate-700">
                            {m.state || "—"}
                          </td>
                          <td className="px-3 py-2 align-middle text-right font-mono text-[11px] text-slate-900">
                            {formatCurrency(m.amount)}
                          </td>
                          <td className="px-3 py-2 align-middle text-right text-[11px] text-slate-700">
                            #{m.chamberRank}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {selectedMember && (
          <MemberDetail
            member={selectedMember}
            chamberMax={
              chamberMaxMap[selectedMember.chamber] || selectedMember.amount
            }
            allMembers={members.filter(
              (m) => m.chamber === selectedMember.chamber
            )}
            onBack={handleBackToScreener}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white text-[11px] text-slate-500">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <span>
            fundedbyisrael.com — an independent resource on campaign finance
            and U.S. foreign policy.
          </span>
          <span>
            This website uses data from OpenSecrets.org and is inspired by
            TrackAIPAC.com.
          </span>
        </div>
      </footer>

      {showDonateModal && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-slate-200 p-5">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-slate-900">
                  Support non–AIPAC candidates
                </h2>
                <p className="mt-1 text-[12px] text-slate-600">
                  If you find this resource useful, consider supporting
                  candidates who refuse AIPAC and similar funding. You can
                  explore current endorsement lists and donation options below.
                </p>
              </div>
              <button
                onClick={() => setShowDonateModal(false)}
                className="h-6 w-6 rounded-full border border-slate-300 flex items-center justify-center text-[11px] text-slate-500 hover:bg-slate-100"
              >
                ✕
              </button>
            </div>

            <a
              href="https://www.trackaipac.com/endorsements"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex w-full items-center justify-center rounded-full bg-emerald-500 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-600"
            >
              View endorsement list & donate
            </a>

            <p className="mt-2 text-[11px] text-slate-500">
              You will be taken to trackaipac.com. This site does not process
              donations itself.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------
// Member detail view
// ---------------------------------------------------------------------

const MemberDetail = ({ member, chamberMax, allMembers, onBack }) => {
  const percentileFromTop = computePercentileRank(
    allMembersSorted(allMembers),
    member
  );
  const severity = getSeverityLabel(member.amount, chamberMax);

  return (
    <section className="mt-4 border border-slate-200 rounded-2xl bg-white p-4 sm:p-6 shadow-sm">
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-[11px] text-slate-600 hover:text-emerald-600"
      >
        <span className="inline-block h-4 w-4 rounded-full border border-slate-300 flex items-center justify-center text-[10px] mr-1">
          ←
        </span>
        Back to screener
      </button>

      <div className="flex flex-col sm:flex-row gap-5 sm:gap-8">
        <div className="flex items-start gap-4">
          {member.photoUrl ? (
            <img
              src={member.photoUrl}
              alt={member.name}
              className="h-16 w-16 rounded-full object-cover border border-slate-200"
            />
          ) : (
            <div className="h-16 w-16 rounded-full bg-slate-200 flex items-center justify-center text-sm font-semibold text-slate-700">
              {getInitials(member.name)}
            </div>
          )}
          <div className="space-y-1">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-slate-900">
              {member.name}
            </h1>
            <p className="text-[13px] text-slate-600">
              {member.party} •{" "}
              {member.chamber === "house"
                ? "U.S. House of Representatives"
                : "U.S. Senate"}
              {member.state ? ` • ${member.state}` : ""}
            </p>
            <p className="text-[11px] text-slate-500">
              Original listing: {member.nameRaw}
            </p>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3 sm:mt-0">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] text-slate-500 mb-1">
              Total received from pro-Israel groups
            </div>
            <div className="text-lg font-mono text-slate-900">
              {formatCurrency(member.amount)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Across all recorded cycles (1990–2024)
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] text-slate-500 mb-1">
              Rank within {member.chamber === "house" ? "House" : "Senate"}
            </div>
            <div className="text-lg font-semibold text-slate-900">
              #{member.chamberRank}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Approx. {percentileFromTop}th percentile from the top in their
              chamber.
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] text-slate-500 mb-1">
              Funding severity score (this site)
            </div>
            <span
              className={`inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium ${severity.color}`}
            >
              {severity.label}
            </span>
            <div className="mt-2 h-1.5 rounded-full bg-slate-200 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-400 via-amber-400 to-red-500"
                style={{
                  width: `${Math.min(
                    100,
                    (member.amount / chamberMax) * 100
                  )}%`,
                }}
              />
            </div>
            <div className="text-[10px] text-slate-500 mt-1">
              More money received → worse score on fundedbyisrael.com.
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4 text-[12px] text-slate-700">
        <div className="md:col-span-2 space-y-2">
          <h2 className="text-sm font-semibold tracking-tight">
            How to interpret this page
          </h2>
          <p>
            This page summarizes publicly reported contributions from
            pro-Israel political action committees and related groups to this
            member of Congress. Higher lifetime totals imply a stronger
            financial relationship with those organizations. This does not by
            itself prove causation, but it can inform public discussion of
            foreign policy, lobbying, and campaign finance.
          </p>
          <p className="text-slate-500">
            Always cross-check numbers with official filings (e.g. FEC data,
            candidate disclosures). Amounts shown here should be treated as an
            approximate aggregation for research and civic education.
          </p>
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold tracking-tight">
            SEO / research notes
          </h3>
          <ul className="list-disc list-inside space-y-1 text-slate-600">
            <li>
              URL path: <code className="text-[11px]">/member/{member.slug}</code>
            </li>
            <li>
              Page title: <code className="text-[11px]"><>{member.name} | fundedbyisrael.com</></code>
            </li>
            <li>
              Consider adding citations & links to official biographical and
              voting records for deeper context.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------
// Helpers for MemberDetail
// ---------------------------------------------------------------------

function allMembersSorted(members) {
  return [...members].sort((a, b) => b.amount - a.amount);
}

function getInitials(name) {
  if (!name) return "?";
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? "?";
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ---------------------------------------------------------------------
// CSV normalization & ranking
// ---------------------------------------------------------------------

function normalizeCsvRow(row, chamber) {
  const nameRaw = row.Representative || row.Senator || "";
  const state = row.State || "";
  const amount = parseAmount(row.Amount);

  const party = extractPartyFromName(nameRaw);
  const name = cleanDisplayName(nameRaw);
  const slug = slugify(name || nameRaw, chamber);

  return {
    id: `${slug}-${amount}`,
    slug,
    nameRaw,
    name,
    chamber,
    state,
    party,
    amount,
    // photoUrl: you can add this later when you have an image mapping
  };
}

function addRanks(members) {
  const byChamber = {
    house: members.filter((m) => m.chamber === "house"),
    senate: members.filter((m) => m.chamber === "senate"),
  };

  const rankedHouse = allMembersSorted(byChamber.house).map((m, idx) => ({
    ...m,
    chamberRank: idx + 1,
  }));

  const rankedSenate = allMembersSorted(byChamber.senate).map((m, idx) => ({
    ...m,
    chamberRank: idx + 1,
  }));

  const indexed = [...rankedHouse, ...rankedSenate];

  return indexed;
}

export default App;
