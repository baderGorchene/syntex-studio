import type { GraphSnapshot } from './merge.ts';

/** Copies a map with fresh node and edge ids, so the copy shares nothing with the original. Pure; the input is untouched. */
export function copyGraphWithNewIds(g: GraphSnapshot, newId: () => string): GraphSnapshot {
  const ids = new Map(g.nodes.map(n => [n.id, newId()]));
  // Only ids that point into this graph are remapped; anything else (external refs) stays as it was.
  const map = (id: string) => ids.get(id) ?? id;
  return {
    title: g.title,
    nodes: g.nodes.map(n => {
      const copy = { ...n, id: map(n.id) };
      if (n.sectionId) copy.sectionId = map(n.sectionId);
      if (n.metadata) {
        copy.metadata = { ...n.metadata };
        if (n.metadata.sourceIds) copy.metadata.sourceIds = n.metadata.sourceIds.map(map);
        if (n.metadata.evidence) copy.metadata.evidence = n.metadata.evidence.map(e => ({ ...e, sourceId: map(e.sourceId) }));
      }
      return copy;
    }),
    relationships: g.relationships.map(e => {
      const copy = { ...e, id: newId(), from: map(e.from), to: map(e.to) };
      if (e.metadata?.sourceId) copy.metadata = { ...e.metadata, sourceId: map(e.metadata.sourceId) };
      return copy;
    })
  };
}
