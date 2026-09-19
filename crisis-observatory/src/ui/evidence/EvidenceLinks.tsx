import { ArrowUpRight, BookOpen } from "lucide-react";
import type { Evidence } from "./model";
import "./evidence.css";
export default function EvidenceLinks({ refs, inline = false }: { refs: Evidence[]; inline?: boolean }) {
  if (!refs.length) return null;
  return <span className={`evidence-links ${inline ? "inline" : ""}`}>
    {refs.map((ref, index) => <a key={ref.id} className="evidence-citation"
      href={ref.href} target="_blank" rel="noopener noreferrer"
      aria-label={`Política ${ref.label}: ${ref.title} (abre en otra pestaña)`}
      title={`${ref.label} · ${ref.title}`}>
      {inline ? index + 1 : <><BookOpen size={12} /><span>{ref.label}</span><ArrowUpRight size={11} /></>}
    </a>)}
  </span>;
}
