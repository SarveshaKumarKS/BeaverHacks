import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: "#050505",
        foreground: "#ededed",
        panel: "#0e0e0e",
        optimizer: "#f6c453",
        vibe: "#f472b6",
        amber: "#f6c453",
      },
      boxShadow: {
        optimizer: "0 0 32px rgba(246,196,83,0.55)",
        vibe: "0 0 32px rgba(244,114,182,0.55)",
      },
    },
  },
  plugins: [],
};

export default config;
