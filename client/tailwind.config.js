/** @type {import('tailwindcss').Config} */
// Mind Atlas design tokens. Every colour is a CSS variable (see src/index.css)
// so the light / dark themes swap without touching a single class, and every
// colour supports Tailwind opacity modifiers (bg-secondary/40) through
// color-mix.
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  darkMode: "class",
  theme: {
    extend: {
      "colors": {
        "secondary-fixed-dim": "color-mix(in srgb, var(--c-secondary-fixed-dim) calc(<alpha-value> * 100%), transparent)",
        "surface-dim": "color-mix(in srgb, var(--c-surface-dim) calc(<alpha-value> * 100%), transparent)",
        "background": "color-mix(in srgb, var(--c-background) calc(<alpha-value> * 100%), transparent)",
        "on-primary": "color-mix(in srgb, var(--c-on-primary) calc(<alpha-value> * 100%), transparent)",
        "on-primary-fixed": "color-mix(in srgb, var(--c-on-primary-fixed) calc(<alpha-value> * 100%), transparent)",
        "on-tertiary-container": "color-mix(in srgb, var(--c-on-tertiary-container) calc(<alpha-value> * 100%), transparent)",
        "surface-container": "color-mix(in srgb, var(--c-surface-container) calc(<alpha-value> * 100%), transparent)",
        "secondary-fixed": "color-mix(in srgb, var(--c-secondary-fixed) calc(<alpha-value> * 100%), transparent)",
        "on-error": "color-mix(in srgb, var(--c-on-error) calc(<alpha-value> * 100%), transparent)",
        "error-container": "color-mix(in srgb, var(--c-error-container) calc(<alpha-value> * 100%), transparent)",
        "tertiary-fixed-dim": "color-mix(in srgb, var(--c-tertiary-fixed-dim) calc(<alpha-value> * 100%), transparent)",
        "on-tertiary": "color-mix(in srgb, var(--c-on-tertiary) calc(<alpha-value> * 100%), transparent)",
        "secondary": "color-mix(in srgb, var(--c-secondary) calc(<alpha-value> * 100%), transparent)",
        "surface-container-lowest": "color-mix(in srgb, var(--c-surface-container-lowest) calc(<alpha-value> * 100%), transparent)",
        "error": "color-mix(in srgb, var(--c-error) calc(<alpha-value> * 100%), transparent)",
        "on-secondary-container": "color-mix(in srgb, var(--c-on-secondary-container) calc(<alpha-value> * 100%), transparent)",
        "primary-fixed": "color-mix(in srgb, var(--c-primary-fixed) calc(<alpha-value> * 100%), transparent)",
        "outline": "color-mix(in srgb, var(--c-outline) calc(<alpha-value> * 100%), transparent)",
        "surface": "color-mix(in srgb, var(--c-surface) calc(<alpha-value> * 100%), transparent)",
        "on-primary-fixed-variant": "color-mix(in srgb, var(--c-on-primary-fixed-variant) calc(<alpha-value> * 100%), transparent)",
        "secondary-container": "color-mix(in srgb, var(--c-secondary-container) calc(<alpha-value> * 100%), transparent)",
        "surface-tint": "color-mix(in srgb, var(--c-surface-tint) calc(<alpha-value> * 100%), transparent)",
        "surface-container-highest": "color-mix(in srgb, var(--c-surface-container-highest) calc(<alpha-value> * 100%), transparent)",
        "on-secondary": "color-mix(in srgb, var(--c-on-secondary) calc(<alpha-value> * 100%), transparent)",
        "on-tertiary-fixed-variant": "color-mix(in srgb, var(--c-on-tertiary-fixed-variant) calc(<alpha-value> * 100%), transparent)",
        "on-error-container": "color-mix(in srgb, var(--c-on-error-container) calc(<alpha-value> * 100%), transparent)",
        "inverse-primary": "color-mix(in srgb, var(--c-inverse-primary) calc(<alpha-value> * 100%), transparent)",
        "outline-variant": "color-mix(in srgb, var(--c-outline-variant) calc(<alpha-value> * 100%), transparent)",
        "on-secondary-fixed-variant": "color-mix(in srgb, var(--c-on-secondary-fixed-variant) calc(<alpha-value> * 100%), transparent)",
        "surface-variant": "color-mix(in srgb, var(--c-surface-variant) calc(<alpha-value> * 100%), transparent)",
        "surface-container-high": "color-mix(in srgb, var(--c-surface-container-high) calc(<alpha-value> * 100%), transparent)",
        "on-surface-variant": "color-mix(in srgb, var(--c-on-surface-variant) calc(<alpha-value> * 100%), transparent)",
        "surface-bright": "color-mix(in srgb, var(--c-surface-bright) calc(<alpha-value> * 100%), transparent)",
        "inverse-surface": "color-mix(in srgb, var(--c-inverse-surface) calc(<alpha-value> * 100%), transparent)",
        "primary-container": "color-mix(in srgb, var(--c-primary-container) calc(<alpha-value> * 100%), transparent)",
        "primary-fixed-dim": "color-mix(in srgb, var(--c-primary-fixed-dim) calc(<alpha-value> * 100%), transparent)",
        "on-primary-container": "color-mix(in srgb, var(--c-on-primary-container) calc(<alpha-value> * 100%), transparent)",
        "inverse-on-surface": "color-mix(in srgb, var(--c-inverse-on-surface) calc(<alpha-value> * 100%), transparent)",
        "surface-container-low": "color-mix(in srgb, var(--c-surface-container-low) calc(<alpha-value> * 100%), transparent)",
        "tertiary-fixed": "color-mix(in srgb, var(--c-tertiary-fixed) calc(<alpha-value> * 100%), transparent)",
        "on-tertiary-fixed": "color-mix(in srgb, var(--c-on-tertiary-fixed) calc(<alpha-value> * 100%), transparent)",
        "on-background": "color-mix(in srgb, var(--c-on-background) calc(<alpha-value> * 100%), transparent)",
        "tertiary": "color-mix(in srgb, var(--c-tertiary) calc(<alpha-value> * 100%), transparent)",
        "primary": "color-mix(in srgb, var(--c-primary) calc(<alpha-value> * 100%), transparent)",
        "on-surface": "color-mix(in srgb, var(--c-on-surface) calc(<alpha-value> * 100%), transparent)",
        "on-secondary-fixed": "color-mix(in srgb, var(--c-on-secondary-fixed) calc(<alpha-value> * 100%), transparent)",
        "tertiary-container": "color-mix(in srgb, var(--c-tertiary-container) calc(<alpha-value> * 100%), transparent)"
      },
      "borderRadius": {
        "DEFAULT": "0.375rem",
        "lg": "0.625rem",
        "xl": "1.125rem",
        "full": "9999px"
      },
      "spacing": {
        "sidebar-width": "4.75rem",
        "space-lg": "1.5rem",
        "space-2xl": "3rem",
        "space-base": "1rem",
        "space-xl": "2rem",
        "space-2xs": "0.125rem",
        "space-3xl": "4rem",
        "inspector-width": "22rem",
        "space-xs": "0.25rem",
        "gutter-canvas": "1.5rem",
        "space-sm": "0.5rem",
        "space-md": "0.75rem"
      },
      "fontFamily": {
        "label-md": [
          "Manrope",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif"
        ],
        "ui-title": [
          "Manrope",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif"
        ],
        "display-lg": [
          "Manrope",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif"
        ],
        "body-sm": [
          "Manrope",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif"
        ],
        "label-lg": [
          "Manrope",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif"
        ],
        "headline-sm": [
          "Manrope",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif"
        ],
        "headline-lg": [
          "Manrope",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif"
        ],
        "ui-body": [
          "Manrope",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif"
        ],
        "label-sm": [
          "Manrope",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif"
        ],
        "headline-md": [
          "Manrope",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif"
        ],
        "body-md": [
          "Manrope",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif"
        ],
        "body-lg": [
          "Manrope",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif"
        ],
        "sans": [
          "Manrope",
          "system-ui",
          "sans-serif"
        ]
      },
      "fontSize": {
        "label-md": [
          "11px",
          {
            "lineHeight": "14px",
            "letterSpacing": "0.03em",
            "fontWeight": "600"
          }
        ],
        "ui-title": [
          "15px",
          {
            "lineHeight": "20px",
            "letterSpacing": "-0.01em",
            "fontWeight": "600"
          }
        ],
        "display-lg": [
          "40px",
          {
            "lineHeight": "48px",
            "letterSpacing": "-0.02em",
            "fontWeight": "600"
          }
        ],
        "body-sm": [
          "13px",
          {
            "lineHeight": "20px",
            "fontWeight": "400"
          }
        ],
        "label-lg": [
          "12px",
          {
            "lineHeight": "16px",
            "letterSpacing": "0.02em",
            "fontWeight": "600"
          }
        ],
        "headline-sm": [
          "20px",
          {
            "lineHeight": "28px",
            "fontWeight": "500"
          }
        ],
        "headline-lg": [
          "30px",
          {
            "lineHeight": "38px",
            "letterSpacing": "-0.015em",
            "fontWeight": "600"
          }
        ],
        "ui-body": [
          "13px",
          {
            "lineHeight": "18px",
            "fontWeight": "500"
          }
        ],
        "label-sm": [
          "10px",
          {
            "lineHeight": "12px",
            "letterSpacing": "0.04em",
            "fontWeight": "700"
          }
        ],
        "headline-md": [
          "24px",
          {
            "lineHeight": "32px",
            "letterSpacing": "-0.01em",
            "fontWeight": "600"
          }
        ],
        "body-md": [
          "15px",
          {
            "lineHeight": "24px",
            "letterSpacing": "0.005em",
            "fontWeight": "400"
          }
        ],
        "body-lg": [
          "17px",
          {
            "lineHeight": "28px",
            "letterSpacing": "0.005em",
            "fontWeight": "400"
          }
        ]
      }
    },
  },
  plugins: [],
};
