// alltime-seed.js
// Data only, dependency-free. Loaded as a content script (like
// settings-schema.js) rather than fetched as a JSON asset: a content script
// cannot fetch an extension URL without a web_accessible_resources entry, and
// the read would be async — this file is in scope synchronously, which is what
// lets a fresh install draw the board with no network round-trip at all.
//
// Provenance: probe 09 (reference_data/bootdev_api_info/diagnostics/
// 2026-08-14_investigation/09_alltime_seed_builder.js), run 2026-08-15T01:59:02.503Z,
// maintainer-verified against the site. Ranks are LeaderboardXPRankAlltime from
// /v1/users/public/{handle}/stats; XP is XP from /v1/users/public/{handle}.
// Snapshot: reference_data/catalyst_versions/v0.15.0_all_time_board_rebuild/
// diagnostics/alltime_seed_2026-08-15.json
//
// CUTOFF: ranks 1-30 only (28 entries) — the board itself plus the
// near-miss watchlist that makes boundary drift visible. The raw snapshot also
// holds four personal-board handles at ranks 402-977; those are deliberately
// not shipped.
//
// generatedAt is the observation time for EVERY entry here. The roster merges
// this file like any other observation (newest wins), so re-running probe 09
// and replacing this file is all a seed refresh takes, and a user whose own
// data is fresher keeps theirs.
//
// firstName/lastName are split at the first space from the joined name probe 09
// emitted; the split is an approximation (a two-word given name lands wrong)
// and is replaced by the API's own fields on that handle's first live refresh.
// Next regeneration should emit the two fields separately and drop this note.
// Boot.dev display names and avatars are public profile data.

const ALLTIME_SEED = {
  generatedAt: "2026-08-15T01:59:02.503Z",
  cutoffRank: 30,
  entries: [
  { handle: "katcodes", rank: 1, xp: 1686602, firstName: "Katharina", lastName: "Curry", role: "Archmage", level: 201, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/3b9569c9-2006-4648-b9b4-f43a63c33c30.png" },
  { handle: "a-fleming", rank: 2, xp: 1680670, firstName: "Aaron", lastName: "Fleming", role: "Archmage", level: 201, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/67f1c010-0f5b-43b1-8c5b-bd1c41afaaba.png" },
  { handle: "victor1248321", rank: 3, xp: 1634258, firstName: "Victor", lastName: "Gross", role: "Archmage", level: 198, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/457a2d5f-c654-4c24-906c-29416f66b265.jpeg" },
  { handle: "squashd", rank: 4, xp: 1264881, firstName: "Dan", lastName: "Hjartland", role: "Archmage", level: 174, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/29a0f471-960b-49b5-9b86-403056c26889.jpeg" },
  { handle: "cr-vx", rank: 5, xp: 1146589, firstName: "Antton", lastName: "", role: "Archmage", level: 165, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/844c366c-b722-45f3-833d-e9c53e1a4dc4.png" },
  { handle: "frontbuyer98", rank: 6, xp: 1113793, firstName: "Fabian", lastName: "Berndt", role: "Archmage", level: 163, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/6c977a19-f950-4b69-b7bb-740200c3a478.png" },
  { handle: "jarimus", rank: 7, xp: 1113132, firstName: "Jari", lastName: "Ahonen", role: "Archmage", level: 163, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/c87cad19-ed59-4a20-894e-dc5835ecceb8.jpeg" },
  { handle: "peert", rank: 8, xp: 1109183, firstName: "Rasmus", lastName: "Frederiksen", role: "Archmage", level: 163, profileImageURL: "https://avatars.githubusercontent.com/u/19804492?v=4" },
  { handle: "i-like-templates", rank: 9, xp: 1085522, firstName: "m", lastName: "", role: "Archmage", level: 161, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/12516d71-ed56-4da6-9eea-9bc87f1fb256.png" },
  { handle: "monstrousselection52", rank: 10, xp: 1084501, firstName: "Roman", lastName: "Shnitser", role: "Archmage", level: 161, profileImageURL: "" },
  { handle: "jsec", rank: 11, xp: 1070962, firstName: "jsec", lastName: "", role: "Archmage", level: 160, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/02c418c5-1232-40ad-af93-6882dcd89c48.jpeg" },
  { handle: "flakygarage25", rank: 12, xp: 1056926, firstName: "Ivan", lastName: "G", role: "Archmage", level: 159, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/dffd2b03-e982-4dee-86ca-e166ec3a3440.png" },
  { handle: "sedat-capar", rank: 13, xp: 1055236, firstName: "Sedat", lastName: "Çapar", role: "Archmage", level: 158, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/641ff744-c596-4db3-9cd6-954f4a58aaa8.png" },
  { handle: "moralskill64", rank: 14, xp: 1052714, firstName: "Thiago", lastName: "Sant'Anna", role: "Archmage", level: 158, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/5c9dc233-4d17-4c04-a5f6-5a510f3c6e11.png" },
  { handle: "sirtaylor8888", rank: 15, xp: 1043879, firstName: "Nhat", lastName: "Tai NGUYEN.", role: "Archmage", level: 158, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/35e8a487-ffaa-43d7-b521-082b8319ac10.jpeg" },
  { handle: "niudevelop", rank: 16, xp: 1042528, firstName: "Niron", lastName: "Uthayakumar", role: "Archmage", level: 158, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/b82db9c4-6fb9-43cc-807b-2f0e9a1c53a3.png" },
  { handle: "kei-the-gae", rank: 17, xp: 1032243, firstName: "Kei", lastName: "Holland", role: "Archmage", level: 157, profileImageURL: "https://avatars.githubusercontent.com/u/85800932?v=4" },
  { handle: "mixedaward57", rank: 18, xp: 1022193, firstName: "Bret", lastName: "Peresich", role: "Archmage", level: 156, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/844db300-5480-4fca-9af4-aed61f865b1c.jpeg" },
  { handle: "negligibletreat84", rank: 19, xp: 1014606, firstName: "Victor", lastName: "", role: "Archmage", level: 155, profileImageURL: "https://avatars.githubusercontent.com/u/35177579?v=4" },
  { handle: "joelsearcy", rank: 20, xp: 1009658, firstName: "Joel", lastName: "Searcy", role: "Archmage", level: 155, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/e0842721-03bc-438b-a709-5a9fa78637aa.png" },
  { handle: "maker2413", rank: 21, xp: 1003087, firstName: "Ethan", lastName: "", role: "Archmage", level: 154, profileImageURL: "https://avatars.githubusercontent.com/u/20630891?v=4" },
  { handle: "tobiaspartzsch", rank: 22, xp: 986519, firstName: "Tobias", lastName: "Partzsch", role: "Archmage", level: 153, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/13d2a750-18ee-4dbc-9e94-3ceb8ea1ea03.png" },
  { handle: "natac", rank: 23, xp: 973868, firstName: "Sean", lastName: "Campbell", role: "Archmage", level: 152, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/060abb42-51c6-4fdc-b829-efa3aeaff996.jpeg" },
  { handle: "mattr", rank: 24, xp: 968364, firstName: "Matt", lastName: "Redmond", role: "Archmage", level: 152, profileImageURL: "https://avatars.githubusercontent.com/u/5474?v=4" },
  { handle: "geophpherie", rank: 25, xp: 963435, firstName: "Jeff", lastName: "Langdon", role: "Archmage", level: 151, profileImageURL: "https://avatars.githubusercontent.com/u/19380579?v=4" },
  { handle: "tokiloshi", rank: 26, xp: 948854, firstName: "Bianca", lastName: "Silva", role: "Archmage", level: 150, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/d8d098d8-68c6-4a2a-aa02-fbec1f5866be.png" },
  { handle: "sereth69", rank: 29, xp: 938453, firstName: "Damien", lastName: "Franklin", role: "Archmage", level: 149, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/3e6bc366-5e8b-4d5e-a041-85966557fa98.jpeg" },
  { handle: "wzl", rank: 30, xp: 930102, firstName: "Alex", lastName: "B", role: "Archmage", level: 149, profileImageURL: "https://storage.googleapis.com/qvault-webapp-dynamic-assets/profile_images/2d77d487-f338-4450-a4e4-fe7f2c972920.png" },
  ],
};
