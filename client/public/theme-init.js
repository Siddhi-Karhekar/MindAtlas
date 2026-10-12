// Apply the saved theme before first paint so dark mode never flashes light.
// A file of its own (not an inline <script>) so the page's Content Security
// Policy can refuse every inline script.
(function () {
  try {
    var t = localStorage.getItem("mindatlas_theme") || "system";
    var dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
  } catch {
    // no storage: the default theme is used
  }
})();
