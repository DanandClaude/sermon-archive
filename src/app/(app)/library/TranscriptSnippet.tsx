import { SNIPPET_END, SNIPPET_START } from '@/lib/sermons/library';

/** A line of transcript around the search words, with the words that matched highlighted. */
export function TranscriptSnippet({ text }: { text: string }) {
  const parts = text.split(SNIPPET_START).flatMap((chunk, i) => {
    if (i === 0) return [{ text: chunk, hit: false }];
    const [hit, ...rest] = chunk.split(SNIPPET_END);
    return [
      { text: hit, hit: true },
      { text: rest.join(''), hit: false },
    ];
  });
  return (
    <p className="m-0 mt-1.5 text-[13px] leading-[1.5] text-muted">
      <span className="sr-only">From the transcript: </span>
      <span aria-hidden="true">“</span>…
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-amber-tint px-0.5 text-ink">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
      …<span aria-hidden="true">”</span>
    </p>
  );
}
