// The app's name lives here only (plus manifest.webmanifest and the <title> in index.html).
// Storage keys below are deliberately name-neutral, so renaming never touches data.
export const APP_NAME = 'Mother Flame';

export const KEYS = {
  db: 'md-vault',            // IndexedDB database
  settings: 'vault.settings', // localStorage
  ui: 'vault.ui',
  icon: 'vault.icon',         // these two are also read by the inline script in index.html
  theme: 'vault.theme',
};

// prefilled in Settings, so a new device only needs its token
export const REPO = { owner: 'Yagamifyed', repo: 'mother-flame-vault', branch: 'main' };

export const INBOX = 'Inbox.md';
export const CALENDAR = 'System/Calendar.md';
export const QUESTIONS = 'Lists/Open Questions.md';
export const TODOS = 'Lists/To-dos from Claude.md'; // written by Stella (stella todo): what projects need from Levin; shown in the Lab as "Needs you"
export const RESEARCH = 'Lists/Research topics.md'; // Stella's nightly research queue; shown in the Lab
export const FOR_STELLA = 'Lists/For Stella.md'; // tasks Levin hands to Stella (the flame sheet's Stella chip, File into, the Lab); he reports under each
export const TELL_SMO = 'Lists/Tell Smo.md';   // things to tell Smo (cues Smo:, Smi:, Jasmin:); shown with Today
export const DAILIES = 'Lists/Dailies.md';     // daily habits: ticked for today, unticked again tomorrow; shown with Today
export const VOICE_ANSWERS = 'System/Voice answers.md'; // spoken answers to the questions, until matched in the Lab
export const RULES = 'System/Filing rules.md';
export const THISWEEK = 'Lists/This week.md';
export const TASKS = 'Lists/General To-Do.md';
export const PEOPLE = 'Notes/People.md';
export const JOURNAL = 'Notes/Journal.md';
export const HEALTH = 'System/Health.md'; // written by Stella, answered here
export const ACTIVITY = 'System/Activity.md';       // written by Stella: what's running, for the Lab
export const SECTIONS = ['Lists', 'Notes', 'Trackers'];
export const HIDDEN = ['System', 'attachments'];
