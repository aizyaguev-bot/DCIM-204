/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      borderRadius: {sm:"2px",DEFAULT:"2px",md:"2px",lg:"2px",xl:"2px","2xl":"2px","3xl":"2px"},
      boxShadow: {sm:"none",DEFAULT:"none",md:"none",lg:"none",xl:"none","2xl":"none"},
      colors: {
        zinc: { 50: "#fafafa", 100: "#fff", 200: "#eee", 300: "#ccc", 400: "#a7a7a7", 500: "#a7a7a7", 600: "#757575", 700: "#4b4b4b", 800: "#333", 900: "#161616", 950: "#0c0c0c" },
        nv: {
          50:  "#f2fbe6",
          100: "#dff7c2",
          300: "#9fe040",
          400: "#76b900",
          500: "#5e9300",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Consolas", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
