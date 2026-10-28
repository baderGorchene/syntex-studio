import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeGraphs, sameGraph } from '../src/lib/sync/merge.ts';
import { applyResolution } from '../src/lib/sync/resolve.ts';
import { normalizeGraph } from '../src/lib/graph.ts';

const node = (id, extra = {}) => ({ id, type: 'note', x: 0, y: 0, title: id, createdAt: 1, ...extra });
const edge = (id, from, to) => ({ id, from, to, label: 'supports' });
const graph = (nodes = [], relationships = [], title = 'Map') => ({ title, nodes, relationships });

const merge = (base, local, remote) => {
  const result = mergeGraphs(base, local, remote);
  normalizeGraph(result.merged.nodes, result.merged.relationships);
  return result;
};
const find = (result, id) => result.merged.nodes.find(n => n.id === id);

test('keeps additions from both sides', () => {
  const result = merge(graph(), graph([node('a')]), graph([node('b')]));
  assert.deepEqual(result.merged.nodes.map(n => n.id).sort(), ['a', 'b']);
  assert.deepEqual(result.conflicts, []);
});

test('takes one-sided edits', () => {
  const base = graph([node('a'), node('b')]);
  const result = merge(base, graph([node('a', { title: 'A2' }), node('b')]), graph([node('a'), node('b', { content: 'new' })]));
  assert.equal(find(result, 'a').title, 'A2');
  assert.equal(find(result, 'b').content, 'new');
  assert.deepEqual(result.conflicts, []);
});

test('conflicts when both sides change content', () => {
  const base = graph([node('a', { content: 'base' })]);
  const result = merge(base, graph([node('a', { content: 'local' })]), graph([node('a', { content: 'remote' })]));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].id, 'node:a');
  assert.equal(result.conflicts[0].reason, 'both-changed');
  assert.equal(find(result, 'a').content, 'local');
});

test('identical edits on both sides are not a conflict', () => {
  const base = graph([node('a', { content: 'base' })]);
  const result = merge(base, graph([node('a', { content: 'same' })]), graph([node('a', { content: 'same' })]));
  assert.deepEqual(result.conflicts, []);
  assert.equal(find(result, 'a').content, 'same');
});

test('layout never conflicts and local wins', () => {
  const base = graph([node('a')]);
  const both = merge(base, graph([node('a', { x: 10 })]), graph([node('a', { x: 20 })]));
  assert.equal(find(both, 'a').x, 10);
  assert.deepEqual(both.conflicts, []);
  const remoteOnly = merge(base, graph([node('a')]), graph([node('a', { x: 20 })]));
  assert.equal(find(remoteOnly, 'a').x, 20);
});

test('collapsing a section is layout', () => {
  const base = graph([node('s', { type: 'section' })]);
  const local = graph([node('s', { type: 'section', metadata: { collapsed: true } })]);
  const remote = graph([node('s', { type: 'section', title: 'Renamed' })]);
  const result = merge(base, local, remote);
  assert.equal(find(result, 's').metadata.collapsed, true);
  assert.equal(find(result, 's').title, 'Renamed');
  assert.deepEqual(result.conflicts, []);
});

test('sectionId merges separately', () => {
  const base = graph([node('a', { sectionId: 's1' })]);
  const clean = merge(base, graph([node('a', { sectionId: 's2' })]), graph([node('a', { sectionId: 's1', content: 'edited' })]));
  assert.equal(find(clean, 'a').sectionId, 's2');
  assert.equal(find(clean, 'a').content, 'edited');
  assert.deepEqual(clean.conflicts, []);
  const both = merge(base, graph([node('a', { sectionId: 's2' })]), graph([node('a', { sectionId: 's3' })]));
  assert.equal(both.conflicts.length, 1);
  assert.equal(both.conflicts[0].reason, 'both-changed');
});

test('delete vs edit conflicts', () => {
  const base = graph([node('a'), node('b')]);
  const result = merge(base, graph([node('b')]), graph([node('a', { content: 'edited' }), node('b')]));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].reason, 'deleted-local');
  assert.equal(find(result, 'a'), undefined);
});

test('delete vs new link conflicts on the node', () => {
  const base = graph([node('a'), node('b')]);
  const result = merge(base, graph([node('b')]), graph([node('a'), node('b')], [edge('e', 'b', 'a')]));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].id, 'node:a');
  assert.equal(result.conflicts[0].reason, 'deleted-local');
  assert.ok(!result.dropped.includes('e'));
});

test('delete vs new link keeps the link on the conflict', () => {
  const e = edge('e', 'b', 'a');
  const base = graph([node('a'), node('b')]);
  const result = merge(base, graph([node('b')]), graph([node('a'), node('b')], [e]));
  assert.deepEqual(result.conflicts[0].edges, [e]);
  assert.ok(!result.merged.relationships.some(r => r.id === 'e'));
  assert.deepEqual(result.dropped, []);
});

test('edit vs remote delete keeps the local link on the conflict', () => {
  // Local also deleted `b`, so `f` cannot stay in merged and is parked on the conflict instead.
  // (With `b` alive, `f` would simply stay in merged next to the local `a`.)
  const f = edge('f', 'a', 'b');
  const base = graph([node('a'), node('b')]);
  const result = merge(base, graph([node('a', { content: 'edited' })], [f]), graph([node('b')]));
  const conflict = result.conflicts.find(c => c.id === 'node:a');
  assert.equal(conflict.reason, 'deleted-remote');
  assert.ok(conflict.edges.some(r => r.id === 'f'));
  assert.ok(!result.dropped.includes('f'));
});

test('drops edges left dangling by agreed deletes', () => {
  // Both sides deleted `a` but neither removed `e`, so `e` survives the edge merge and dangles.
  const base = graph([node('a'), node('b')], [edge('e', 'b', 'a')]);
  const result = merge(base, graph([node('b')], [edge('e', 'b', 'a')]), graph([node('b')], [edge('e', 'b', 'a')]));
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.merged.relationships, []);
  assert.deepEqual(result.dropped, ['e']);
});

test('title conflicts', () => {
  const result = merge(graph([], [], 'B'), graph([], [], 'L'), graph([], [], 'R'));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kind, 'title');
  assert.equal(result.merged.title, 'L');
});

test('sameGraph ignores order', () => {
  const a = graph([node('a', { metadata: { origin: 'user', confidence: 1 } }), node('b')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')]);
  const b = graph(
    [node('b'), { createdAt: 1, title: 'a', y: 0, x: 0, type: 'note', id: 'a', metadata: { confidence: 1, origin: 'user' } }],
    [edge('e2', 'b', 'a'), edge('e1', 'a', 'b')]
  );
  assert.ok(sameGraph(a, b));
  assert.ok(!sameGraph(a, graph([node('a'), node('b')], a.relationships)));
});

const touches = (g, id) => g.relationships.filter(r => r.from === id || r.to === id);

test('resolve mine/cloud/both', () => {
  const base = graph([node('a', { content: 'base' }), node('b')], [edge('e', 'a', 'b')]);
  const local = graph([node('a', { content: 'local' }), node('b')], [edge('e', 'a', 'b')]);
  const remote = graph([node('a', { content: 'remote' }), node('b')], [edge('e', 'a', 'b')]);
  const { merged, conflicts } = merge(base, local, remote);
  const conflict = conflicts[0];

  const mine = applyResolution(merged, conflict, 'mine', () => 'x');
  assert.equal(mine.nodes.find(n => n.id === 'a').content, 'local');
  const cloud = applyResolution(merged, conflict, 'cloud', () => 'x');
  assert.equal(cloud.nodes.find(n => n.id === 'a').content, 'remote');
  assert.equal(cloud.relationships.length, 1);

  const both = applyResolution(merged, conflict, 'both', () => 'copy1');
  assert.equal(both.nodes.find(n => n.id === 'a').content, 'local');
  const copy = both.nodes.find(n => n.id === 'copy1');
  assert.ok(copy.title.endsWith(' (conflict copy)'));
  assert.equal(copy.content, 'remote');
  assert.deepEqual(touches(both, 'copy1'), []);
});

test('resolve keep restores a deleted node', () => {
  const base = graph([node('a')]);
  const { merged, conflicts } = merge(base, graph([]), graph([node('a', { content: 'edited' })]));
  const kept = applyResolution(merged, conflicts[0], 'keep', () => 'x');
  assert.equal(kept.nodes.find(n => n.id === 'a').content, 'edited');
  const gone = applyResolution(merged, conflicts[0], 'delete', () => 'x');
  assert.equal(gone.nodes.find(n => n.id === 'a'), undefined);
});

test('resolve keep restores the node\'s links', () => {
  const base = graph([node('a'), node('b')]);
  const { merged, conflicts } = merge(base, graph([node('b')]), graph([node('a'), node('b')], [edge('e', 'b', 'a')]));
  const kept = applyResolution(merged, conflicts[0], 'keep', () => 'x');
  normalizeGraph(kept.nodes, kept.relationships);
  assert.deepEqual(kept.relationships.map(r => r.id), ['e']);
});

test('resolve delete removes the node\'s links', () => {
  const f = edge('f', 'a', 'b');
  const base = graph([node('a'), node('b')]);
  const local = graph([node('a', { content: 'edited' }), node('b')], [f]);
  const { merged, conflicts } = merge(base, local, graph([node('b')]));
  assert.equal(touches(merged, 'a').length, 1);
  const gone = applyResolution(merged, conflicts.find(c => c.id === 'node:a'), 'delete', () => 'x');
  assert.equal(gone.nodes.find(n => n.id === 'a'), undefined);
  assert.deepEqual(touches(gone, 'a'), []);
});

test('invalid choice throws', () => {
  const both = merge(graph([node('a', { content: 'b' })]), graph([node('a', { content: 'l' })]), graph([node('a', { content: 'r' })]));
  assert.throws(() => applyResolution(both.merged, both.conflicts[0], 'keep', () => 'x'));
  const del = merge(graph([node('a')]), graph([]), graph([node('a', { content: 'edited' })]));
  assert.throws(() => applyResolution(del.merged, del.conflicts[0], 'mine', () => 'x'));
  assert.throws(() => applyResolution(del.merged, del.conflicts[0], 'cloud', () => 'x'));
  const title = merge(graph([], [], 'B'), graph([], [], 'L'), graph([], [], 'R'));
  assert.throws(() => applyResolution(title.merged, title.conflicts[0], 'both', () => 'x'));
  assert.equal(applyResolution(title.merged, title.conflicts[0], 'cloud', () => 'x').title, 'R');
  const project = { id: 'project:p', kind: 'project', itemId: 'p', reason: 'deleted-remote' };
  assert.throws(() => applyResolution(graph(), project, 'keep', () => 'x'));
});
