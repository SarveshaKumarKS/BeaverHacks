import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: "#0d1117",
        foreground: "#f6f7fb",
        panel: "#151b23",
        optimizer: "#38bdf8",
        vibe: "#f472b6",
        amber: "#f6c453"
      },
      boxShadow: {
        optimizer: "0 0 28px rgba(56,189,248,0.45)",
        vibe: "0 0 28px rgba(244,114,182,0.45)"
      }
    }
  },
  plugins: []
};

export default config;

