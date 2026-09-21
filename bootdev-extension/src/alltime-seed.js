// alltime-seed.js
// Data only, dependency-free. Loaded as a content script (like
// settings-schema.js) rather than fetched as a JSON asset: a content script
// cannot fetch an extension URL without a web_accessible_resources entry, and
// the read would be async — this file is in scope synchronously, which is what
// lets a fresh install draw the board with no network round-trip at all.
//
// EXPORTED FROM A LIVE ROSTER on 2026-08-23T22:13:56.864Z using the
// maintainer's roster export tooling. Do not hand-edit — re-run the export.
//
// WHY THIS IS AN EXPORT AND NOT A PROBE OF THE API: Boot.dev removed
// leaderboardXPRankAlltime on 2026-08-20, so a per-user rank can no longer be
// looked up. These positions cannot be re-measured — they are carried forward
// from observations made while the field still existed, and each entry records
// its own rankAt so the age of the claim is visible rather than implied.
// XP and the display fields ARE still live and refresh normally.
//
// CUTOFF: ranks 1-30 only (28 entries).

const ALLTIME_SEED = {
  generatedAt: "2026-08-23T22:13:56.864Z",
  cutoffRank: 30,
  // Ranks here were last confirmed against the API on the dates in each entry's
  // rankAt; the API no longer serves them.
  ranksAreHistorical: true,
  entries: [
  { handle: "katcodes", rank: 1, rankAt: "2026-08-20T06:46:46.403Z", xp: 1749817, firstName: "Katharina", lastName: "Curry", role: "Archmage", level: 205, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/3b9569c9-2006-4648-b9b4-f43a63c33c30.png" },
  { handle: "a-fleming", rank: 2, rankAt: "2026-08-20T06:46:46.420Z", xp: 1710308, firstName: "Aaron", lastName: "Fleming", role: "Archmage", level: 203, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/67f1c010-0f5b-43b1-8c5b-bd1c41afaaba.png" },
  { handle: "victor1248321", rank: 3, rankAt: "2026-08-20T06:46:46.416Z", xp: 1644082, firstName: "Victor", lastName: "Gross", role: "Archmage", level: 199, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/457a2d5f-c654-4c24-906c-29416f66b265.jpeg" },
  { handle: "squashd", rank: 4, rankAt: "2026-08-20T06:46:46.425Z", xp: 1266235, firstName: "Dan", lastName: "Hjartland", role: "Archmage", level: 174, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/29a0f471-960b-49b5-9b86-403056c26889.jpeg" },
  { handle: "peert", rank: 5, rankAt: "2026-08-20T06:46:46.430Z", xp: 1178113, firstName: "Rasmus", lastName: "Frederiksen", role: "Archmage", level: 168, profileImageURL: "https://avatars.githubusercontent.com/u/19804492?v=4" },
  { handle: "cr-vx", rank: 6, rankAt: "2026-08-20T00:49:31.448Z", xp: 1146589, firstName: "Antton", lastName: "", role: "Archmage", level: 165, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/844c366c-b722-45f3-833d-e9c53e1a4dc4.png" },
  { handle: "jarimus", rank: 7, rankAt: "2026-08-20T00:49:31.448Z", xp: 1127722, firstName: "Jari", lastName: "Ahonen", role: "Archmage", level: 164, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/c87cad19-ed59-4a20-894e-dc5835ecceb8.jpeg" },
  { handle: "frontbuyer98", rank: 8, rankAt: "2026-08-20T00:49:31.448Z", xp: 1113793, firstName: "Fabian", lastName: "Berndt", role: "Archmage", level: 163, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/6c977a19-f950-4b69-b7bb-740200c3a478.png" },
  { handle: "i-like-templates", rank: 9, rankAt: "2026-08-20T06:46:46.414Z", xp: 1085522, firstName: "m", lastName: "", role: "Archmage", level: 161, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/12516d71-ed56-4da6-9eea-9bc87f1fb256.png" },
  { handle: "monstrousselection52", rank: 10, rankAt: "2026-08-20T00:49:31.448Z", xp: 1084501, firstName: "Roman", lastName: "Shnitser", role: "Archmage", level: 161, profileImageURL: "" },
  { handle: "jsec", rank: 11, rankAt: "2026-08-20T00:49:31.448Z", xp: 1071222, firstName: "jsec", lastName: "", role: "Archmage", level: 160, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/02c418c5-1232-40ad-af93-6882dcd89c48.jpeg" },
  { handle: "negligibletreat84", rank: 12, rankAt: "2026-08-20T00:49:31.448Z", xp: 1085186, firstName: "Victor", lastName: "", role: "Archmage", level: 161, profileImageURL: "https://avatars.githubusercontent.com/u/35177579?v=4" },
  { handle: "flakygarage25", rank: 13, rankAt: "2026-08-20T00:49:31.448Z", xp: 1056926, firstName: "Ivan", lastName: "G", role: "Archmage", level: 159, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/dffd2b03-e982-4dee-86ca-e166ec3a3440.png" },
  { handle: "sedat-capar", rank: 14, rankAt: "2026-08-20T00:49:31.448Z", xp: 1055236, firstName: "Sedat Çapar", lastName: "", role: "Archmage", level: 158, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/641ff744-c596-4db3-9cd6-954f4a58aaa8.png" },
  { handle: "moralskill64", rank: 15, rankAt: "2026-08-20T00:49:31.448Z", xp: 1052714, firstName: "Thiago", lastName: "Sant'Anna", role: "Archmage", level: 158, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/5c9dc233-4d17-4c04-a5f6-5a510f3c6e11.png" },
  { handle: "sirtaylor8888", rank: 16, rankAt: "2026-08-20T00:49:31.448Z", xp: 1043879, firstName: "Nhat Tai", lastName: "NGUYEN.", role: "Archmage", level: 158, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/35e8a487-ffaa-43d7-b521-082b8319ac10.jpeg" },
  { handle: "niudevelop", rank: 17, rankAt: "2026-08-20T00:49:31.448Z", xp: 1042528, firstName: "Niron", lastName: "Uthayakumar", role: "Archmage", level: 158, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/b82db9c4-6fb9-43cc-807b-2f0e9a1c53a3.png" },
  { handle: "kei-the-gae", rank: 18, rankAt: "2026-08-20T00:49:31.448Z", xp: 1032243, firstName: "Kei", lastName: "Holland", role: "Archmage", level: 157, profileImageURL: "https://avatars.githubusercontent.com/u/85800932?v=4" },
  { handle: "mixedaward57", rank: 19, rankAt: "2026-08-20T00:49:31.448Z", xp: 1022193, firstName: "Bret", lastName: "Peresich", role: "Archmage", level: 156, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/844db300-5480-4fca-9af4-aed61f865b1c.jpeg" },
  { handle: "joelsearcy", rank: 20, rankAt: "2026-08-20T00:49:31.448Z", xp: 1012546, firstName: "Joel", lastName: "Searcy", role: "Archmage", level: 155, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/e0842721-03bc-438b-a709-5a9fa78637aa.png" },
  { handle: "maker2413", rank: 21, rankAt: "2026-08-20T00:49:31.448Z", xp: 1003087, firstName: "Ethan", lastName: "", role: "Archmage", level: 154, profileImageURL: "https://avatars.githubusercontent.com/u/20630891?v=4" },
  { handle: "tobiaspartzsch", rank: 22, rankAt: "2026-08-20T06:46:20.115Z", xp: 1007800, firstName: "Tobias", lastName: "Partzsch", role: "Archmage", level: 155, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/13d2a750-18ee-4dbc-9e94-3ceb8ea1ea03.png" },
  { handle: "mattr", rank: 23, rankAt: "2026-08-20T05:32:48.261Z", xp: 980184, firstName: "Matt", lastName: "Redmond", role: "Archmage", level: 153, profileImageURL: "https://avatars.githubusercontent.com/u/5474?v=4" },
  { handle: "natac", rank: 24, rankAt: "2026-08-20T05:32:48.257Z", xp: 973868, firstName: "Sean", lastName: "Campbell", role: "Archmage", level: 152, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/060abb42-51c6-4fdc-b829-efa3aeaff996.jpeg" },
  { handle: "geophpherie", rank: 25, rankAt: "2026-08-20T05:32:48.260Z", xp: 963435, firstName: "Jeff", lastName: "Langdon", role: "Archmage", level: 151, profileImageURL: "https://avatars.githubusercontent.com/u/19380579?v=4" },
  { handle: "tokiloshi", rank: 27, rankAt: "2026-08-20T06:46:20.117Z", xp: 952793, firstName: "Bianca", lastName: "Silva", role: "Archmage", level: 150, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/d8d098d8-68c6-4a2a-aa02-fbec1f5866be.png" },
  { handle: "sereth69", rank: 29, rankAt: "2026-08-20T06:46:20.113Z", xp: 938710, firstName: "Damien", lastName: "Franklin", role: "Archmage", level: 149, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/3e6bc366-5e8b-4d5e-a041-85966557fa98.jpeg" },
  { handle: "wzl", rank: 30, rankAt: "2026-08-20T00:49:31.448Z", xp: 930102, firstName: "Alex", lastName: "B", role: "Archmage", level: 149, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/2d77d487-f338-4450-a4e4-fe7f2c972920.png" },
  ],
};
