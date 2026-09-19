import { Megaphone } from "lucide-react";
import { elapsed, type TickRecord } from "../engineTrace";
import "./press.css";

type Note = NonNullable<TickRecord["press"]>;

/** The public statements of the run, newest first: what the room told the press and the public, and when. */
export default function PressView({ notes, seconds, every }: { notes: Note[]; seconds: number; every: number }) {
  if (notes.length === 0)
    return <div className="app-empty press-empty"><Megaphone size={22} /><strong>Todavía no hay ningún comunicado</strong><p>La sala publica uno cada {every} ticks ({Math.round((every * seconds) / 60)} min), solo con lo que las dotaciones han confirmado.</p></div>;
  return (
    <div className="press">
      {[...notes].reverse().map((note, n) => (
        <article key={note.tick} className={n === 0 ? "is-latest" : ""}>
          <header>
            <span className="app-eyebrow">COMUNICADO Nº {note.number} · +{elapsed(note.tick, seconds)}{n === 0 ? " · ÚLTIMO" : ""}</span>
            <h2>{note.headline}</h2>
            <p className="press-lead">{note.lead}</p>
          </header>
          <dl>{note.figures.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
          {note.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
          <h3>Qué debe hacer la población</h3>
          <ul>{note.advice.map((a) => <li key={a}>{a}</li>)}</ul>
        </article>
      ))}
    </div>
  );
}
