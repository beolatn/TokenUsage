'use strict';

var obsidian = require('obsidian');
// Node.js `fs` is required here because Claude Code's session data lives outside
// the Obsidian vault, at ~/.claude/projects/ (JSONL files).
// The Obsidian vault API only provides access to files inside the vault, so it
// cannot be used to read these session files. This is the only reason fs is used;
// all vault reads and writes go through the Obsidian API as expected.
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Constants ────────────────────────────────────────────────────
const VIEW_TYPE  = 'token-usage-view';
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const HELP_URL   = 'https://www.langeatn.de/media/token-usage/';

const MODEL_COLORS = {
  Haiku:  '#06B6D4',
  Sonnet: '#4A90D9',
  Opus:   '#9B5DE5',
  Fable:  '#E9C46A',
  Other:  '#6B7280',
};

const DEFAULT_SETTINGS = {
  refreshSeconds: 30,
  reportPath:     'Token Usage Report.md',
  dashboardPath:  'Token Usage Dashboard.html',
  language:       'en',
};

// Logo SVG — compact bar chart using plugin accent colors
const LOGO_SVG = `<svg width="15" height="12" viewBox="0 0 15 12" fill="none" aria-hidden="true" style="flex-shrink:0">
  <rect x="0"    y="7" width="2.5" height="5"  rx="0.6" fill="#4A90D9" opacity="0.45"/>
  <rect x="3.5"  y="3" width="2.5" height="9"  rx="0.6" fill="#4A90D9" opacity="0.65"/>
  <rect x="7"    y="0" width="2.5" height="12" rx="0.6" fill="#4A90D9"/>
  <rect x="10.5" y="4" width="2.5" height="8"  rx="0.6" fill="#9B5DE5" opacity="0.80"/>
</svg>`;

// Glossary entries shown in the help panel
const HELP_SECTIONS = [
  {
    title: 'Tokens',
    body:  'The unit Claude bills for. Every word, punctuation mark, and space in a message is split into tokens — roughly 4 characters or ¾ of a word each. Both your input AND Claude\'s response are counted separately.',
  },
  {
    title: 'Input & Output',
    body:  'Input = everything you send (message + conversation history + system prompt). Output = everything Claude writes back. Output tokens typically cost 3–5× more than input tokens.',
  },
  {
    title: 'C.Write — Cache Write',
    body:  'When Claude processes a long context for the first time, it can store ("write") it into a prompt cache. Cache Write costs ~1.25× regular input — a small premium paid upfront to unlock future savings.',
  },
  {
    title: 'C.Read — Cache Read',
    body:  'Any follow-up request that reuses the same cached context is served at ~0.10× the input price — roughly 10× cheaper than reprocessing. A high C.Read value means you are working efficiently with the same material.',
  },
  {
    title: 'C.Write vs C.Read — what the ratio tells you',
    body:  'Reuse Factor = C.Read ÷ C.Write. High ratio → deep focus, same context across many requests. Low ratio → exploratory mode, constant context switches.\n\n≥ 8×  Deep focus — excellent cache return.\n3–8×  Balanced — focused work with some variety.\n1–3×  Exploratory — frequent new context.\n< 1×  Minimal reuse — mostly independent short sessions.',
  },
  {
    title: '5h Window',
    body:  'Rolling 5-hour window matching Claude\'s rate-limit period. "Claude 5h resets in: ~Xh Ym" counts down to the next reset.\n~ = approximation: session files are written after each response completes, not at session start. May lag 10–25 min. For the precise time, check Claude Code or claude.ai.',
  },
  {
    title: 'The three time views',
    body:  'Three independent cuts through the same data — they do not nest automatically.\n\nLast 5 Hour Session — rolling window matching Claude\'s rate-limit period. Counts toward your usage limit.\n\nThis Session — all entries with the current session ID, regardless of calendar date. A Claude Code session can span multiple days. If you started a session yesterday and are still in it today, This Session will show more tokens than Today. That is expected — the session accumulates across calendar boundaries.\n\nToday — calendar day since midnight, regardless of which session the tokens came from.\n\nThe sub-label under each title shows its exact scope at a glance. Full explanation at langeatn.de/media/token-usage/',
  },
  {
    title: 'Models',
    body:  'Haiku — fastest, cheapest, great for quick tasks.\nSonnet — balanced capability and cost.\nOpus — most capable in the Opus line.\nFable — Anthropic\'s most capable released model, highest cost.\n\nThe colored bar under the 7-day chart shows which model you actually used most in the last 7 days.',
  },
  {
    title: 'Sessions',
    body:  'Each Claude Code workspace project session has a unique ID. One session = one continuous conversation context. The dashboard Top Sessions table ranks sessions by total token volume across the last 30 days.',
  },
  {
    title: 'Cost overview (approximate, USD)',
    body:  'Input:        ~$3 / 1M tokens (Sonnet)\nOutput:       ~$15 / 1M tokens\nCache Write:  ~$3.75 / 1M tokens (+25%)\nCache Read:   ~$0.30 / 1M tokens (−90%)\n\nActual pricing depends on your plan and model. These figures illustrate why a high Reuse Factor reduces costs significantly.',
  },
];

// ── i18n ─────────────────────────────────────────────────────────

let _lang = 'en';

function t(key, ...args) {
  const s = STRINGS[_lang]?.[key] ?? STRINGS.en[key];
  return typeof s === 'function' ? s(...args) : (s !== undefined ? s : key);
}

const STRINGS = {
  en: {
    loading:          'Loading...',
    lastAction:       'Last Action',
    chipIn:           'In',
    chipOut:          'Out',
    chipCWr:          'C.Wr',
    chipCRd:          'C.Rd',
    startedYesterday: 'Started yesterday · spans multiple days',
    startedDate:      (d) => `Started ${d} · spans multiple days`,
    startedToday:     (t) => `Started today at ${t}`,
    thisSession:      'This Session',
    today:            'Today',
    calendarDay:      'Calendar day · since midnight',
    sevenDays:        '7 Days',
    thirtyDays:       '30 Days',
    resetsIn:         (d) => `Claude 5h resets in: ~${d}`,
    glossaryTitle:    'Glossary & Concepts',
    glossarySub:      'What every value means and how they relate',
    helpLink:         '↗ Full documentation on langeatn.de',
    models:           'Models (last 7 days)',
    last5h:           'Last 5 Hour Session',
    waiting:          'Waiting for next request...',
    rollingWindow:    'Rolling window · counts toward rate limit',
    backBtn:          '← Back',
    spikeAvg:         (r) => `↑ ${r}× avg`,
    windowCleared:    'Window cleared · full 5h available',
    noData:           'Token Usage: No data yet.',
    reportCreated:    'Token Usage report created.',
    reportFailed:     'Report failed: ',
    dashOpened:       'Dashboard opened in browser.',
    dashFailed:       'Dashboard failed: ',
    rowInput:         'Input',
    rowOutput:        'Output',
    rowCWrite:        'C.Write',
    rowCRead:         'C.Read',
    settingLang:      'Language',
    settingLangDesc:  'Display language for the plugin UI. Takes effect immediately.',
    settingRefresh:   'Auto-refresh interval (seconds)',
    settingRefreshDesc: 'Fallback polling interval. The file watcher triggers immediately on every new Claude response — this is the backup.',
    settingReport:    'Report path in vault',
    settingReportDesc: 'Relative path for the Markdown report. Overwritten on every click.',
    settingDash:      'Dashboard path in vault',
    settingDashDesc:  'Relative path for the HTML dashboard. Regenerated on every click, then opened in your default browser.',
    settingSource:    (p) => `Source: ${p} — no API key required.`,
    helpSections:     HELP_SECTIONS,
  },
  de: {
    loading:          'Laden...',
    lastAction:       'Letzte Aktion',
    chipIn:           'In',
    chipOut:          'Out',
    chipCWr:          'C.Wr',
    chipCRd:          'C.Rd',
    startedYesterday: 'Gestern begonnen · über mehrere Tage',
    startedDate:      (d) => `Begonnen am ${d} · über mehrere Tage`,
    startedToday:     (t) => `Heute begonnen um ${t}`,
    thisSession:      'Diese Session',
    today:            'Heute',
    calendarDay:      'Kalendertag · seit Mitternacht',
    sevenDays:        '7 Tage',
    thirtyDays:       '30 Tage',
    resetsIn:         (d) => `Claude 5h-Fenster wird zurückgesetzt in: ~${d}`,
    glossaryTitle:    'Glossar & Konzepte',
    glossarySub:      'Was jeder Wert bedeutet und wie sie zusammenhängen',
    helpLink:         '↗ Vollständige Dokumentation auf langeatn.de',
    models:           'Modelle (in den letzten 7 Tagen)',
    last5h:           'Letzte 5-Stunden-Session',
    waiting:          'Warte auf nächste Anfrage...',
    rollingWindow:    'Rollierendes Zeitfenster · zählt zum Rate-Limit',
    backBtn:          '← Zurück',
    spikeAvg:         (r) => `↑ ${r}× Ø`,
    noData:           'Token Usage: Noch keine Daten.',
    reportCreated:    'Token-Usage-Report erstellt.',
    reportFailed:     'Report fehlgeschlagen: ',
    windowCleared:    'Fenster zurückgesetzt · volle 5h verfügbar',
    dashOpened:       'Dashboard im Browser geöffnet.',
    dashFailed:       'Dashboard fehlgeschlagen: ',
    rowInput:         'Input',
    rowOutput:        'Output',
    rowCWrite:        'C.Write',
    rowCRead:         'C.Read',
    settingLang:      'Sprache',
    settingLangDesc:  'Anzeigesprache für die Plugin-Oberfläche. Funktioniert ohne Neustart.',
    settingRefresh:   'Automatisches Aktualisierungsintervall (in Sekunden)',
    settingRefreshDesc: 'Fallback-Abfrageintervall. Der Datei-Watcher Prozess reagiert sofort auf jede neue Claude-Antwort — dies ist eine Absicherung des Prozesses. Normalerweise muss hier nichts geändert werden.',
    settingReport:    'Report-Pfad im Vault',
    settingReportDesc: 'Relativer Pfad für den Markdown-Report. Wird bei jeder erneuten Ausführung überschrieben.',
    settingDash:      'Dashboard-Pfad im Vault',
    settingDashDesc:  'Relativer Pfad für das HTML-Dashboard. Wird bei jeder Ausführung neu generiert und im Standardbrowser geöffnet.',
    settingSource:    (p) => `Quelle: ${p} — kein API-Schlüssel erforderlich.`,
    helpSections: [
      {
        title: 'Token',
        body:  'Die Einheit, die Claude berechnet. Jedes Wort, Satzzeichen und Leerzeichen in einer Nachricht wird in Token aufgeteilt — etwa 4 Zeichen oder ¾ eines Wortes. Sowohl deine Eingabe ALS AUCH Claudes Antwort werden dabei separat gezählt.',
      },
      {
        title: 'Input & Output',
        body:  'Input = alles was du sendest (Nachricht + Gesprächsverlauf + System-Prompt). Output = alles was Claude zurückschreibt. Output-Tokens kosten typischerweise 3–5× mehr als Input-Tokens.',
      },
      {
        title: 'C.Write — Cache Write',
        body:  'Wenn Claude einen langen Kontext zum ersten Mal verarbeitet, kann er ihn in einen Prompt-Cache speichern ("schreiben"). Cache Write kostet ~1,25× des normalen Inputs — ein einmaliger Aufpreis, der zukünftige Einsparungen ermöglicht.',
      },
      {
        title: 'C.Read — Cache Read',
        body:  'Jede Folgeanfrage, die denselben gecachten Kontext wiederverwendet, wird zu ~0,10× des Input-Preises bedient — etwa 10 x günstiger als eine erneute Verarbeitung. Ein hoher C.Read-Wert bedeutet effizientes Arbeiten mit gleichbleibendem Material.',
      },
      {
        title: 'C.Write vs. C.Read — was das Verhältnis aussagt',
        body:  'Wiederverwendungsfaktor = C.Read ÷ C.Write. Hoher Faktor → Tiefenfokus, gleicher Kontext über viele Anfragen. Niedriger Faktor → Erkundungsmodus, häufige Kontextwechsel.\n\n≥ 8×  Tiefenfokus — ausgezeichnete Cache-Rendite.\n3–8×  Ausgewogen — fokussiertes Arbeiten mit etwas Abwechslung.\n1–3×  Erkundend — häufig neuer Kontext.\n< 1×  Minimale Wiederverwendung — meist unabhängige Kurzsessions.',
      },
      {
        title: '5-Stunden-Fenster',
        body:  'Ein rollierendes 5-Stunden-Fenster passend zu Claudes Rate-Limit-Zeitraum. "Claude 5h-Fenster wird zurückgesetzt in: ~Xh Ym" zählt bis zum nächsten Reset herunter.\n~ = Näherungswert: Session-Dateien werden nach jeder abgeschlossenen Antwort geschrieben, nicht beim Start. Kann 10–25 Min. verzögert sein. Den genauen Zeitpunkt findest du in Claude Code oder auf claude.ai.',
      },
      {
        title: 'Die drei unterschiedlichen Zeitansichten in der Übersicht',
        body:  'Es gibt drei unabhängige Ausschnitte aus denselben Daten — sie sind nicht automatisch ineinander verschachtelt.\n\nDie Letzte 5-Stunden-Session — rollierendes Fenster passend zu Claudes Rate-Limit-Zeitraum. Zählt zu deinem Nutzungslimit.\n\nDiese Session — alle Einträge mit der aktuellen Session-ID, unabhängig vom Kalenderdatum. Eine Claude Code Session kann mehrere Tage umfassen. Wenn du eine Session gestern begonnen hast und heute noch darin weiterarbeitest, zeigt "Diese Session" mehr Tokens als "Heute". Das ist so gewollt und designt — die Session akkumuliert über Kalendergrenzen hinweg.\n\nHeute — Kalendertag seit Mitternacht, unabhängig davon, aus welcher Session die Token stammen.\n\nDie Beschreibung unter jedem Titel zeigt den genauen Geltungsbereich auf einen Blick. Du findest eine vollständige Erklärung auf langeatn.de/media/token-usage/',
      },
      {
        title: 'Modelle',
        body:  'Haiku — schnellstes, günstigstes Modell, ideal für schnelle Aufgaben.\nSonnet — ausgewogenes Verhältnis aus Leistung und Kosten.\nOpus — leistungsstarkes Modell in der Opus-Linie.\nFable — Anthropics leistungsfähigstes veröffentlichtes Modell, höchste Kosten.\n\nDer farbige Balken unter dem 7-Tage-Diagramm zeigt, welches Modell du in den letzten 7 Tagen am häufigsten genutzt hast.',
      },
      {
        title: 'Sessions',
        body:  'Jede Claude Code Workspace-Projektsession hat eine eindeutige ID. Eine Session = ein kontinuierlicher Gesprächskontext. Die Top-Sessions-Tabelle im Dashboard ordnet Sessions nach dem Gesamt-Token-Volumen der letzten 30 Tage.',
      },
      {
        title: 'Kostenübersicht (ungefähr, USD)',
        body:  'Input:        ~3 $ / 1M Token (Sonnet)\nOutput:       ~15 $ / 1M Token\nCache Write:  ~3,75 $ / 1M Token (+25 %)\nCache Read:   ~0,30 $ / 1M Token (−90 %)\n\nDie tatsächlichen Preise hängen von deinem Plan und Modell ab. Diese Werte verdeutlichen, warum ein hoher Wiederverwendungsfaktor die Kosten erheblich senkt.',
      },
    ],
  },
  fr: {
    loading:          'Chargement...',
    lastAction:       'Dernière action',
    chipIn:           'In',
    chipOut:          'Out',
    chipCWr:          'C.Wr',
    chipCRd:          'C.Rd',
    startedYesterday: 'Démarrée hier · s\'étend sur plusieurs jours',
    startedDate:      (d) => `Démarrée le ${d} · s'étend sur plusieurs jours`,
    startedToday:     (time) => `Démarrée aujourd'hui à ${time}`,
    thisSession:      'Cette session',
    today:            'Aujourd\'hui',
    calendarDay:      'Jour calendaire · depuis minuit',
    sevenDays:        '7 jours',
    thirtyDays:       '30 jours',
    resetsIn:         (d) => `Réinitialisation des 5 h de Claude dans : ~${d}`,
    glossaryTitle:    'Glossaire et concepts',
    glossarySub:      'Ce que signifie chaque valeur et comment elles sont liées',
    helpLink:         '↗ Documentation complète sur langeatn.de',
    models:           'Modèles (7 derniers jours)',
    last5h:           'Dernière session de 5 heures',
    waiting:          'En attente de la prochaine requête...',
    rollingWindow:    'Fenêtre glissante · prise en compte dans la limite de débit',
    backBtn:          '← Retour',
    spikeAvg:         (r) => `↑ ${r}× moy.`,
    windowCleared:    'Fenêtre réinitialisée · 5 h entièrement disponibles',
    noData:           'Token Usage : pas encore de données.',
    reportCreated:    'Rapport Token Usage créé.',
    reportFailed:     'Échec du rapport : ',
    dashOpened:       'Tableau de bord ouvert dans le navigateur.',
    dashFailed:       'Échec du tableau de bord : ',
    rowInput:         'Input',
    rowOutput:        'Output',
    rowCWrite:        'C.Write',
    rowCRead:         'C.Read',
    settingLang:      'Langue',
    settingLangDesc:  'Langue d\'affichage de l\'interface du plugin. Prend effet immédiatement.',
    settingRefresh:   'Intervalle d\'actualisation automatique (secondes)',
    settingRefreshDesc: 'Intervalle d\'interrogation de secours. Le processus de surveillance des fichiers réagit immédiatement à chaque nouvelle réponse de Claude — il s\'agit de la solution de secours.',
    settingReport:    'Chemin du rapport dans le vault',
    settingReportDesc: 'Chemin relatif du rapport Markdown. Remplacé à chaque clic.',
    settingDash:      'Chemin du tableau de bord dans le vault',
    settingDashDesc:  'Chemin relatif du tableau de bord HTML. Régénéré à chaque clic, puis ouvert dans votre navigateur par défaut.',
    settingSource:    (p) => `Source : ${p} — aucune clé API requise.`,
    helpSections: [
      {
        title: 'Jetons',
        body:  'L\'unité facturée par Claude. Chaque mot, signe de ponctuation et espace d\'un message est divisé en jetons — environ 4 caractères ou ¾ de mot chacun. Votre saisie ET la réponse de Claude sont comptées séparément.',
      },
      {
        title: 'Input & Output',
        body:  'Input = tout ce que vous envoyez (message + historique de la conversation + prompt système). Output = tout ce que Claude renvoie. Les tokens Output coûtent généralement 3 à 5× plus cher que les tokens Input.',
      },
      {
        title: 'C.Write — Cache Write',
        body:  'Lorsque Claude traite un long contexte pour la première fois, il peut le stocker (« écrire ») dans un cache de prompt. Cache Write coûte environ 1,25× le prix d\'un Input normal — un petit supplément initial qui permet des économies ultérieures.',
      },
      {
        title: 'C.Read — Cache Read',
        body:  'Toute requête de suivi qui réutilise le même contexte mis en cache est servie à environ 0,10× le prix de l\'Input — soit environ 10× moins cher qu\'un nouveau traitement. Une valeur C.Read élevée indique que vous travaillez efficacement avec le même contenu.',
      },
      {
        title: 'C.Write vs C.Read — ce que le ratio indique',
        body:  'Facteur de réutilisation = C.Read ÷ C.Write. Ratio élevé → concentration approfondie, même contexte pour de nombreuses requêtes. Ratio faible → mode exploratoire, changements constants de contexte.\n\n≥ 8×  Concentration approfondie — excellent rendement du cache.\n3–8×  Équilibré — travail ciblé avec une certaine variété.\n1–3×  Exploratoire — nouveau contexte fréquent.\n< 1×  Réutilisation minimale — principalement de courtes sessions indépendantes.',
      },
      {
        title: 'Fenêtre de 5 h',
        body:  'Fenêtre glissante de 5 heures correspondant à la période de limitation de débit de Claude. « Réinitialisation des 5 h de Claude dans : ~Xh Ym » effectue le compte à rebours jusqu\'à la prochaine réinitialisation.\n~ = approximation : les fichiers de session sont écrits après la fin de chaque réponse, et non au début de la session. Un décalage de 10 à 25 min est possible. Pour l\'heure exacte, consultez Claude Code ou claude.ai.',
      },
      {
        title: 'Les trois vues temporelles',
        body:  'Trois découpages indépendants des mêmes données — ils ne sont pas automatiquement imbriqués.\n\nDernière session de 5 heures — fenêtre glissante correspondant à la période de limitation de débit de Claude. Elle est prise en compte dans votre limite d\'utilisation.\n\nCette session — toutes les entrées portant l\'ID de la session actuelle, quelle que soit la date. Une session Claude Code peut s\'étendre sur plusieurs jours. Si vous avez commencé une session hier et la poursuivez aujourd\'hui, Cette session affichera plus de tokens qu\'Aujourd\'hui. C\'est normal — la session s\'accumule au-delà des limites calendaires.\n\nAujourd\'hui — jour calendaire depuis minuit, indépendamment de la session d\'origine des tokens.\n\nLe sous-libellé sous chaque titre indique immédiatement son périmètre exact. Explication complète sur langeatn.de/media/token-usage/',
      },
      {
        title: 'Modèles',
        body:  'Haiku — le plus rapide et le moins cher, idéal pour les tâches rapides.\nSonnet — équilibre entre capacités et coût.\nOpus — le plus performant de la gamme Opus.\nFable — le modèle publié le plus performant d\'Anthropic, au coût le plus élevé.\n\nLa barre colorée sous le graphique sur 7 jours indique le modèle que vous avez réellement le plus utilisé au cours des 7 derniers jours.',
      },
      {
        title: 'Sessions',
        body:  'Chaque session de projet dans un espace de travail Claude Code possède un ID unique. Une session = un contexte de conversation continu. Le tableau Top Sessions du tableau de bord classe les sessions selon le volume total de tokens des 30 derniers jours.',
      },
      {
        title: 'Aperçu des coûts (approximatif, USD)',
        body:  'Input:        ~3 $ / 1 M de tokens (Sonnet)\nOutput:       ~15 $ / 1 M de tokens\nCache Write:  ~3,75 $ / 1 M de tokens (+25 %)\nCache Read:   ~0,30 $ / 1 M de tokens (−90 %)\n\nLe tarif réel dépend de votre forfait et du modèle. Ces chiffres illustrent pourquoi un facteur de réutilisation élevé réduit considérablement les coûts.',
      },
    ],
  },
  it: {
    loading:          'Caricamento...',
    lastAction:       'Ultima azione',
    chipIn:           'In',
    chipOut:          'Out',
    chipCWr:          'C.Wr',
    chipCRd:          'C.Rd',
    startedYesterday: 'Avviata ieri · si estende su più giorni',
    startedDate:      (d) => `Avviata il ${d} · si estende su più giorni`,
    startedToday:     (time) => `Avviata oggi alle ${time}`,
    thisSession:      'Questa sessione',
    today:            'Oggi',
    calendarDay:      'Giorno di calendario · da mezzanotte',
    sevenDays:        '7 giorni',
    thirtyDays:       '30 giorni',
    resetsIn:         (d) => `Le 5 ore di Claude si azzerano tra: ~${d}`,
    glossaryTitle:    'Glossario e concetti',
    glossarySub:      'Cosa significa ogni valore e come essi sono collegati',
    helpLink:         '↗ Documentazione completa su langeatn.de',
    models:           'Modelli (ultimi 7 giorni)',
    last5h:           'Ultima sessione di 5 ore',
    waiting:          'In attesa della prossima richiesta...',
    rollingWindow:    'Finestra mobile · conteggiata nel limite di utilizzo',
    backBtn:          '← Indietro',
    spikeAvg:         (r) => `↑ ${r}× media`,
    windowCleared:    'Finestra azzerata · 5 ore completamente disponibili',
    noData:           'Token Usage: nessun dato disponibile sull\'utilizzo.',
    reportCreated:    'Report sull\'utilizzo del token creato.',
    reportFailed:     'Creazione del report non riuscita: ',
    dashOpened:       'Dashboard aperta nel browser.',
    dashFailed:       'Apertura della dashboard non riuscita: ',
    rowInput:         'Input',
    rowOutput:        'Output',
    rowCWrite:        'C.Write',
    rowCRead:         'C.Read',
    settingLang:      'Lingua',
    settingLangDesc:  'Lingua di visualizzazione per l\'interfaccia del plugin. Ha effetto immediato.',
    settingRefresh:   'Intervallo di aggiornamento automatico (secondi)',
    settingRefreshDesc: 'Intervallo di polling di riserva. Il processo di monitoraggio dei file reagisce immediatamente a ogni nuova risposta di Claude — questa è la soluzione di riserva.',
    settingReport:    'Percorso del report nel vault',
    settingReportDesc: 'Percorso relativo del report Markdown. Viene sovrascritto a ogni clic.',
    settingDash:      'Percorso della dashboard nel vault',
    settingDashDesc:  'Percorso relativo della dashboard HTML. Viene rigenerata a ogni clic e quindi aperta nel browser predefinito.',
    settingSource:    (p) => `Fonte: ${p} — nessuna chiave API richiesta.`,
    helpSections: [
      {
        title: 'Token',
        body:  'L\'unità fatturata da Claude. Ogni parola, segno di punteggiatura e spazio in un messaggio viene suddiviso in token — circa 4 caratteri o ¾ di parola ciascuno. Sia il tuo input SIA la risposta di Claude vengono conteggiati separatamente.',
      },
      {
        title: 'Input & Output',
        body:  'Input = tutto ciò che invii (messaggio + cronologia della conversazione + prompt di sistema). Output = tutto ciò che Claude restituisce. I token Output costano in genere dalle 3 alle 5 volte i token input.',
      },
      {
        title: 'C.Write — Cache Write',
        body:  'Quando Claude elabora per la prima volta un contesto lungo, può memorizzarlo («scriverlo») in una cache del prompt. Cache Write costa 1,25 volte dell\'input normale — un piccolo sovrapprezzo iniziale che consente risparmi futuri.',
      },
      {
        title: 'C.Read — Cache Read',
        body:  'Ogni richiesta successiva che riutilizza lo stesso contesto memorizzato nella cache viene gestita a circa 0,10 volte il prezzo dell\'input — approssimativamente 10 volte meno rispetto a una nuova elaborazione. Un valore C.Read elevato indica che stai lavorando in modo efficiente con lo stesso materiale.',
      },
      {
        title: 'C.Write vs C.Read — cosa indica il rapporto',
        body:  'Fattore di riutilizzo = C.Read ÷ C.Write. Rapporto elevato → concentrazione profonda, stesso contesto per molte richieste. Rapporto basso → modalità esplorativa, continui cambi di contesto.\n\n≥ 8×  Concentrazione profonda — rendimento eccellente della cache.\n3–8×  Bilanciato — lavoro mirato con una certa varietà.\n1–3×  Esplorativo — nuovo contesto frequente.\n< 1×  Riutilizzo minimo — perlopiù brevi sessioni indipendenti.',
      },
      {
        title: 'Finestra di 5 ore',
        body:  'La finestra mobile di utilizzo di Claude è di 5 ore. «Al prossimo reset mancano: ~Xh Ym» mostra il conto alla rovescia fino al prossimo azzeramento.\n~ = approssimazione: i file di sessione vengono scritti dopo il completamento di ogni risposta, non all\'avvio della sessione. Può esserci un ritardo di 10–25 minuti. Per l\'orario preciso, controlla Claude Code o claude.ai.',
      },
      {
        title: 'Le tre viste temporali',
        body:  'Tre viste indipendenti sugli stessi dati — non sono automaticamente annidate.\n\nUltima sessione di 5 ore — finestra mobile corrispondente al periodo del limite di utilizzo di Claude. Conta ai fini del limite di utilizzo.\n\nQuesta sessione — tutte le voci con l\'ID della sessione corrente, indipendentemente dalla data di calendario. Una sessione di Claude Code può durare più giorni. Se hai iniziato una sessione ieri e la stai ancora usando oggi, Questa sessione mostrerà più token di Oggi. È previsto — la sessione si accumula oltre i confini del calendario.\n\nOggi — giorno di calendario da mezzanotte, indipendentemente dalla sessione da cui provengono i token.\n\nIl sottotitolo sotto ogni titolo mostra subito l\'ambito esatto. Spiegazione completa su langeatn.de/media/token-usage/',
      },
      {
        title: 'Modelli',
        body:  'Haiku — il più veloce e conveniente, ideale per attività rapide.\nSonnet — equilibrio tra capacità e costo.\nOpus — il più capace della linea Opus.\nFable — il modello pubblicato più capace di Anthropic, con il costo più elevato.\n\nLa barra colorata sotto il grafico dei 7 giorni mostra quale modello hai effettivamente utilizzato di più negli ultimi 7 giorni.',
      },
      {
        title: 'Sessioni',
        body:  'Ogni sessione di progetto in uno spazio di lavoro Claude Code ha un ID univoco. Una sessione = un contesto di conversazione continuo. La tabella Top Sessions della dashboard ordina le sessioni in base al volume totale di token degli ultimi 30 giorni.',
      },
      {
        title: 'Panoramica dei costi (approssimativa, USD)',
        body:  'Input:        ~3 $ / 1 M di token (Sonnet)\nOutput:       ~15 $ / 1 M di token\nCache Write:  ~3,75 $ / 1 M di token (+25%)\nCache Read:   ~0,30 $ / 1 M di token (−90%)\n\nIl prezzo effettivo dipende dal tuo piano e dal modello. Questi valori mostrano perché un fattore di riutilizzo elevato riduce significativamente i costi.',
      },
    ],
  },
};

// ── Helpers ──────────────────────────────────────────────────────

function intensityColor(ratio, isToday) {
  let r, g, b;
  if (ratio <= 0) { r = 70; g = 70; b = 70; }
  else if (ratio < 0.5) {
    const t = ratio * 2;
    r = Math.round(82  + (245 - 82)  * t);
    g = Math.round(183 + (158 - 183) * t);
    b = Math.round(136 + (11  - 136) * t);
  } else {
    const t = (ratio - 0.5) * 2;
    r = Math.round(245 + (229 - 245) * t);
    g = Math.round(158 + (80  - 158) * t);
    b = Math.round(11  + (80  - 11)  * t);
  }
  return `rgba(${r},${g},${b},${isToday ? 1.0 : 0.60})`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + ' B';
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(2) + ' M';
  if (n >= 1_000)         return (n / 1_000).toFixed(1) + ' K';
  return String(n);
}

function fmtDuration(ms) {
  if (ms <= 0) return '0m';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function dayStart(date) {
  const d = new Date(date); d.setHours(0, 0, 0, 0); return d.getTime();
}
function daysAgoTs(n) {
  const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0, 0, 0, 0); return d.getTime();
}

function aggregate(entries) {
  const r = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, count: 0 };
  for (const e of entries) {
    r.input       += e.usage.input_tokens                || 0;
    r.output      += e.usage.output_tokens               || 0;
    r.cacheCreate += e.usage.cache_creation_input_tokens || 0;
    r.cacheRead   += e.usage.cache_read_input_tokens     || 0;
    r.count++;
  }
  return r;
}

function groupByDay(entries, nDays) {
  const result = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const from = daysAgoTs(i), to = from + 86_400_000;
    const agg  = aggregate(entries.filter(e => e.timestamp >= from && e.timestamp < to));
    result.push({
      label:   new Date(from).toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 2),
      date:    new Date(from).toLocaleDateString('en-GB'),
      isToday: i === 0,
      total:   agg.input + agg.output,
      input:   agg.input,
      output:  agg.output,
    });
  }
  return result;
}

function modelFamily(name) {
  const m = (name || '').toLowerCase();
  if (m.includes('haiku'))  return 'Haiku';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('opus'))   return 'Opus';
  if (m.includes('fable'))  return 'Fable';
  return 'Other';
}

function modelDistribution(entries) {
  const counts = {}, tokens = {};
  for (const e of entries) {
    const f   = modelFamily(e.model);
    counts[f] = (counts[f] || 0) + 1;
    tokens[f] = (tokens[f] || 0) + e.usage.input_tokens + e.usage.output_tokens;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count, tokens: tokens[name] || 0, pct: total > 0 ? Math.round(count / total * 100) : 0 }))
    .sort((a, b) => b.count - a.count);
}

// ── JSONL Parsing ─────────────────────────────────────────────────
function getAllSessionFiles() {
  const files = [];
  if (!fs.existsSync(CLAUDE_DIR)) return files;
  try {
    for (const proj of fs.readdirSync(CLAUDE_DIR)) {
      const projDir = path.join(CLAUDE_DIR, proj);
      try {
        for (const entry of fs.readdirSync(projDir)) {
          if (!entry.endsWith('.jsonl')) continue;
          const full = path.join(projDir, entry);
          try { const s = fs.statSync(full); files.push({ path: full, mtime: s.mtimeMs, size: s.size }); } catch(e) {}
        }
      } catch(e) {}
    }
  } catch(e) {}
  return files.sort((a, b) => b.mtime - a.mtime);
}

function parseUsageFromFile(filePath, minTimestamp, fileSize) {
  const entries          = [];
  const synthetic        = []; // assistant/<synthetic> entries — written by CC after each compaction
  const compactions      = []; // system/compact_boundary — authoritative compaction data (pre/postTokens)
  const apiErrors        = []; // system/api_error — connection or auth failures
  const aiTitles         = {}; // sessionId → human-readable session title from ai-title entries
  const rateLimitEvents  = []; // assistant/<synthetic> with error:"rate_limit" — actual session/weekly limit hits
  let fullContent  = '';
  let chunkContent = '';
  let usedChunk    = false;
  try {
    if (fileSize > 1_500_000 && minTimestamp && minTimestamp > daysAgoTs(1)) {
      // Large active file: read only the tail for token entries (performance).
      // ai-title is written at the START of a session — read a small head block too.
      const chunk  = Math.min(600_000, fileSize);
      const buf    = Buffer.alloc(chunk);
      const fd     = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, chunk, fileSize - chunk);
      fs.closeSync(fd);
      chunkContent = buf.toString('utf8');
      const nl     = chunkContent.indexOf('\n');
      if (nl > -1) chunkContent = chunkContent.slice(nl + 1);
      // Also read first 8 kB to capture ai-title (always near the top)
      const headBuf = Buffer.alloc(8192);
      const fdH     = fs.openSync(filePath, 'r');
      const read    = fs.readSync(fdH, headBuf, 0, 8192, 0);
      fs.closeSync(fdH);
      fullContent = headBuf.toString('utf8', 0, read);
      usedChunk = true;
    } else {
      fullContent = fs.readFileSync(filePath, 'utf8');
    }

    // Pass 1 — head block only (ai-title lives near the top)
    for (const line of fullContent.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'ai-title' && obj.aiTitle && obj.sessionId) {
          aiTitles[obj.sessionId] = obj.aiTitle;
        }
      } catch(e) {}
    }

    // Pass 2 — main content (tail chunk for large files, full content otherwise)
    const mainContent = usedChunk ? chunkContent : fullContent;
    for (const line of mainContent.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const sid = obj.sessionId || '';

        // ── assistant entries: token usage + synthetic markers
        if (obj.type === 'assistant') {
          const msg = obj.message;
          if (!msg?.usage) continue;
          const ts = new Date(obj.timestamp).getTime();
          if (minTimestamp && ts < minTimestamp) continue;
          // <synthetic>: zero-token boundary marker written by CC directly after a compaction.
          // Gap of ~1 s = auto-compaction; longer gap = session-resume marker.
          // Special case: if obj.error === 'rate_limit', this is a rate-limit hit event —
          // CC writes a synthetic entry with apiErrorStatus 429 and a human-readable message.
          if (msg.model === '<synthetic>') {
            if (obj.error === 'rate_limit') {
              const text = msg.content?.[0]?.text || '';
              const typ  = text.includes('weekly') ? 'weekly' : 'session';
              const rm   = text.match(/resets\s+(.+?)\s*\(Europe\/Berlin\)/);
              rateLimitEvents.push({
                timestamp: ts,
                sessionId: sid,
                type:      typ,
                message:   text,
                reset:     rm ? rm[1].trim() : '',
              });
            } else {
              synthetic.push({ timestamp: ts, sessionId: sid });
            }
            continue;
          }
          // Drop any other zero-token noise not covered above
          if ((msg.usage.input_tokens || 0) === 0 &&
              (msg.usage.output_tokens || 0) === 0 &&
              (msg.usage.cache_creation_input_tokens || 0) === 0 &&
              (msg.usage.cache_read_input_tokens || 0) === 0) continue;
          entries.push({
            timestamp: ts, model: msg.model || 'unknown', sessionId: sid,
            usage: {
              input_tokens:                msg.usage.input_tokens                || 0,
              output_tokens:               msg.usage.output_tokens               || 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens || 0,
              cache_read_input_tokens:     msg.usage.cache_read_input_tokens     || 0,
            }
          });
          continue;
        }

        // ── system entries: compaction data + API errors
        if (obj.type === 'system') {
          const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
          if (obj.subtype === 'compact_boundary' && obj.compactMetadata) {
            if (!minTimestamp || ts >= minTimestamp) {
              compactions.push({
                timestamp:  ts,
                sessionId:  sid,
                preTokens:  obj.compactMetadata.preTokens  || 0,
                postTokens: obj.compactMetadata.postTokens || 0,
                durationMs: obj.compactMetadata.durationMs || 0,
                trigger:    obj.compactMetadata.trigger    || 'unknown',
              });
            }
          } else if (obj.subtype === 'api_error' && obj.error) {
            if (!minTimestamp || ts >= minTimestamp) {
              apiErrors.push({
                timestamp:   ts,
                sessionId:   sid,
                status:      obj.error.status      || null,
                formatted:   obj.error.formatted   || obj.error.message || '',
                isRateLimit: obj.error.status === 429,
                isNetwork:   obj.error.isNetworkDown || false,
                retryAttempt: obj.retryAttempt     || 1,
              });
            }
          }
          continue;
        }

        // ── ai-title: also collect from main content in case it wasn't in the head block
        if (obj.type === 'ai-title' && obj.aiTitle && obj.sessionId) {
          aiTitles[obj.sessionId] = obj.aiTitle;
        }

      } catch(e) {}
    }
  } catch(e) {}
  return { entries, synthetic, compactions, apiErrors, aiTitles, rateLimitEvents };
}

// ── View ──────────────────────────────────────────────────────────
class AnthropicUsageView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin     = plugin;
    this.data       = null;
    this.helpVisible = false;
    this._watcher   = null;
    this._watchedFile = null;
    this._debounce  = null;
    this._collapsed = new Set(); // keys of collapsed sections — persists across data refreshes
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'Token Usage'; }
  getIcon()        { return 'activity'; }

  async onOpen()  { await this.refresh(); this._setupWatcher(); }
  async onClose() { this._teardownWatcher(); }

  _setupWatcher() {
    this._teardownWatcher();
    const files = getAllSessionFiles();
    if (!files.length) return;
    const latest = files[0].path;
    try {
      this._watchedFile = latest;
      this._watcher = fs.watch(latest, { persistent: false }, () => {
        if (this._debounce) clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this.refresh(), 600);
      });
    } catch(e) {}
  }

  _teardownWatcher() {
    if (this._watcher)  { try { this._watcher.close(); } catch(e){} this._watcher = null; }
    if (this._debounce) { clearTimeout(this._debounce); this._debounce = null; }
  }

  async refresh() {
    if (!this.data) this.render();
    try {
      const now     = Date.now();
      const todayTs = dayStart(new Date());
      const day7Ts  = daysAgoTs(7);
      const day30Ts = daysAgoTs(30);
      const win5hTs = now - 5 * 3_600_000;
      const files   = getAllSessionFiles();
      const curId   = files.length > 0 ? path.basename(files[0].path, '.jsonl') : null;

      let all                 = [];
      let allSynthetic        = [];
      let allCompactions      = [];
      let allApiErrors        = [];
      let allRateLimitEvents  = [];
      let sessionTitles       = {};
      for (const f of files) {
        if (f.mtime < day30Ts) break;
        const parsed    = parseUsageFromFile(f.path, day30Ts, f.size);
        all             = all.concat(parsed.entries);
        allSynthetic    = allSynthetic.concat(parsed.synthetic);
        allCompactions  = allCompactions.concat(parsed.compactions);
        allApiErrors    = allApiErrors.concat(parsed.apiErrors);
        allRateLimitEvents = allRateLimitEvents.concat(parsed.rateLimitEvents);
        Object.assign(sessionTitles, parsed.aiTitles);
      }
      all.sort((a, b) => b.timestamp - a.timestamp);

      const d7       = all.filter(e => e.timestamp >= day7Ts);
      const win5h    = all.filter(e => e.timestamp >= win5hTs);
      const win5hAgg = aggregate(win5h);
      // Detect if the 5h window just cleared: no current entries, but activity in the last 6h
      const win6hTs      = now - 6 * 3_600_000;
      const windowCleared = win5hAgg.count === 0 && all.some(e => e.timestamp >= win6hTs);

      const sessionEntries = curId ? all.filter(e => e.sessionId === curId) : [];

      // Spike detection — compare today vs personal 29-day baseline (active days only)
      const todayAgg      = aggregate(all.filter(e => e.timestamp >= todayTs));
      const todayTotal    = todayAgg.input + todayAgg.output;
      const past29        = all.filter(e => e.timestamp >= day30Ts && e.timestamp < todayTs);
      const activeDays    = new Set(past29.map(e => dayStart(new Date(e.timestamp)))).size;
      const past29Total   = past29.reduce((s, e) => s + e.usage.input_tokens + e.usage.output_tokens, 0);
      const avgDaily      = activeDays > 0 ? past29Total / activeDays : 0;
      const spikeRatio    = (avgDaily > 0 && todayTotal > 0) ? Math.round(todayTotal / avgDaily * 10) / 10 : 0;

      // Analytics counters — prepared for v1.7 display
      const compact7d    = allCompactions.filter(e => e.timestamp >= day7Ts);
      const compactToday = allCompactions.filter(e => e.timestamp >= todayTs);

      this.data = {
        lastAction:   all[0] || null,
        session:      aggregate(sessionEntries),
        sessionStart: sessionEntries.length > 0 ? Math.min(...sessionEntries.map(e => e.timestamp)) : null,
        today:        todayAgg,
        spikeRatio,
        day7:       aggregate(d7),
        day30:      aggregate(all),
        chart7:     groupByDay(d7, 7),
        window5h: {
          agg:     win5hAgg,
          oldest:  win5h.length > 0 ? Math.min(...win5h.map(e => e.timestamp)) : null,
          total:   win5hAgg.input + win5hAgg.output,
          cleared: windowCleared,
        },
        entries7:   d7,
        entries30:  all,
        // ── v1.7 analytics data (collected, not yet rendered in the panel) ──────
        // system/compact_boundary: authoritative compaction records.
        // Each entry: { timestamp, sessionId, preTokens, postTokens, durationMs, trigger }
        compactionEvents:  allCompactions,
        compactions7d:     compact7d.length,
        compactionsToday:  compactToday.length,
        // assistant/<synthetic>: CC-internal marker written after each compaction.
        // Correlated with compactionEvents but less informative; kept for reference.
        syntheticEvents:   allSynthetic,
        // system/api_error: connection failures, auth errors.
        // Each entry: { timestamp, sessionId, status, formatted, isRateLimit, isNetwork }
        apiErrors:         allApiErrors,
        // ai-title: maps sessionId → human-readable title generated by CC.
        // Use in dashboard to replace truncated UUIDs in Top Sessions table.
        sessionTitles,
        // Rate-limit events: assistant/<synthetic> entries with error:"rate_limit".
        // Each entry: { timestamp, sessionId, type ('session'|'weekly'), message, reset }
        rateLimitEvents:   allRateLimitEvents,
        updatedAt:  new Date(),
      };

      if (files.length > 0 && files[0].path !== this._watchedFile) this._setupWatcher();
    } catch(err) {
      console.error('AnthropicUsage refresh error:', err);
    }
    this.render();
  }

  render() {
    const el = this.containerEl.children[1];
    el.empty();
    el.addClass('au-container');

    // ── Header (always present)
    const hdr = el.createEl('div', { cls: 'au-header' });

    // Logo
    const logoEl = hdr.createEl('div', { cls: 'au-logo' });
    logoEl.innerHTML = LOGO_SVG + '<span class="au-logo-text">Token Usage</span>';

    // Button group
    const btnWrap = hdr.createEl('div', { cls: 'au-header-btns' });

    const dashBtn = btnWrap.createEl('button', { cls: 'au-dash-btn', text: 'Dashboard' });
    dashBtn.title   = 'Open BI dashboard in browser (HTML + charts)';
    dashBtn.onclick = () => this._generateDashboard();

    const reportBtn = btnWrap.createEl('button', { cls: 'au-report-btn', text: 'Report' });
    reportBtn.title   = 'Create Markdown report in vault and open it';
    reportBtn.onclick = () => this._generateReport();

    const refreshBtn = btnWrap.createEl('button', { cls: 'au-refresh-btn', text: '↻' });
    refreshBtn.title   = 'Refresh now';
    refreshBtn.onclick = () => this.refresh();

    const settingsBtn = btnWrap.createEl('button', { cls: 'au-settings-btn', text: '⚙' });
    settingsBtn.title   = 'Plugin settings';
    settingsBtn.onclick = () => { this.app.setting.open(); this.app.setting.openTabById('token-usage'); };

    const helpBtn = btnWrap.createEl('button', {
      cls:  'au-help-btn' + (this.helpVisible ? ' au-help-active' : ''),
      text: '?',
    });
    helpBtn.title   = 'Help — glossary and concept explanations';
    helpBtn.onclick = () => { this.helpVisible = !this.helpVisible; this.render(); };

    if (this.helpVisible) {
      const backBtn = btnWrap.createEl('button', { cls: 'au-back-btn', text: t('backBtn') });
      backBtn.title   = 'Back to data view';
      backBtn.onclick = () => { this.helpVisible = false; this.render(); };
    }

    // ── Help mode: replace content with glossary
    if (this.helpVisible) {
      this._renderHelp(el);
      return;
    }

    if (!this.data) { el.createEl('div', { cls: 'au-loading', text: t('loading') }); return; }
    const d = this.data;

    // ── Meta
    const meta = el.createEl('div', { cls: 'au-meta' });
    meta.createEl('span', { cls: 'au-live', text: `${this._watcher ? '● Live' : '○'} ${d.updatedAt.toLocaleTimeString('en-GB')}` });

    // ── 7-day chart
    this._renderChart(el, d.chart7);

    // ── Model distribution (7 days)
    this._renderModelBar(el, d.entries7);

    // ── Last action
    if (d.lastAction) {
      const la  = d.lastAction;
      const sec = el.createEl('div', { cls: 'au-section' });
      const lhdr = sec.createEl('div', { cls: 'au-last-hdr' });
      lhdr.createEl('span', { cls: 'au-section-title', text: t('lastAction') });
      lhdr.createEl('span', { cls: 'au-model-chip', text: la.model.replace('claude-', '') });
      const chips = sec.createEl('div', { cls: 'au-last-chips' });
      const chipDefs = [
        { label: t('chipIn'),  val: la.usage.input_tokens,                color: 'blue'   },
        { label: t('chipOut'), val: la.usage.output_tokens,               color: 'green'  },
        { label: t('chipCWr'), val: la.usage.cache_creation_input_tokens, color: 'purple' },
        { label: t('chipCRd'), val: la.usage.cache_read_input_tokens,     color: 'amber'  },
      ];
      for (const { label, val, color } of chipDefs) {
        const chip = chips.createEl('span', { cls: `au-last-chip au-last-chip-${color}` });
        chip.createEl('span', { cls: 'au-last-chip-lbl', text: label + ' ' });
        chip.createEl('span', { cls: 'au-last-chip-val', text: fmtTokens(val) });
      }
    }

    // ── 5h Window
    this._renderWindow5h(el);

    // ── Periods
    let sessionSub = '';
    if (d.sessionStart) {
      const startTs  = d.sessionStart;
      const todayMid = dayStart(new Date());
      const start    = new Date(startTs);
      if (startTs < todayMid) {
        const daysAgo = Math.floor((todayMid - startTs) / 86_400_000);
        sessionSub = daysAgo === 1
          ? t('startedYesterday')
          : t('startedDate', start.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }));
      } else {
        sessionSub = t('startedToday', start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
      }
    }
    this._renderPeriod(el, 'this-session', t('thisSession'), d.session,  sessionSub);
    this._renderPeriod(el, 'today',        t('today'),       d.today,    t('calendarDay'));
    this._renderPeriod(el, '7-days',       t('sevenDays'),   d.day7);
    this._renderPeriod(el, '30-days',      t('thirtyDays'),  d.day30);

    // ── Footer
    const footer   = el.createEl('div', { cls: 'au-footer' });
    const leftSpan = footer.createEl('span', { cls: 'au-reset-countdown' });
    if (d.window5h.oldest) {
      const msLeft = Math.max(0, d.window5h.oldest + 5 * 3_600_000 - Date.now());
      if (msLeft > 0) leftSpan.textContent = t('resetsIn', fmtDuration(msLeft));
    }
    footer.createEl('span', { cls: 'au-version', text: `v${this.plugin.manifest.version}` });
  }

  // ── Help panel ────────────────────────────────────────────────
  _renderHelp(parent) {
    const wrap = parent.createEl('div', { cls: 'au-help' });

    const intro = wrap.createEl('div', { cls: 'au-help-intro' });
    intro.createEl('span', { cls: 'au-help-title', text: t('glossaryTitle') });
    intro.createEl('span', { cls: 'au-help-sub', text: t('glossarySub') });

    for (const sec of (STRINGS[_lang]?.helpSections || HELP_SECTIONS)) {
      const s = wrap.createEl('div', { cls: 'au-help-section' });
      s.createEl('div', { cls: 'au-help-section-title', text: sec.title });
      for (const line of sec.body.split('\n')) {
        if (line.trim()) s.createEl('p', { cls: 'au-help-section-body', text: line });
      }
    }

    const linkWrap = wrap.createEl('div', { cls: 'au-help-link-wrap' });
    const link = linkWrap.createEl('a', { cls: 'au-help-link', text: t('helpLink') });
    link.href = '#';
    link.onclick = (e) => {
      e.preventDefault();
      try { require('electron').shell.openExternal(HELP_URL); } catch(err) {}
    };
  }

  // ── Chart ─────────────────────────────────────────────────────
  _renderChart(parent, days) {
    const sec   = parent.createEl('div', { cls: 'au-section au-chart-section' });
    const chart = sec.createEl('div', { cls: 'au-chart' });
    const max   = Math.max(...days.map(d => d.total), 1);
    for (const day of days) {
      const ratio = max > 0 ? day.total / max : 0;
      const color = intensityColor(ratio, day.isToday);
      const col   = chart.createEl('div', { cls: 'au-chart-col' });
      const pct   = Math.max(Math.round(ratio * 100), day.total > 0 ? 4 : 0);
      const bar   = col.createEl('div', { cls: 'au-chart-bar' + (day.isToday ? ' au-bar-today' : '') });
      bar.style.height     = pct + '%';
      bar.style.background = color;
      if (day.isToday) bar.style.boxShadow = `0 0 8px ${color}`;
      bar.title = `${day.label}: ${fmtTokens(day.total)} T`;
      col.createEl('div', { cls: 'au-chart-lbl' + (day.isToday ? ' au-lbl-today' : ''), text: day.label });
    }
  }

  // ── Model bar ─────────────────────────────────────────────────
  _renderModelBar(parent, entries) {
    if (!entries || entries.length === 0) return;
    const dist = modelDistribution(entries);
    if (dist.length === 0) return;

    const sec = parent.createEl('div', { cls: 'au-section au-model-section' });
    sec.createEl('div', { cls: 'au-section-title', text: t('models') });

    const bar = sec.createEl('div', { cls: 'au-model-bar' });
    for (const m of dist) {
      if (m.pct === 0) continue;
      const seg = bar.createEl('div', { cls: 'au-model-seg' });
      seg.style.width      = `${m.pct}%`;
      seg.style.background = MODEL_COLORS[m.name] || MODEL_COLORS.Other;
      seg.title            = `${m.name}: ${m.count} calls · ${fmtTokens(m.tokens)} T · ${m.pct}%`;
    }

    const legend = sec.createEl('div', { cls: 'au-model-legend' });
    for (const m of dist) {
      if (m.count === 0) continue;
      const item = legend.createEl('span', { cls: 'au-model-legend-item' });
      const dot  = item.createEl('span', { cls: 'au-model-dot' });
      dot.style.background = MODEL_COLORS[m.name] || MODEL_COLORS.Other;
      item.createEl('span', { text: `${m.name} ${m.pct}%` });
    }
  }

  // ── Collapsible section helper ────────────────────────────────
  _makeSection(parent, key, title, badge = null) {
    const isCollapsed = this._collapsed.has(key);
    const sec  = parent.createEl('div',  { cls: 'au-section' });
    const hdr  = sec.createEl('div',    { cls: 'au-section-hdr' });
    const chev = hdr.createEl('span',   { cls: 'au-chevron', text: isCollapsed ? '▶' : '▼' });
    hdr.createEl('span', { cls: 'au-section-title', text: title });
    if (badge) hdr.createEl('span', { cls: 'au-spike-badge', text: badge });
    const body = sec.createEl('div',    { cls: 'au-section-body' });
    if (isCollapsed) body.style.display = 'none';
    hdr.addEventListener('click', () => {
      if (this._collapsed.has(key)) {
        this._collapsed.delete(key);
        chev.textContent   = '▼';
        body.style.display = '';
      } else {
        this._collapsed.add(key);
        chev.textContent   = '▶';
        body.style.display = 'none';
      }
    });
    return { sec, body };
  }

  // ── 5h Window ─────────────────────────────────────────────────
  _renderWindow5h(parent) {
    const { window5h } = this.data;
    if (window5h.agg.count === 0) {
      const { body } = this._makeSection(parent, '5h', t('last5h'));
      body.createEl('div', {
        cls:  'au-section-sub' + (window5h.cleared ? ' au-window-cleared' : ''),
        text: window5h.cleared ? t('windowCleared') : t('waiting'),
      });
      return;
    }
    const { body } = this._makeSection(parent, '5h', t('last5h'));
    body.createEl('div', { cls: 'au-section-sub', text: t('rollingWindow') });
    const maxVal = Math.max(window5h.agg.input, window5h.agg.output, window5h.agg.cacheCreate, window5h.agg.cacheRead, 1);
    this._statRow(body, t('rowInput'),  window5h.agg.input,       maxVal, 'blue');
    this._statRow(body, t('rowOutput'), window5h.agg.output,      maxVal, 'green');
    this._statRow(body, t('rowCWrite'), window5h.agg.cacheCreate, maxVal, 'purple');
    this._statRow(body, t('rowCRead'),  window5h.agg.cacheRead,   maxVal, 'amber');
  }

  // ── Period section ────────────────────────────────────────────
  _renderPeriod(parent, key, title, stats, subtitle) {
    if (stats.count === 0) return;
    const badge = (key === 'today' && this.data.spikeRatio >= 2)
      ? t('spikeAvg', this.data.spikeRatio.toFixed(1))
      : null;
    const { body } = this._makeSection(parent, key, title, badge);
    if (subtitle) body.createEl('div', { cls: 'au-section-sub', text: subtitle });
    const maxVal = Math.max(stats.input, stats.output, stats.cacheCreate, stats.cacheRead, 1);
    this._statRow(body, t('rowInput'),  stats.input,       maxVal, 'blue');
    this._statRow(body, t('rowOutput'), stats.output,      maxVal, 'green');
    this._statRow(body, t('rowCWrite'), stats.cacheCreate, maxVal, 'purple');
    this._statRow(body, t('rowCRead'),  stats.cacheRead,   maxVal, 'amber');
  }

  _statRow(parent, label, value, max, color) {
    const row = parent.createEl('div', { cls: 'au-stat-row' });
    row.createEl('span', { cls: 'au-stat-lbl', text: label });
    row.createEl('span', { cls: `au-stat-val au-text-${color}`, text: fmtTokens(value) });
    const wrap = row.createEl('div', { cls: 'au-mini-bar-wrap' });
    const bar  = wrap.createEl('div', { cls: `au-mini-bar au-bar-${color}` });
    // Log scale: keeps all non-zero values visible across large magnitude differences
    const pct = (value > 0 && max > 0)
      ? (Math.log(1 + value) / Math.log(1 + max) * 100).toFixed(1)
      : 0;
    bar.style.width = pct + '%';
  }

  // ── Report ────────────────────────────────────────────────────
  async _generateReport() {
    if (!this.data) { new obsidian.Notice(t('noData')); return; }
    const content    = this._buildReportContent();
    const reportPath = (this.plugin.settings.reportPath || 'Token Usage Report.md').trim();
    try {
      const existing = this.plugin.app.vault.getAbstractFileByPath(reportPath);
      if (existing) await this.plugin.app.vault.modify(existing, content);
      else          await this.plugin.app.vault.create(reportPath, content);
      const file = this.plugin.app.vault.getAbstractFileByPath(reportPath);
      if (file) await this.plugin.app.workspace.getLeaf(true).openFile(file);
      new obsidian.Notice(t('reportCreated'));
    } catch(e) {
      new obsidian.Notice(t('reportFailed') + e.message);
    }
  }

  _buildReportContent() {
    const d   = this.data;
    const now = d.updatedAt;
    const ts  = now.toLocaleString('en-GB');
    const fmt = (n) => fmtTokens(n);
    const lines = [];

    lines.push('---');
    lines.push('tags: [plugin, token-usage, report]');
    lines.push(`date: ${now.toISOString().slice(0, 10)}`);
    lines.push(`updated: "${ts}"`);
    lines.push('---', '', '# Token Usage Report', '');
    lines.push(`> Created by Token Usage Plugin v${this.plugin.manifest.version} on ${ts}`, '');

    if (d.lastAction) {
      const la = d.lastAction;
      lines.push('## Last Action', '');
      lines.push('| | |', '|---|---|');
      lines.push(`| Model | \`${la.model}\` |`);
      lines.push(`| Timestamp | ${new Date(la.timestamp).toLocaleString('en-GB')} |`);
      lines.push(`| Input | ${fmt(la.usage.input_tokens)} |`);
      lines.push(`| Output | ${fmt(la.usage.output_tokens)} |`);
      lines.push(`| Cache Write | ${fmt(la.usage.cache_creation_input_tokens)} |`);
      lines.push(`| Cache Read | ${fmt(la.usage.cache_read_input_tokens)} |`, '');
    }

    const w = d.window5h;
    lines.push('## 5h Window', '');
    if (w.agg.count > 0) {
      lines.push('| | |', '|---|---|');
      lines.push(`| Input | ${fmt(w.agg.input)} |`);
      lines.push(`| Output | ${fmt(w.agg.output)} |`);
      lines.push(`| Cache Write | ${fmt(w.agg.cacheCreate)} |`);
      lines.push(`| Cache Read | ${fmt(w.agg.cacheRead)} |`);
      lines.push(`| Total (In+Out) | ${fmt(w.total)} |`);
      if (w.oldest) {
        const msLeft = Math.max(0, w.oldest + 5 * 3_600_000 - Date.now());
        lines.push(`| Window resets in | ${fmtDuration(msLeft)} |`);
      }
    } else { lines.push('No activity in the last 5 hours.'); }
    lines.push('');

    const addPeriod = (title, stats) => {
      if (stats.count === 0) return;
      lines.push(`## ${title}`, '', '| | |', '|---|---|');
      lines.push(`| Input | ${fmt(stats.input)} |`);
      lines.push(`| Output | ${fmt(stats.output)} |`);
      lines.push(`| Cache Write | ${fmt(stats.cacheCreate)} |`);
      lines.push(`| Cache Read | ${fmt(stats.cacheRead)} |`);
      lines.push(`| API Calls | ${stats.count} |`, '');
    };
    addPeriod('This Session', d.session);
    addPeriod('Today',        d.today);
    addPeriod('7 Days',       d.day7);
    addPeriod('30 Days',      d.day30);

    const dist7 = modelDistribution(d.entries7);
    if (dist7.length > 0) {
      lines.push('## Models (7 Days)', '', '| Model | Calls | % | Tokens |', '|---|---|---|---|');
      for (const m of dist7) { lines.push(`| ${m.name} | ${m.count} | ${m.pct}% | ${fmt(m.tokens)} |`); }
      lines.push('');
    }

    const tc = d.day30.cacheCreate, tr = d.day30.cacheRead;
    lines.push('## Cache Efficiency (30 Days)', '', '| | |', '|---|---|');
    lines.push(`| Cache Write | ${fmt(tc)} |`);
    lines.push(`| Cache Read | ${fmt(tr)} |`);
    lines.push(`| Reuse Factor (Read/Write) | ${tc > 0 ? (tr / tc).toFixed(1) : 0}x |`, '');

    lines.push('## 7-Day Overview', '', '| Date | Input | Output | Total |', '|---|---|---|---|');
    for (const day of d.chart7) {
      lines.push(`| ${day.date}${day.isToday ? ' (today)' : ''} | ${fmt(day.input)} | ${fmt(day.output)} | ${fmt(day.total)} |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  // ── Dashboard ─────────────────────────────────────────────────
  async _generateDashboard() {
    if (!this.data) { new obsidian.Notice(t('noData')); return; }
    const html     = this._buildDashboard();
    const dashPath = (this.plugin.settings.dashboardPath || 'Token Usage Dashboard.html').trim();
    try {
      const existing = this.plugin.app.vault.getAbstractFileByPath(dashPath);
      if (existing) await this.plugin.app.vault.modify(existing, html);
      else          await this.plugin.app.vault.create(dashPath, html);
      const basePath = this.plugin.app.vault.adapter.basePath;
      const absPath  = path.join(basePath, dashPath);
      const { shell } = require('electron');
      await shell.openPath(absPath);
      new obsidian.Notice(t('dashOpened'));
    } catch(e) {
      new obsidian.Notice(t('dashFailed') + e.message);
    }
  }

  _buildDashboard() {
    const d       = this.data;
    const entries = d.entries30;
    const now     = d.updatedAt;

    const days30 = [];
    for (let i = 29; i >= 0; i--) {
      const from = daysAgoTs(i), to = from + 86_400_000;
      const dayE = entries.filter(e => e.timestamp >= from && e.timestamp < to);
      const byM  = { Haiku: 0, Sonnet: 0, Opus: 0, Fable: 0, Other: 0 };
      let reqs = 0, cacheCreate = 0, cacheRead = 0;
      for (const e of dayE) {
        const f = modelFamily(e.model);
        byM[f]      += e.usage.input_tokens + e.usage.output_tokens;
        cacheCreate += e.usage.cache_creation_input_tokens || 0;
        cacheRead   += e.usage.cache_read_input_tokens     || 0;
        reqs++;
      }
      days30.push({
        label: new Date(from).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }),
        ...byM, total: Object.values(byM).reduce((a, b) => a + b, 0),
        reqs, cacheCreate, cacheRead,
      });
    }

    const dist30           = modelDistribution(entries);
    const totalCacheCreate = entries.reduce((s, e) => s + (e.usage.cache_creation_input_tokens || 0), 0);
    const totalCacheRead   = entries.reduce((s, e) => s + (e.usage.cache_read_input_tokens     || 0), 0);
    const reuseRatio       = totalCacheCreate > 0 ? parseFloat((totalCacheRead / totalCacheCreate).toFixed(1)) : 0;

    const BKTS = [
      { label: '<1K', max: 1_000 }, { label: '1-5K', max: 5_000 },
      { label: '5-20K', max: 20_000 }, { label: '20-50K', max: 50_000 },
      { label: '50-100K', max: 100_000 }, { label: '100K+', max: Infinity },
    ];
    const hist = BKTS.map(b => ({ label: b.label, count: 0 }));
    for (const e of entries) {
      const t = e.usage.input_tokens + e.usage.output_tokens;
      const i = BKTS.findIndex(b => t < b.max);
      if (i >= 0) hist[i].count++;
    }

    const sessMap = {};
    for (const e of entries) {
      const sid = e.sessionId || 'unknown';
      if (!sessMap[sid]) sessMap[sid] = { id: sid.slice(0, 8), first: e.timestamp, tokens: 0, reqs: 0, models: {} };
      const s = sessMap[sid];
      s.tokens += e.usage.input_tokens + e.usage.output_tokens;
      s.reqs++;
      const f = modelFamily(e.model); s.models[f] = (s.models[f] || 0) + 1;
    }
    const topSess = Object.values(sessMap)
      .sort((a, b) => b.tokens - a.tokens).slice(0, 10)
      .map(s => ({
        ...s,
        start:   new Date(s.first).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
        primary: Object.entries(s.models).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other',
      }));

    const totalTok   = d.day30.input + d.day30.output;
    const avgPerReq  = d.day30.count > 0 ? Math.round(totalTok / d.day30.count) : 0;
    const activeDays = days30.filter(x => x.reqs > 0).length;

    // ── Rate Limit Analysis ─────────────────────────────────────────
    // Deduplicate type-aware:
    //   weekly  → max 1 per billing week (once hit, same limit until Sunday 18:00)
    //   session → 15-min window (parallel sessions can fire within seconds of each other)
    // In both cases the oldest event is kept — it is the causal one.
    const rlRaw = (d.rateLimitEvents || []).slice().sort((a, b) => a.timestamp - b.timestamp);
    const rlDeduped = [];
    const seenBillingWeeks = new Set();
    let lastSessionTs = 0;
    for (const ev of rlRaw) {
      if (ev.type === 'weekly') {
        const wk = billingWeekStart(ev.timestamp);
        if (!seenBillingWeeks.has(wk)) { seenBillingWeeks.add(wk); rlDeduped.push(ev); }
      } else {
        if (ev.timestamp - lastSessionTs > 15 * 60_000) { rlDeduped.push(ev); lastSessionTs = ev.timestamp; }
      }
    }
    // Compute token metrics at each rate-limit event:
    //   tok5h    — 5h rolling window (relevant for session-limit hits)
    //   tokWeek  — billing-week total up to the event (relevant for weekly-limit hits)
    const entries30sorted = d.entries30.slice().sort((a, b) => a.timestamp - b.timestamp);
    const rlEvents = rlDeduped.map(ev => {
      const wStart = ev.timestamp - 5 * 3_600_000;
      const tok5h  = entries30sorted
        .filter(e => e.timestamp >= wStart && e.timestamp <= ev.timestamp)
        .reduce((s, e) => s + e.usage.input_tokens + e.usage.output_tokens, 0);
      let tokWeek = 0;
      if (ev.type === 'weekly') {
        const wkStart = billingWeekStart(ev.timestamp);
        tokWeek = entries30sorted
          .filter(e => e.timestamp >= wkStart && e.timestamp <= ev.timestamp)
          .reduce((s, e) => s + e.usage.input_tokens + e.usage.output_tokens, 0);
      }
      return Object.assign({}, ev, { tok5h, tokWeek });
    });
    // Session limit estimate — use events with enough context (> 50 K = window not nearly empty)
    const sessHits = rlEvents.filter(r => r.type === 'session' && r.tok5h > 50_000);
    const rlSessionEst = sessHits.length > 0 ? {
      n:      sessHits.length,
      min:    Math.min.apply(null, sessHits.map(r => r.tok5h)),
      max:    Math.max.apply(null, sessHits.map(r => r.tok5h)),
      median: sessHits.map(r => r.tok5h).sort((a, b) => a - b)[Math.floor(sessHits.length / 2)],
    } : null;
    // Billing week buckets — Sunday 16:00 UTC = 18:00 CEST boundary
    function billingWeekStart(tsMs) {
      const dt = new Date(tsMs);
      let dow  = dt.getUTCDay(); // 0=Sun
      const h  = dt.getUTCHours();
      let dBack = dow;
      if (dow === 0 && h < 16) dBack = 7;
      const s = new Date(dt);
      s.setUTCDate(dt.getUTCDate() - dBack);
      s.setUTCHours(16, 0, 0, 0);
      return s.getTime();
    }
    const curWkStart = billingWeekStart(now.getTime());
    const weekBuckets = [];
    for (let i = 5; i >= 0; i--) {
      const wStart = curWkStart - i * 7 * 86_400_000;
      const wEnd   = wStart + 7 * 86_400_000;
      const wTok   = entries30sorted
        .filter(e => e.timestamp >= wStart && e.timestamp < wEnd)
        .reduce((s, e) => s + e.usage.input_tokens + e.usage.output_tokens, 0);
      const hitWeekly = rlEvents.some(r => r.type === 'weekly' && r.timestamp >= wStart && r.timestamp < wEnd);
      const wLabel = new Date(wStart).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })
        + '–' + new Date(wEnd - 86_400_000).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
      weekBuckets.push({ label: wLabel, tokens: wTok, hitWeekly });
    }
    const weeklyHitWks = weekBuckets.filter(w => w.hitWeekly && w.tokens > 0);
    const weeklyLimitEst = weeklyHitWks.length > 0
      ? Math.min.apply(null, weeklyHitWks.map(w => w.tokens))
      : null;

    const rateLimitPayload = {
      events:       rlEvents.slice().sort((a, b) => b.timestamp - a.timestamp).slice(0, 30),
      weeks:        weekBuckets,
      sessionEst:   rlSessionEst,
      weeklyEst:    weeklyLimitEst,
      weeklyHits:   weeklyHitWks.length,
      totalSession: rlEvents.filter(r => r.type === 'session').length,
      totalWeekly:  rlEvents.filter(r => r.type === 'weekly').length,
    };

    const safeJson = JSON.stringify({
      days30, dist30, hist, sessions: topSess,
      cache: { totalCreate: totalCacheCreate, totalRead: totalCacheRead, ratio: reuseRatio },
      rateLimit: rateLimitPayload,
    });

    return this._dashHtml({
      generated: now.toLocaleString('en-GB'),
      version:   this.plugin.manifest.version,
      totalTok:  fmtTokens(totalTok),
      totalReqs: d.day30.count.toLocaleString('en-GB'),
      activeDays: `${activeDays} / 30`,
      avgPerReq: fmtTokens(avgPerReq),
      safeJson,
    });
  }

  _dashHtml({ generated, version, totalTok, totalReqs, activeDays, avgPerReq, safeJson }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Token Usage Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;line-height:1.5}
.dash{max-width:1100px;margin:0 auto;padding:28px 20px 48px}
header{margin-bottom:24px;display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.logo-header{display:flex;align-items:center;gap:8px}
header h1{font-size:22px;font-weight:700;letter-spacing:-0.02em;background:linear-gradient(120deg,#4A90D9 0%,#9B5DE5 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.meta{font-size:11px;color:#64748b;margin-top:4px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:14px 16px;transition:border-color .25s}
.cv{font-size:22px;font-weight:700;color:#f1f5f9;font-variant-numeric:tabular-nums}
.cl{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-top:4px}
.cb{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin-bottom:16px}
.cb h2{font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px}
.crow{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}
th{font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px;text-align:left;border-bottom:1px solid #334155}
td{padding:8px 10px;font-size:12px;font-variant-numeric:tabular-nums;border-bottom:1px solid #1e293b;color:#cbd5e1}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.03)}
.badge{font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px}
.cache-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
.cache-explain{padding:14px 16px;background:rgba(255,255,255,0.03);border-radius:6px;border-left:3px solid #334155;color:#cbd5e1;font-size:12px;line-height:1.7}
.cache-explain strong{color:#f1f5f9}
.cache-explain .hint{margin-top:10px;font-size:11px;color:#64748b;line-height:1.6}
@media(max-width:700px){.cards{grid-template-columns:1fr 1fr}.crow{grid-template-columns:1fr}.cache-cards{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="dash">
  <header>
    <div>
      <div class="logo-header">
        <svg width="20" height="17" viewBox="0 0 15 12" fill="none" aria-hidden="true">
          <rect x="0"    y="7" width="2.5" height="5"  rx="0.6" fill="#4A90D9" opacity="0.45"/>
          <rect x="3.5"  y="3" width="2.5" height="9"  rx="0.6" fill="#4A90D9" opacity="0.65"/>
          <rect x="7"    y="0" width="2.5" height="12" rx="0.6" fill="#4A90D9"/>
          <rect x="10.5" y="4" width="2.5" height="8"  rx="0.6" fill="#9B5DE5" opacity="0.80"/>
        </svg>
        <h1>Token Usage Dashboard</h1>
      </div>
      <div class="meta">Generated ${generated} &nbsp;·&nbsp; Plugin v${version} &nbsp;·&nbsp; Last 30 days &nbsp;·&nbsp; <a href="https://www.langeatn.de/media/token-usage/" target="_blank" rel="noopener" style="color:#C9A227;text-decoration:none;">Help &amp; Glossary ↗</a></div>
    </div>
  </header>
  <div class="cards">
    <div class="card"><div class="cv">${totalTok}</div><div class="cl">Tokens (30 days)</div></div>
    <div class="card"><div class="cv">${totalReqs}</div><div class="cl">API calls</div></div>
    <div class="card"><div class="cv">${activeDays}</div><div class="cl">Active days</div></div>
    <div class="card"><div class="cv">${avgPerReq}</div><div class="cl">Avg tokens / call</div></div>
  </div>
  <div class="cb">
    <h2>Daily token usage — 30 days (by model)</h2>
    <canvas id="cDaily" height="110"></canvas>
  </div>
  <div class="crow">
    <div class="cb"><h2>Model distribution (calls)</h2><canvas id="cModel" height="220"></canvas></div>
    <div class="cb"><h2>Tokens per request</h2><canvas id="cDist" height="220"></canvas></div>
  </div>
  <div class="cb">
    <h2>Top sessions by token volume</h2>
    <table><thead><tr><th>Session</th><th>Start</th><th>Tokens</th><th>Calls</th><th>Model</th></tr></thead>
    <tbody id="tSess"></tbody></table>
  </div>
  <div class="cb">
    <h2>Rate limits</h2>
    <div id="rlEst" style="margin-bottom:14px;padding:10px 14px;background:rgba(255,255,255,0.03);border-radius:6px;border-left:3px solid #52B788;font-size:12px;line-height:1.7;color:#cbd5e1"></div>
    <table><thead><tr><th>Date</th><th>Time</th><th>Type</th><th>Tokens (inp+out)</th><th>Resets at</th></tr></thead>
    <tbody id="tRL"></tbody></table>
  </div>
  <div class="cb">
    <h2>Weekly consumption — billing week (Sun 18:00 → Sun 18:00 Europe/Berlin)</h2>
    <canvas id="cWeekly" height="90"></canvas>
  </div>
  <div class="cb">
    <h2>Cache efficiency &amp; usage patterns</h2>
    <div class="cache-cards">
      <div class="card"><div class="cv" id="ccCreate">—</div><div class="cl">Cache write (30d)</div></div>
      <div class="card"><div class="cv" id="ccRead">—</div><div class="cl">Cache read (30d)</div></div>
      <div class="card" id="ccRatioCard"><div class="cv" id="ccRatio">—</div><div class="cl">Reuse factor (read ÷ write)</div></div>
    </div>
    <canvas id="cCache" height="90" style="margin-bottom:14px"></canvas>
    <div class="cache-explain" id="ccExplain"></div>
  </div>
</div>
<script>
var D=${safeJson};
var C={Haiku:'#06B6D4',Sonnet:'#4A90D9',Opus:'#9B5DE5',Fable:'#E9C46A',Other:'#6B7280'};
function fN(n){if(!n)return'0';if(n>=1e9)return(n/1e9).toFixed(2)+'B';if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n);}
Chart.defaults.color='#94a3b8';Chart.defaults.borderColor='rgba(255,255,255,0.07)';
var models=['Haiku','Sonnet','Opus','Fable','Other'];
var used=models.filter(function(m){return D.days30.some(function(d){return d[m]>0;});});
new Chart(document.getElementById('cDaily'),{type:'bar',data:{labels:D.days30.map(function(d){return d.label;}),datasets:used.map(function(m){return{label:m,data:D.days30.map(function(d){return d[m]||0;}),backgroundColor:C[m],stack:'s'};})},options:{responsive:true,scales:{x:{stacked:true,grid:{color:'rgba(255,255,255,0.05)'}},y:{stacked:true,grid:{color:'rgba(255,255,255,0.05)'},ticks:{callback:function(v){return fN(v);}}}},plugins:{legend:{position:'top',labels:{boxWidth:10,font:{size:11}}},tooltip:{callbacks:{label:function(ctx){return' '+ctx.dataset.label+': '+fN(ctx.raw);}}}}}});
var dist=D.dist30.filter(function(m){return m.count>0;});
new Chart(document.getElementById('cModel'),{type:'doughnut',data:{labels:dist.map(function(m){return m.name;}),datasets:[{data:dist.map(function(m){return m.count;}),backgroundColor:dist.map(function(m){return C[m.name]||C.Other;}),borderWidth:2,borderColor:'#0f172a'}]},options:{responsive:true,plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}},tooltip:{callbacks:{label:function(ctx){var m=dist[ctx.dataIndex];return' '+m.name+': '+m.count+' calls ('+m.pct+'%)';}}}}}});
new Chart(document.getElementById('cDist'),{type:'bar',data:{labels:D.hist.map(function(h){return h.label;}),datasets:[{data:D.hist.map(function(h){return h.count;}),backgroundColor:'#4A90D9',borderRadius:3}]},options:{responsive:true,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return' '+ctx.raw+' requests';}}}},scales:{x:{grid:{color:'rgba(255,255,255,0.05)'}},y:{beginAtZero:true,grid:{color:'rgba(255,255,255,0.05)'}}}}});
var tbody=document.getElementById('tSess');
D.sessions.forEach(function(s){var tr=document.createElement('tr');var col=C[s.primary]||C.Other;tr.innerHTML='<td style="font-family:monospace;color:#64748b">'+s.id+'…</td><td>'+s.start+'</td><td style="color:#f1f5f9;font-weight:600">'+fN(s.tokens)+'</td><td>'+s.reqs+'</td><td><span class="badge" style="background:'+col+'22;color:'+col+'">'+s.primary+'</span></td>';tbody.appendChild(tr);});
(function(){var cache=D.cache;document.getElementById('ccCreate').textContent=fN(cache.totalCreate);document.getElementById('ccRead').textContent=fN(cache.totalRead);document.getElementById('ccRatio').textContent=cache.ratio+'x';var rc=document.getElementById('ccRatioCard'),r=cache.ratio;if(r>=8)rc.style.borderColor='#52B788';else if(r>=3)rc.style.borderColor='#4A90D9';else if(r>=1)rc.style.borderColor='#F59E0B';else if(r>0)rc.style.borderColor='#9B5DE5';
var h='',t='';
if(!cache.totalCreate&&!cache.totalRead){h='No cache data.';t='No cache tokens recorded in the last 30 days.';}
else if(r>=8){h='Deep focus mode.';t='You work intensely with the same context. Docs, artifacts or long chats are reused heavily — the model reads from cache instead of reprocessing. Efficient and cost-effective.';}
else if(r>=3){h='Balanced usage.';t='Focused phases alternate with fresh tasks. You bring new context regularly but also reuse existing material across multiple requests.';}
else if(r>=1){h='Exploratory mode.';t='You bring new context frequently — many different projects, short sessions, or frequent topic switches. Cache is created but rarely reused intensively.';}
else{h='Minimal cache reuse.';t='Almost every request brings fresh context. Highly exploratory or many independent short sessions without repeating the same source material.';}
var hint='Cache Write costs ~1.25× regular input — you pay a premium to store the context. Cache Read costs ~0.10× — 10× cheaper to reuse than reprocess. The Reuse Factor (Read ÷ Write) shows whether your investment in caching is paying off.';
document.getElementById('ccExplain').innerHTML='<strong>'+h+'</strong> '+t+'<div class="hint">'+hint+'</div>';
new Chart(document.getElementById('cCache'),{type:'line',data:{labels:D.days30.map(function(d){return d.label;}),datasets:[{label:'Cache Write',data:D.days30.map(function(d){return d.cacheCreate||0;}),borderColor:'#9B5DE5',backgroundColor:'rgba(155,93,229,0.08)',tension:0.35,fill:true,pointRadius:2,pointHoverRadius:4},{label:'Cache Read',data:D.days30.map(function(d){return d.cacheRead||0;}),borderColor:'#F59E0B',backgroundColor:'rgba(245,158,11,0.08)',tension:0.35,fill:true,pointRadius:2,pointHoverRadius:4}]},options:{responsive:true,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'top',labels:{boxWidth:10,font:{size:11}}},tooltip:{callbacks:{label:function(ctx){return' '+ctx.dataset.label+': '+fN(ctx.raw);}}}},scales:{x:{grid:{color:'rgba(255,255,255,0.05)'}},y:{beginAtZero:true,grid:{color:'rgba(255,255,255,0.05)'},ticks:{callback:function(v){return fN(v);}}}}}});
}());
// ── Rate Limits section ──────────────────────────────────────────
(function(){
  var RL = D.rateLimit;
  if (!RL) return;
  // Estimate banner
  var estEl = document.getElementById('rlEst');
  var estHtml = '';
  if (RL.sessionEst && RL.sessionEst.n > 0) {
    var se = RL.sessionEst;
    estHtml += '<strong>Session limit estimate: ~' + fN(se.min) + ' – ' + fN(se.max) + ' tokens / 5h</strong>'
      + ' &nbsp;·&nbsp; median ' + fN(se.median) + ' &nbsp;·&nbsp; ' + se.n + ' observed hits (last 30 days)';
  } else {
    estHtml += '<strong>Session limit estimate:</strong> not enough data yet (need observed hits with > 50 K tokens in 5h window)';
  }
  if (RL.weeklyEst) {
    estHtml += '<br><strong>Weekly limit estimate: ≥ ' + fN(RL.weeklyEst) + ' tokens / week</strong>'
      + ' (conservative lower bound from ' + RL.weeklyHits + ' weekly-limit event' + (RL.weeklyHits !== 1 ? 's' : '') + ')';
  }
  estHtml += '<br><span style="color:#64748b;font-size:11px">'
    + RL.totalSession + ' session-limit hit' + (RL.totalSession !== 1 ? 's' : '')
    + ' &nbsp;·&nbsp; ' + RL.totalWeekly + ' weekly-limit hit' + (RL.totalWeekly !== 1 ? 's' : '')
    + ' in last 30 days. Anthropic does not publish these limits — all values are empirical.</span>';
  estEl.innerHTML = estHtml;
  // Events table
  var tbody = document.getElementById('tRL');
  RL.events.forEach(function(ev) {
    var tr  = document.createElement('tr');
    var dt  = new Date(ev.timestamp);
    var dStr = dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
    var tStr = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    var col  = ev.type === 'weekly' ? '#F59E0B' : '#9B5DE5';
    var tok = ev.type === 'weekly'
      ? (ev.tokWeek > 0 ? fN(ev.tokWeek) + '<br><span style="font-size:10px;color:#64748b">billing week</span>' : '—')
      : (ev.tok5h  > 0 ? fN(ev.tok5h)   + '<br><span style="font-size:10px;color:#64748b">5h window</span>'   : '—');
    tr.innerHTML = '<td>' + dStr + '</td><td>' + tStr + '</td>'
      + '<td><span class="badge" style="background:' + col + '22;color:' + col + '">' + ev.type + '</span></td>'
      + '<td style="color:#f1f5f9;font-weight:600">' + tok + '</td>'
      + '<td style="color:#64748b">' + (ev.reset || '—') + '</td>';
    tbody.appendChild(tr);
  });
  // Weekly chart
  if (RL.weeks && RL.weeks.length > 0) {
    new Chart(document.getElementById('cWeekly'), {
      type: 'bar',
      data: {
        labels: RL.weeks.map(function(w) { return w.label; }),
        datasets: [{
          label: 'Tokens (inp+out)',
          data: RL.weeks.map(function(w) { return w.tokens; }),
          backgroundColor: RL.weeks.map(function(w) { return w.hitWeekly ? '#F59E0B' : '#4A90D9'; }),
          borderRadius: 3,
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function(ctx) {
            var w = RL.weeks[ctx.dataIndex];
            return ' ' + fN(ctx.raw) + (w.hitWeekly ? '  ⚠ weekly limit hit' : '');
          }}}
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { callback: function(v) { return fN(v); } } }
        }
      }
    });
  }
}());
<\/script>
</body>
</html>`;
  }
}

// ── Settings ──────────────────────────────────────────────────────
class AnthropicUsageSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Token Usage' });
    new obsidian.Setting(containerEl)
      .setName(t('settingLang'))
      .setDesc(t('settingLangDesc'))
      .addDropdown(dd => dd
        .addOption('en', 'English')
        .addOption('de', 'Deutsch')
        .addOption('fr', 'Français')
        .addOption('it', 'Italiano')
        .setValue(this.plugin.settings.language || 'en')
        .onChange(async v => {
          this.plugin.settings.language = v;
          _lang = v;
          await this.plugin.saveSettings();
          // Re-render any open sidebar view immediately
          this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(l => {
            if (l.view instanceof AnthropicUsageView) l.view.render();
          });
          this.display(); // refresh settings labels too
        }));
    new obsidian.Setting(containerEl)
      .setName(t('settingRefresh'))
      .setDesc(t('settingRefreshDesc'))
      .addText(txt => txt.setPlaceholder('30').setValue(String(this.plugin.settings.refreshSeconds))
        .onChange(async v => { const n = parseInt(v); if (!isNaN(n) && n >= 5) { this.plugin.settings.refreshSeconds = n; await this.plugin.saveSettings(); } }));
    new obsidian.Setting(containerEl)
      .setName(t('settingReport'))
      .setDesc(t('settingReportDesc'))
      .addText(txt => txt.setPlaceholder('Token Usage Report.md').setValue(this.plugin.settings.reportPath || 'Token Usage Report.md')
        .onChange(async v => { if (v.trim()) { this.plugin.settings.reportPath = v.trim(); await this.plugin.saveSettings(); } }));
    new obsidian.Setting(containerEl)
      .setName(t('settingDash'))
      .setDesc(t('settingDashDesc'))
      .addText(txt => txt.setPlaceholder('Token Usage Dashboard.html').setValue(this.plugin.settings.dashboardPath || 'Token Usage Dashboard.html')
        .onChange(async v => { if (v.trim()) { this.plugin.settings.dashboardPath = v.trim(); await this.plugin.saveSettings(); } }));
    containerEl.createEl('p', { cls: 'au-settings-info', text: t('settingSource', CLAUDE_DIR) });
  }
}

// ── Plugin ────────────────────────────────────────────────────────
class AnthropicUsagePlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, leaf => new AnthropicUsageView(leaf, this));
    this.addRibbonIcon('activity', 'Token Usage', () => this.activateView());
    this.addCommand({ id: 'open-token-usage', name: 'Open Token Usage', callback: () => this.activateView() });
    this.addCommand({
      id: 'generate-token-report', name: 'Create Token Usage report',
      callback: () => { const l = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]; if (l?.view instanceof AnthropicUsageView) l.view._generateReport(); }
    });
    this.addCommand({
      id: 'generate-token-dashboard', name: 'Open Token Usage dashboard',
      callback: () => { const l = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]; if (l?.view instanceof AnthropicUsageView) l.view._generateDashboard(); }
    });
    this.addSettingTab(new AnthropicUsageSettingTab(this.app, this));
    this.registerInterval(window.setInterval(
      () => this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(l => { if (l.view instanceof AnthropicUsageView) l.view.refresh(); }),
      (this.settings.refreshSeconds || 30) * 1000
    ));
  }
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = workspace.getRightLeaf(false); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    workspace.revealLeaf(leaf);
  }
  async loadSettings()  { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); _lang = this.settings.language || 'en'; }
  async saveSettings()  { await this.saveData(this.settings); _lang = this.settings.language || 'en'; }
}

module.exports = AnthropicUsagePlugin;
