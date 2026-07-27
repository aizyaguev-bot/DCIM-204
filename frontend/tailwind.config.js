/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
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
