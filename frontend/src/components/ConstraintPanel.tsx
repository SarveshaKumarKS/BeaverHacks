"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function ConstraintPanel({ constraints, missingFields }: { constraints: Record<string, string>; missingFields: string[] }) {
  const entries = Object.entries(constraints);

  return (
    <aside className={cn("rounded-lg border bg-panel p-4", missingFields.length ? "border-red-400/70" : "border-white/10")}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Constraints</h2>
        {missingFields.length ? <AlertTriangle className="text-red-300" size={20} /> : <CheckCircle2 className="text-emerald-300" size={20} />}
      </div>
      <div className="space-y-3">
        {entries.map(([key, value]) => {
          const missing = missingFields.includes(key);
          const known = value && value !== "Unknown";
          return (
            <div key={key} className={cn("rounded-md border p-3", missing ? "border-red-300 bg-red-400/10" : "border-white/10 bg-white/5")}>
              <div className="flex items-center gap-2">
                <span className={cn("h-3 w-3 rounded-sm border", known ? "border-emerald-300 bg-emerald-300" : "border-white/40")} />
                <span className="text-sm font-medium capitalize text-white/85">{key.replaceAll("_", " ")}</span>
              </div>
              <p className="mt-1 text-sm text-white/55">{value}</p>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

