import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeGraphs, sameGraph } from '../src/lib/sync/merge.ts';
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
