import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compare } from "../compare";
import { fmt, METRIC_LABELS, providerColor, STATUS, statusOf } from "../format";
import type { AIModel, Metrics } from "../types";

const CHART_METRICS: (keyof Metrics)[] = ["cost_per_1k_tokens", "context_window", "tokens_per_sec", "elo_score"];

export default function SidePanel({
  model,
  models,
  onClose,
}: {
  model: AIModel;
  models: Map<string, AIModel>;
  onClose: () => void;
}) {
  const parent = model.parent_model_id ? models.get(model.parent_model_id) : undefined;
  const [targetId, setTargetId] = useState<string | null>(parent?.id ?? null);

  // Default comparison target is the predecessor; reset when the selection changes.
  useEffect(() => setTargetId(parent?.id ?? null), [model.id, parent?.id]);

  const target = targetId ? models.get(targetId) : undefined;
  const comparison = useMemo(() => (target ? compare(model, target) : null), [model, target]);

  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto border-l border-slate-800/80 bg-[#070c22]/95 backdrop-blur md:w-[380px]">
      <header className="flex items-start gap-3 border-b border-slate-800 p-4">
        <span
          className="mt-1.5 h-3 w-3 shrink-0 rounded-full"
          style={{ background: providerColor(model.provider) }}
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{model.name}</h2>
          <p className="text-sm text-slate-400">
            {model.provider}
            {model.release_date ? ` · sorti le ${model.release_date}` : ""}
          </p>
          {parent && <p className="text-xs text-slate-500">dérivé de {parent.name}</p>}
          <div
            className="mt-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ color: STATUS[statusOf(model)].color, background: `${STATUS[statusOf(model)].color}22` }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS[statusOf(model)].color }} />
            {STATUS[statusOf(model)].label}
          </div>
          {model.status_detail && <p className="mt-1 text-xs text-slate-400">{model.status_detail}</p>}
          <p className="mt-1 text-xs text-slate-500">
            Analyse de sécurité Hugging Face :{" "}
            {!model.security
              ? "pas encore lue"
              : model.security.issues.length > 0
                ? <span className="text-violet-300">{model.security.issues.length} fichier(s) signalé(s)</span>
                : model.security.scanned
                  ? <span className="text-emerald-400">aucun fichier dangereux</span>
                  : "analyse en attente chez Hugging Face"}
          </p>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Fermer">
          ✕
        </button>
      </header>

      {/* Only metrics the sources actually provide for this model. */}
      <section className="grid grid-cols-2 gap-2 p-4 text-sm">
        {(Object.keys(METRIC_LABELS) as (keyof Metrics)[])
          .filter((k) => model.metrics[k] != null)
          .map((k) => (
            <div key={k} className="rounded-lg bg-slate-800/60 px-3 py-2">
              <div className="text-[11px] text-slate-400">{METRIC_LABELS[k]}</div>
              <div className="font-mono">{fmt(model.metrics[k], k === "cost_per_1k_tokens" ? 4 : 1)}</div>
            </div>
          ))}
        {model.usage.download_count_24h != null && (
          <div className="rounded-lg bg-slate-800/60 px-3 py-2">
            <div className="text-[11px] text-slate-400">Téléchargements / jour (moy. 30 j)</div>
            <div className="font-mono">{fmt(model.usage.download_count_24h)}</div>
          </div>
        )}
        {model.usage.active_requests_est != null && (
          <div className="rounded-lg bg-slate-800/60 px-3 py-2">
            <div className="text-[11px] text-slate-400">Requêtes actives (est.)</div>
            <div className="font-mono">{fmt(model.usage.active_requests_est)}</div>
          </div>
        )}
        <p className="col-span-2 text-[11px] leading-snug text-slate-500">
          Non publiés par Hugging Face ni OpenRouter : vitesse, latence, ELO, nombre de requêtes, taux d'erreur.
        </p>
      </section>

      <section className="border-t border-slate-800 p-4">
        <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-400">
          Comparer avec
        </label>
        <select
          className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm"
          value={targetId ?? ""}
          onChange={(e) => setTargetId(e.target.value || null)}
        >
          <option value="">— choisir un modèle —</option>
          {[...models.values()]
            .filter((m) => m.id !== model.id)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.id === parent?.id ? " (prédécesseur)" : ""}
              </option>
            ))}
        </select>

        {comparison && target && (
          <>
            <ul className="mt-4 space-y-1.5 text-sm">
              {comparison.deltas.every((d) => d.label === "n/a") && (
                <li className="text-slate-500">Aucune mesure disponible pour les deux modèles.</li>
              )}
              {comparison.deltas.filter((d) => d.label !== "n/a").map((d) => (
                <li key={d.metric} className="flex justify-between gap-2">
                  <span className="text-slate-400">{METRIC_LABELS[d.metric]}</span>
                  <span
                    className={
                      d.better == null ? "text-slate-500" : d.better ? "text-emerald-400" : "text-rose-400"
                    }
                  >
                    {d.label}
                  </span>
                </li>
              ))}
            </ul>

            {CHART_METRICS.filter((k) => model.metrics[k] != null && target.metrics[k] != null).map((k) => (
              <div key={k} className="mt-5">
                <div className="mb-1 text-xs text-slate-400">{METRIC_LABELS[k]}</div>
                <ResponsiveContainer width="100%" height={70}>
                  <BarChart
                    layout="vertical"
                    data={[
                      { name: model.name, v: model.metrics[k] ?? 0, c: providerColor(model.provider) },
                      { name: target.name, v: target.metrics[k] ?? 0, c: "#64748b" },
                    ]}
                    margin={{ left: 0, right: 16 }}
                  >
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" width={110} tick={{ fill: "#94a3b8", fontSize: 11 }} />
                    <Tooltip
                      cursor={{ fill: "rgba(255,255,255,0.04)" }}
                      contentStyle={{ background: "#0f172a", border: "1px solid #334155" }}
                    />
                    <Bar dataKey="v" radius={[0, 4, 4, 0]} isAnimationActive>
                      {[0, 1].map((i) => (
                        <Cell key={i} fill={i === 0 ? providerColor(model.provider) : "#64748b"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ))}
          </>
        )}
      </section>
    </aside>
  );
}
