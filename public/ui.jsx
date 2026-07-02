// Gemeinsame UI-Primitives (Spinner, BrandMark, LoadingScreen, ThemeToggle)
// und der Theme-Helfer. Wird direkt nach data.jsx geladen, damit alle Views
// die Komponenten über window.* nutzen können.

(function () {
  const THEME_KEY = "knowflow-theme";

  function applyTheme(mode) {
    const d = document.documentElement;
    d.dataset.theme = mode;
    d.dataset.bsTheme = mode;
    window.dispatchEvent(new CustomEvent("knowflow:theme-changed", { detail: { theme: mode } }));
  }

  window.KNOWFLOW_THEME = {
    get() {
      return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    },
    set(mode) {
      try { localStorage.setItem(THEME_KEY, mode); } catch (_e) { /* Speicher blockiert */ }
      applyTheme(mode);
    },
    toggle() {
      window.KNOWFLOW_THEME.set(window.KNOWFLOW_THEME.get() === "dark" ? "light" : "dark");
    },
  };

  // Ohne gespeicherte Präferenz der Systemeinstellung live folgen.
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      let stored = null;
      try { stored = localStorage.getItem(THEME_KEY); } catch (_e) { /* ignore */ }
      if (stored !== "light" && stored !== "dark") applyTheme(e.matches ? "dark" : "light");
    });
  } catch (_e) { /* ältere Browser */ }
})();

// Kreisender Lade-Indikator. Erbt die Textfarbe des Elternelements
// (currentColor), funktioniert also auf Buttons in beiden Themes.
function Spinner({ size = 14, className = "" }) {
  return (
    <span
      className={"spinner " + className}
      style={{ width: size, height: size }}
      role="status"
      aria-hidden="true"
    ></span>
  );
}

// Die KnowFlow-Logo-Glyphe: zwei Ströme, die in einen Punkt zusammenlaufen
// (Tickets → Wissensbasis). Gleiche Pfade wie in favicon.svg.
function BrandMark({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round">
        <path d="M13 21 C 27 21, 29 32, 43 32" />
        <path d="M13 43 C 27 43, 29 32, 43 32" />
      </g>
      <circle cx="50" cy="32" r="4.5" fill="currentColor" />
    </svg>
  );
}

// Vollbild-Ladeanzeige für den App-Start (statt eines leeren Bildschirms).
function LoadingScreen({ label }) {
  return (
    <div className="boot-screen">
      <div className="boot-mark"><BrandMark size={30} /></div>
      <Spinner size={26} className="boot-spinner" />
      <div className="boot-label">{label || "Dashboard wird geladen…"}</div>
    </div>
  );
}

// Umschalter Hell/Dunkel. Lauscht auf knowflow:theme-changed, damit mehrere
// Instanzen (Sidebar + Topbar) synchron bleiben.
function ThemeToggle() {
  const [theme, setTheme] = React.useState(window.KNOWFLOW_THEME.get());
  React.useEffect(() => {
    const handler = (e) => setTheme((e.detail && e.detail.theme) || window.KNOWFLOW_THEME.get());
    window.addEventListener("knowflow:theme-changed", handler);
    return () => window.removeEventListener("knowflow:theme-changed", handler);
  }, []);
  const dark = theme === "dark";
  return (
    <button
      className="theme-toggle"
      onClick={() => window.KNOWFLOW_THEME.toggle()}
      title={dark ? "Helles Design" : "Dunkles Design"}
      aria-label={dark ? "Zum hellen Design wechseln" : "Zum dunklen Design wechseln"}
    >
      <i className={"bi " + (dark ? "bi-sun" : "bi-moon-stars")}></i>
    </button>
  );
}

window.Spinner = Spinner;
window.BrandMark = BrandMark;
window.LoadingScreen = LoadingScreen;
window.ThemeToggle = ThemeToggle;
