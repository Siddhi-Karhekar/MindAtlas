/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // matches the established Mind Atlas UI prototype palette
        page: "#f4f3ee",
        surface: "#ffffff",
        primary: { DEFAULT: "#364156", container: "#dfe3e8" },
        secondary: { DEFAULT: "#5d7a68", container: "#e2ebe4" },
        tertiary: { DEFAULT: "#c98e3d", container: "#f6e6cc" },
        error: "#ef4444",
        ink: "#1f2430",
        "ink-soft": "#5a6270",
      },
      fontFamily: {
        sans: ["Manrope", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
