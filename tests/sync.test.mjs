import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeGraphs, sameGraph } from '../src/lib/sync/merge.ts';
import { applyResolution } from '../src/lib/sync/resolve.ts';
import { syncAll, syncProject } from '../src/lib/sync/engine.ts';
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

// ---- Sync engine ----

const clone = value => JSON.parse(JSON.stringify(value));
const syncRow = (extra = {}) => ({
  projectId: 'project-1', accountId: 'user-1', offline: true, baseGraph: null, baseVersion: null,
  status: 'pending', conflicts: [], error: null, readOnly: false, deletedLocally: false, lastSyncedAt: null, ...extra
});

function fakeStore({ rows = [], graphs = {}, files = {}, account = { token: 't', userId: 'user-1', cloudUrl: 'https://cloud', connectedAt: 1 } } = {}) {
  const state = { rows: new Map(rows.map(r => [r.projectId, clone(r)])), graphs: clone(graphs), files: { ...files }, account, writes: 0 };
  return {
    state,
    getAccount: () => state.account,
    setAccount: a => { state.account = a; },
    getRow: id => (state.rows.has(id) ? clone(state.rows.get(id)) : null),
    listRows: () => [...state.rows.values()].map(clone),
    saveRow: row => { state.rows.set(row.projectId, clone(row)); },
    deleteRow: id => { state.rows.delete(id); },
    readLocalGraph: id => (state.graphs[id] ? clone(state.graphs[id]) : null),
    writeLocalGraph: (id, g) => { state.graphs[id] = clone(g); state.writes++; },
    addLocalFile: (url, id) => { state.files[url] = id; },
    listLocalFiles: id => Object.keys(state.files).filter(url => state.files[url] === id),
    removeLocalFile: url => { delete state.files[url]; }
  };
}

/** Mirrors the cloud contract: PUT /api/graph carries no title; renames go through upsertProject and keep the version. */
function fakeCloud({ graph: g = null, version = 0, fileSync = true, ...overrides } = {}) {
  const state = { graph: g && clone(g), version, calls: [] };
  return {
    state,
    async listProjects() {
      state.calls.push(['listProjects']);
      return { userId: 'user-1', account: { email: 'a@b.c', name: 'A' }, fileSync, projects: state.graph ? [{ id: 'project-1', title: state.graph.title, version: state.version }] : [] };
    },
    async getGraph(id) {
      state.calls.push(['getGraph', id]);
      return state.graph ? { status: 200, graph: clone(state.graph), version: state.version } : { status: 410 };
    },
    async putGraph(id, snapshot, baseVersion) {
      state.calls.push(['putGraph', id, clone(snapshot), baseVersion]);
      if (baseVersion !== state.version) return { status: 409, version: state.version };
      state.graph = { title: state.graph.title, nodes: clone(snapshot.nodes), relationships: clone(snapshot.relationships) };
      state.version++;
      return { status: 200, version: state.version };
    },
    async upsertProject(id, title) {
      state.calls.push(['upsertProject', id, title]);
      if (state.graph) state.graph.title = title;
      else { state.graph = graph([], [], title); state.version = 0; }
    },
    async deleteProject(id, baseVersion) {
      state.calls.push(['deleteProject', id, baseVersion]);
      if (baseVersion !== state.version) return { status: 409, version: state.version };
      state.graph = null;
      return { status: 200 };
    },
    async uploadFile(id, url) {
      state.calls.push(['uploadFile', id, url]);
      return `https://storage.example/${url.split('/').pop()}`;
    },
    ...overrides
  };
}
const calls = (cloud, name) => cloud.state.calls.filter(c => c[0] === name);

/** A row synced at v1 with `base`, plus a local copy and a cloud copy. */
function synced(base, local, remote, remoteVersion = 1, cloudOptions = {}, storeOptions = {}) {
  const store = fakeStore({ rows: [syncRow({ baseGraph: base, baseVersion: 1, status: 'synced' })], graphs: { 'project-1': local }, ...storeOptions });
  const cloud = fakeCloud({ graph: remote, version: remoteVersion, ...cloudOptions });
  return { store, cloud };
}
const imageMap = () => graph([node('a'), node('img', { type: 'image', imageUrl: '/uploads/project-1/x.png' })]);
const imageFiles = { files: { '/uploads/project-1/x.png': 'project-1' } };

test('first push creates the cloud project', async () => {
  const local = graph([node('a')], [], 'Offline map');
  const store = fakeStore({ rows: [syncRow()], graphs: { 'project-1': local } });
  const cloud = fakeCloud();
  const row = await syncProject(store, cloud, 'project-1');
  assert.deepEqual(calls(cloud, 'upsertProject'), [['upsertProject', 'project-1', 'Offline map']]);
  assert.equal(calls(cloud, 'putGraph')[0][3], 0);
  assert.equal(row.status, 'synced');
  assert.equal(row.baseVersion, 1);
  assert.ok(sameGraph(row.baseGraph, local));
  assert.deepEqual(store.getRow('project-1'), row);
});

test('pulls remote-only changes', async () => {
  const base = graph([node('a')]);
  const remote = graph([node('a'), node('b')]);
  const { store, cloud } = synced(base, base, remote, 2);
  const row = await syncProject(store, cloud, 'project-1');
  assert.equal(calls(cloud, 'putGraph').length, 0);
  assert.ok(sameGraph(store.state.graphs['project-1'], remote));
  assert.ok(sameGraph(row.baseGraph, remote));
  assert.equal(row.baseVersion, 2);
  assert.equal(row.status, 'synced');
});

test('merges and pushes non-overlapping changes', async () => {
  const base = graph([node('a'), node('b')]);
  const { store, cloud } = synced(base, graph([node('a', { title: 'A2' }), node('b')]), graph([node('a'), node('b', { content: 'new' })]), 2);
  const row = await syncProject(store, cloud, 'project-1');
  const [put] = calls(cloud, 'putGraph');
  assert.equal(put[3], 2);
  const expected = graph([node('a', { title: 'A2' }), node('b', { content: 'new' })]);
  assert.ok(sameGraph(put[2], expected));
  assert.ok(sameGraph(store.state.graphs['project-1'], expected));
  assert.ok(sameGraph(row.baseGraph, expected));
  assert.equal(row.baseVersion, 3);
  assert.equal(row.status, 'synced');
});

test('stores conflicts and does not push', async () => {
  const base = graph([node('a'), node('b')]);
  const { store, cloud } = synced(base, graph([node('a', { content: 'mine' }), node('b'), node('c')]), graph([node('a', { content: 'theirs' }), node('b')]), 2);
  const row = await syncProject(store, cloud, 'project-1');
  assert.equal(calls(cloud, 'putGraph').length, 0);
  assert.equal(row.status, 'conflicts');
  assert.deepEqual(row.conflicts.map(c => c.id), ['node:a']);
  assert.equal(row.baseVersion, 1);
  assert.ok(sameGraph(row.baseGraph, base));
  assert.ok(store.state.graphs['project-1'].nodes.some(n => n.id === 'c'));
});

test('push failure keeps base and local', async () => {
  const base = graph([node('a')]);
  const local = graph([node('a', { content: 'edited' })]);
  const { store, cloud } = synced(base, local, base, 1, { putGraph: async () => { throw new Error('offline'); } });
  const row = await syncProject(store, cloud, 'project-1');
  assert.equal(row.status, 'error');
  assert.equal(row.error, 'Could not reach the cloud.');
  assert.equal(row.baseVersion, 1);
  assert.ok(sameGraph(row.baseGraph, base));
  assert.ok(sameGraph(store.state.graphs['project-1'], local));
});

test('413 marks error and keeps data', async () => {
  const base = graph([node('a')]);
  const local = graph([node('a', { content: 'huge' })]);
  const { store, cloud } = synced(base, local, base, 1, { putGraph: async () => ({ status: 413, error: 'This map is too large to save.' }) });
  const row = await syncProject(store, cloud, 'project-1');
  assert.equal(row.status, 'error');
  assert.equal(row.error, 'This map is too large to save.');
  assert.equal(row.baseVersion, 1);
  assert.ok(sameGraph(row.baseGraph, base));
  assert.ok(sameGraph(store.state.graphs['project-1'], local));
});

test('retries on 409 then succeeds', async () => {
  const base = graph([node('a')]);
  const { store, cloud } = synced(base, graph([node('a', { content: 'edited' })]), base, 1);
  const realPut = cloud.putGraph;
  let first = true;
  cloud.putGraph = async (...args) => {
    if (first) { // a teammate's save lands between our GET and PUT
      first = false;
      cloud.state.graph.nodes.push(node('c'));
      cloud.state.version = 2;
    }
    return realPut(...args);
  };
  const row = await syncProject(store, cloud, 'project-1');
  assert.equal(calls(cloud, 'getGraph').length, 2);
  assert.deepEqual(calls(cloud, 'putGraph').map(c => c[3]), [1, 2]);
  assert.equal(row.status, 'synced');
  assert.equal(row.baseVersion, 3);
  assert.deepEqual(store.state.graphs['project-1'].nodes.map(n => n.id).sort(), ['a', 'c']);
});

test('gives up after repeated 409s', async () => {
  const base = graph([node('a')]);
  const { store, cloud } = synced(base, graph([node('a', { content: 'edited' })]), base, 1, { putGraph: async () => ({ status: 409, version: 9 }) });
  const row = await syncProject(store, cloud, 'project-1');
  assert.equal(calls(cloud, 'getGraph').length, 4);
  assert.equal(row.status, 'error');
  assert.equal(row.baseVersion, 1);
});

test('lost access makes the map read-only', async () => {
  const base = graph([node('a')]);
  const { store, cloud } = synced(base, base, base, 1, { getGraph: async () => ({ status: 403 }) });
  const row = await syncProject(store, cloud, 'project-1');
  assert.equal(row.readOnly, true);
  assert.equal(row.status, 'no-access');
  assert.equal(calls(cloud, 'putGraph').length, 0);
  assert.equal(row.baseVersion, 1);
});

test('deleted in the cloud becomes a project conflict', async () => {
  const base = graph([node('a')]);
  const { store, cloud } = synced(base, base, null);
  const row = await syncProject(store, cloud, 'project-1');
  assert.equal(row.status, 'conflicts');
  assert.deepEqual(row.conflicts, [{ id: 'project:project-1', kind: 'project', itemId: 'project-1', reason: 'deleted-remote' }]);
  assert.equal(row.baseVersion, 1);
});

test('local delete removes the cloud map, or conflicts when the cloud changed', async () => {
  const base = graph([node('a')]);
  const store = fakeStore({ rows: [syncRow({ baseGraph: base, baseVersion: 1, deletedLocally: true })] });
  const cloud = fakeCloud({ graph: base, version: 1 });
  await syncProject(store, cloud, 'project-1');
  assert.deepEqual(calls(cloud, 'deleteProject'), [['deleteProject', 'project-1', 1]]);
  assert.equal(store.getRow('project-1'), null);

  const store2 = fakeStore({ rows: [syncRow({ baseGraph: base, baseVersion: 1, deletedLocally: true })] });
  const row = await syncProject(store2, fakeCloud({ graph: base, version: 2 }), 'project-1');
  assert.equal(row.status, 'conflicts');
  assert.deepEqual(row.conflicts, [{ id: 'project:project-1', kind: 'project', itemId: 'project-1', reason: 'deleted-local' }]);
  assert.equal(row.baseVersion, 1);
});

test('concurrent syncs push once', async () => {
  const base = graph([node('a')]);
  const { store, cloud } = synced(base, graph([node('a', { content: 'edited' })]), base, 1);
  const [one, two] = await Promise.all([syncProject(store, cloud, 'project-1'), syncProject(store, cloud, 'project-1')]);
  assert.equal(calls(cloud, 'putGraph').length, 1);
  assert.deepEqual(one, two);
  await syncProject(store, cloud, 'project-1'); // the lock is released afterwards
  assert.equal(calls(cloud, 'getGraph').length, 2);
});

test('skips rows from another account', async () => {
  const store = fakeStore({ rows: [syncRow({ accountId: 'someone-else' })], graphs: { 'project-1': graph([node('a')]) } });
  const cloud = fakeCloud();
  const row = await syncProject(store, cloud, 'project-1');
  assert.deepEqual(row, syncRow({ accountId: 'someone-else' }));
  assert.deepEqual(cloud.state.calls, []);
});

test('title-only remote rename is pulled', async () => {
  const base = graph([node('a')], [], 'Old');
  const { store, cloud } = synced(base, base, graph([node('a')], [], 'New'), 1); // renames keep the version
  const row = await syncProject(store, cloud, 'project-1');
  assert.equal(store.state.graphs['project-1'].title, 'New');
  assert.equal(row.baseGraph.title, 'New');
  assert.equal(row.status, 'synced');
  assert.equal(calls(cloud, 'putGraph').length, 0);
});

test('local rename is pushed', async () => {
  const base = graph([node('a')], [], 'Old');
  const { store, cloud } = synced(base, graph([node('a')], [], 'Mine'), base, 1);
  const row = await syncProject(store, cloud, 'project-1');
  assert.deepEqual(calls(cloud, 'upsertProject'), [['upsertProject', 'project-1', 'Mine']]);
  assert.equal(cloud.state.graph.title, 'Mine');
  assert.equal(row.baseGraph.title, 'Mine');
  assert.equal(row.status, 'synced');
});

test('uploads local files and rewrites urls before pushing', async () => {
  const base = graph([node('a')]);
  const { store, cloud } = synced(base, imageMap(), base, 1, {}, imageFiles);
  const row = await syncProject(store, cloud, 'project-1');
  const pushed = calls(cloud, 'putGraph')[0][2];
  assert.equal(pushed.nodes.find(n => n.id === 'img').imageUrl, 'https://storage.example/x.png');
  assert.equal(store.state.graphs['project-1'].nodes.find(n => n.id === 'img').imageUrl, 'https://storage.example/x.png');
  assert.deepEqual(store.listLocalFiles('project-1'), []);
  assert.ok(sameGraph(row.baseGraph, store.state.graphs['project-1']));
  assert.equal(row.error, null);
});

test('without cloud file storage, files stay local and the row says so', async () => {
  const base = graph([node('a')]);
  const { store, cloud } = synced(base, imageMap(), base, 1, { fileSync: false }, imageFiles);
  const row = await syncProject(store, cloud, 'project-1');
  assert.equal(calls(cloud, 'uploadFile').length, 0);
  assert.equal(row.status, 'synced');
  assert.equal(row.error, 'Files stay on this device: cloud file storage is off.');
  assert.deepEqual(store.listLocalFiles('project-1'), ['/uploads/project-1/x.png']);
});

test('file upload failure keeps base and local', async () => {
  const base = graph([node('a')]);
  const { store, cloud } = synced(base, imageMap(), base, 1, { uploadFile: async () => { throw new Error('boom'); } }, imageFiles);
  const row = await syncProject(store, cloud, 'project-1');
  assert.equal(row.status, 'error');
  assert.equal(row.error, 'Could not upload a file.');
  assert.equal(row.baseVersion, 1);
  assert.ok(sameGraph(row.baseGraph, base));
  assert.ok(sameGraph(store.state.graphs['project-1'], imageMap()));
  assert.deepEqual(store.listLocalFiles('project-1'), ['/uploads/project-1/x.png']);
  assert.equal(calls(cloud, 'putGraph').length, 0);
});

test('rows with pending conflicts are left alone', async () => {
  const base = graph([node('a')]);
  const conflict = { id: 'node:a', kind: 'node', itemId: 'a', reason: 'both-changed' };
  const pending = syncRow({ baseGraph: base, baseVersion: 1, status: 'conflicts', conflicts: [conflict] });
  const store = fakeStore({ rows: [pending], graphs: { 'project-1': graph([node('a', { content: 'x' })]) } });
  const cloud = fakeCloud({ graph: base, version: 1 });
  const row = await syncProject(store, cloud, 'project-1');
  assert.deepEqual(row, pending);
  assert.deepEqual(cloud.state.calls, []);
});

test('an autosave during the fetch is merged, not overwritten', async () => {
  const base = graph([node('a')]);
  const { store, cloud } = synced(base, base, graph([node('a'), node('b')]), 2);
  const realGet = cloud.getGraph;
  cloud.getGraph = async id => {
    store.state.graphs['project-1'] = graph([node('a', { content: 'typed while syncing' })]);
    return realGet(id);
  };
  await syncProject(store, cloud, 'project-1');
  const local = store.state.graphs['project-1'];
  assert.equal(local.nodes.find(n => n.id === 'a').content, 'typed while syncing');
  assert.ok(local.nodes.some(n => n.id === 'b'));
});

test('a no-op sync does not rewrite the local map', async () => {
  const base = graph([node('a', { metadata: {} })]);
  const { store, cloud } = synced(base, base, graph([node('a')]), 1);
  const row = await syncProject(store, cloud, 'project-1');
  assert.equal(row.status, 'synced');
  assert.equal(store.state.writes, 0);
  assert.equal(calls(cloud, 'putGraph').length, 0);
});

test('syncAll syncs the connected account and reports an unreachable cloud', async () => {
  const base = graph([node('a')]);
  const rows = [syncRow({ baseGraph: base, baseVersion: 1, status: 'synced' }), syncRow({ projectId: 'project-2', accountId: 'other' })];
  const store = fakeStore({ rows, graphs: { 'project-1': graph([node('a', { content: 'edited' })]) } });
  const cloud = fakeCloud({ graph: base, version: 1 });
  const result = await syncAll(store, cloud);
  assert.equal(calls(cloud, 'listProjects').length, 1);
  assert.equal(result.find(r => r.projectId === 'project-1').baseVersion, 2);
  assert.equal(result.find(r => r.projectId === 'project-2').status, 'pending');

  const offline = await syncAll(fakeStore({ rows }), fakeCloud({ listProjects: async () => { throw new Error('offline'); } }));
  const one = offline.find(r => r.projectId === 'project-1');
  assert.equal(one.status, 'error');
  assert.equal(one.error, 'Could not reach the cloud.');
  assert.equal(one.baseVersion, 1);
  assert.equal(offline.find(r => r.projectId === 'project-2').status, 'pending');

  assert.deepEqual(await syncAll(fakeStore({ rows, account: null }), cloud), rows);
});
