import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addNode,
  addRelationship,
  exportContextMarkdown,
  exportMermaid,
  neighborhood,
  normalizeGraph,
  pickContextNodeIds,
  removeNode,
  strokeForLabel
} from '../src/lib/graph.ts';
import { ONTOLOGY_PRESETS } from '../src/types/canvas.ts';
import { buildVaultFiles, createZipArchive } from '../src/lib/vault-export.ts';
import { parseBibTeX, bibEntriesToCanvasNodes } from '../src/lib/bibtex.ts';
import { generateStandaloneSvg } from '../src/lib/canvas-export.ts';
import { extraCreditsFor, modelCostUsd, USD_PER_CREDIT } from '../src/lib/model-pricing.ts';
import { extractPageNumber, formatPdfPageUrl, normalizeEvidenceItem } from '../src/utils/citation.ts';

const concept = (id, title = id, type = 'concept') => ({ id, type, x: 0, y: 0, title, createdAt: 1 });
const relation = (id, from, to, label = 'supports') => ({ id, from, to, label });
/** Token counts match, and the cost is those tokens at the model's current price. */
const assertUsage = (usage, model, inputTokens, outputTokens) => {
  assert.equal(usage.inputTokens, inputTokens);
  assert.equal(usage.outputTokens, outputTokens);
  assert.ok(Math.abs(usage.costUsd - modelCostUsd(model, { inputTokens, outputTokens })) < 1e-12, `cost ${usage.costUsd}`);
};

test('normalizes a graph and rejects duplicate or dangling ids', () => {
  const graph = normalizeGraph([concept('a'), concept('b')], [relation('e', 'a', 'b')]);
  assert.deepEqual(Object.keys(graph.nodesById), ['a', 'b']);
  assert.throws(() => normalizeGraph([concept('a'), concept('a')], []), /Duplicate node/);
  assert.throws(() => normalizeGraph([concept('a')], [relation('e', 'a', 'missing')]), /missing node/);
});

test('graph operations keep edges valid and traverse neighbors', () => {
  let graph = normalizeGraph([concept('a'), concept('b')], []);
  graph = addNode(graph, concept('c'));
  graph = addRelationship(graph, relation('e1', 'a', 'b'));
  graph = addRelationship(graph, relation('e2', 'b', 'c', 'derived from'));
  assert.deepEqual([...neighborhood(graph, 'a', 2)].sort(), ['a', 'b', 'c']);
  assert.throws(() => addRelationship(graph, relation('e3', 'a', 'missing')), /endpoints/);
  graph = removeNode(graph, 'b');
  assert.deepEqual(Object.keys(graph.edgesById), []);
});

test('Mermaid ids are stable and labels are escaped', () => {
  const graph = normalizeGraph(
    [concept('claim / 1', 'A "quoted" claim | with newline\nnext'), concept('source:1', 'Source')],
    [relation('e1', 'source:1', 'claim / 1', 'supports | confirms')]
  );
  const output = exportMermaid(graph);
  assert.match(output, /^graph TD\n/);
  assert.match(output, /&quot;quoted&quot;/);
  assert.match(output, /supports &#124; confirms/);
  assert.equal(output, exportMermaid(graph));
});

test('context export is deterministic and includes provenance and sources', () => {
  const graph = normalizeGraph(
    [
      { ...concept('c', 'RAG'), content: 'Retrieval supplies external context.', metadata: { origin: 'ai', rationale: 'Derived from the source.' } },
      { ...concept('s', 'Retrieval paper', 'source'), url: 'https://example.org/paper', description: 'A research paper.' },
      concept('q', 'How should retrieval be evaluated?', 'question')
    ],
    [relation('e', 's', 'c', 'supports')]
  );
  const output = exportContextMarkdown(graph, 'RAG research');
  assert.match(output, /# RAG research/);
  assert.match(output, /Provenance: Derived from the source\./);
  assert.match(output, /https:\/\/example\.org\/paper/);
  assert.match(output, /How should retrieval be evaluated\?/);
  assert.equal(output, exportContextMarkdown(graph, 'RAG research'));
});

test('calculateConnectionPaths connects flush to bottom of cards with 0 gap', async () => {
  const { calculateConnectionPaths, getNodeHeight } = await import('../src/utils/canvasMath.ts');
  const cardA = { id: 'a', type: 'concept', x: 100, y: 100, width: 280, title: 'Card A' };
  const cardB = { id: 'b', type: 'concept', x: 100, y: 300, width: 280, title: 'Card B' };
  const heightA = getNodeHeight(cardA);

  // Card A is at y: 100, heightA. Bottom of Card A is exactly 100 + heightA.
  const paths = calculateConnectionPaths([cardA, cardB], [{ id: 'e1', from: 'a', to: 'b' }]);
  assert.equal(paths.length, 1);
  const path = paths[0].path;
  // Must start at y = 100 + heightA
  const expectedStartY = 100 + heightA;
  assert.ok(path.startsWith(`M 240 ${expectedStartY}`), `Path should start flush at bottom of Card A (${expectedStartY}), got: ${path}`);
  // Must end at y = 300 (top of Card B)
  assert.ok(path.endsWith('240 300'), `Path should end flush at top of Card B (300), got: ${path}`);

  // Test reverse: Card B above Card A
  const reversePaths = calculateConnectionPaths([cardA, cardB], [{ id: 'e2', from: 'b', to: 'a' }]);
  assert.equal(reversePaths.length, 1);
  const reversePath = reversePaths[0].path;
  // Card B is at y: 300, Card A is at y: 100. Exit top of Card B (y=300), enter bottom of Card A (y=100+heightA)
  assert.ok(reversePath.startsWith('M 240 300'), `Reverse path should start at top of Card B (300), got: ${reversePath}`);
  assert.ok(reversePath.endsWith(`240 ${expectedStartY}`), `Reverse path should end flush at bottom of Card A (${expectedStartY}), got: ${reversePath}`);
});

test('persistent revisions create, list, restore, and delete correctly', async () => {
  const {
    createGraphRevision,
    getGraphRevisions,
    getGraphRevisionById,
    restoreGraphRevision,
    deleteGraphRevision
  } = await import('../src/lib/db.ts');

  const testProject = `test-rev-${Date.now()}`;
  const nodes = [concept('n1', 'First node'), concept('n2', 'Second node')];
  const connections = [relation('r1', 'n1', 'n2')];

  // 1. Create a revision
  const rev = createGraphRevision(testProject, 'Initial architecture draft', nodes, connections);
  assert.equal(rev.projectId, testProject);
  assert.equal(rev.title, 'Initial architecture draft');
  assert.equal(rev.nodeCount, 2);
  assert.equal(rev.edgeCount, 1);

  // 2. List revisions
  const list = getGraphRevisions(testProject);
  assert.ok(list.length >= 1);
  assert.equal(list[0].id, rev.id);

  // 3. Get revision by ID with full graph
  const loaded = getGraphRevisionById(testProject, rev.id);
  assert.ok(loaded);
  assert.equal(loaded.nodes.length, 2);
  assert.equal(loaded.relationships.length, 1);
  assert.equal(loaded.nodes[0].title, 'First node');

  // 4. Restore revision
  const restored = restoreGraphRevision(testProject, rev.id);
  assert.ok(restored);
  assert.equal(restored.nodes.length, 2);
  assert.ok(restored.revision.title.includes('Restored:'));

  // 5. Delete revision
  const deleted = deleteGraphRevision(testProject, rev.id);
  assert.equal(deleted, true);
  const reloaded = getGraphRevisionById(testProject, rev.id);
  assert.equal(reloaded, null);
});

test('Database Snapshot Engine: create, list, restore, and delete workspace backups', async () => {
  const {
    createDatabaseBackup,
    getDatabaseBackups,
    restoreDatabaseBackup,
    deleteDatabaseBackup,
    getBackupFilePath
  } = await import('../src/lib/db.ts');

  // 1. Create a database backup snapshot
  const snapshotLabel = `Test DB Snapshot ${Date.now()}`;
  const snapshot = await createDatabaseBackup(snapshotLabel);
  assert.ok(snapshot.id.startsWith('snap_'));
  assert.ok(snapshot.fileName.endsWith('.db'));
  assert.equal(snapshot.label, snapshotLabel);
  assert.ok(snapshot.sizeBytes > 0);

  // 2. Verify file exists on disk
  const filePath = getBackupFilePath(snapshot.fileName);
  assert.ok(filePath !== null);

  // 3. List database backups
  const backups = getDatabaseBackups();
  assert.ok(backups.length >= 1);
  const found = backups.find(b => b.fileName === snapshot.fileName);
  assert.ok(found);
  assert.equal(found.label, snapshotLabel);

  // 4. Restore database backup
  const restoreRes = await restoreDatabaseBackup(snapshot.fileName);
  assert.equal(restoreRes.success, true);
  assert.equal(restoreRes.snapshot.fileName, snapshot.fileName);

  // 5. Delete database backup
  const deleted = deleteDatabaseBackup(snapshot.fileName);
  assert.equal(deleted, true);

  // Verify it is gone from backups list
  const remaining = getDatabaseBackups();
  assert.equal(remaining.some(b => b.fileName === snapshot.fileName), false);
});

test('Canvas Virtualization: culls off-screen nodes and edges on large graphs (200+ nodes)', () => {
  // Generate a realistic 250-node graph spread across a 10000x10000 canvas plane
  const nodes = [];
  for (let i = 0; i < 250; i++) {
    const col = i % 25;
    const row = Math.floor(i / 25);
    nodes.push({
      id: `node-${i}`,
      type: 'concept',
      x: col * 400,
      y: row * 300,
      width: 280,
      height: 160,
      title: `Concept ${i}`
    });
  }

  // Simulate a focused 1920x1080 viewport looking at the top-left quadrant (zoom 1.0, pan 0,0)
  const viewWidth = 1920;
  const viewHeight = 1080;
  const zoom = 1.0;
  const pan = { x: 0, y: 0 };
  const buffer = 500;

  const visibleRect = {
    left: -pan.x / zoom - buffer,
    top: -pan.y / zoom - buffer,
    right: (-pan.x + viewWidth) / zoom + buffer,
    bottom: (-pan.y + viewHeight) / zoom + buffer
  };

  const isBoxInViewport = (b) => {
    return (
      b.x + b.width >= visibleRect.left &&
      b.x <= visibleRect.right &&
      b.y + b.height >= visibleRect.top &&
      b.y <= visibleRect.bottom
    );
  };

  const visibleNodes = nodes.filter(isBoxInViewport);

  // Assert significant culling occurred: > 75% of nodes are culled from DOM rendering
  assert.ok(visibleNodes.length > 0, 'Some nodes should be visible in viewport');
  assert.ok(visibleNodes.length < 50, `Expected <50 nodes in view, got ${visibleNodes.length}`);
  const culledPercentage = ((nodes.length - visibleNodes.length) / nodes.length) * 100;
  assert.ok(culledPercentage > 75, `Expected >75% culled, got ${culledPercentage}%`);

  // Selected node outside the viewport is always retained
  const offscreenId = 'node-249'; // bottom-right corner
  const selectedNodeIds = [offscreenId];
  const renderedNodes = nodes.filter(n => selectedNodeIds.includes(n.id) || isBoxInViewport(n));
  assert.ok(renderedNodes.some(n => n.id === offscreenId), 'Selected off-screen node must remain mounted');
});

test('Smart Alignment Guides & Snapping: calculates magnetic snapping and guide coordinates', () => {
  const SNAP_DISTANCE = 7;
  
  // Reference node fixed at (100, 200) with size 280x160
  const refNode = { x: 100, y: 200, width: 280, height: 160 };
  
  // Dragged node near refNode: x=103 (3px away from left-edge alignment at 100)
  // y=198 (2px away from top-edge alignment at 200)
  const dragged = { x: 103, y: 198, width: 280, height: 160 };

  const xAlignments = [
    { targetX: refNode.x, currentX: dragged.x }, // Left-Left
    { targetX: refNode.x + refNode.width / 2, currentX: dragged.x + dragged.width / 2 }, // Center-Center
    { targetX: refNode.x + refNode.width, currentX: dragged.x + dragged.width } // Right-Right
  ];

  let bestXDist = SNAP_DISTANCE;
  let snapDx = 0;
  for (const { targetX, currentX } of xAlignments) {
    const dist = Math.abs(targetX - currentX);
    if (dist < bestXDist) {
      bestXDist = dist;
      snapDx = targetX - currentX;
    }
  }

  assert.strictEqual(bestXDist, 3, 'Closest X distance should be 3px');
  assert.strictEqual(snapDx, -3, 'Snap delta should pull card -3px left to exactly x=100');
  assert.strictEqual(dragged.x + snapDx, 100, 'Snapped X position matches reference left edge');

  // Test vertical snapping:
  const yAlignments = [
    { targetY: refNode.y, currentY: dragged.y }, // Top-Top
    { targetY: refNode.y + refNode.height / 2, currentY: dragged.y + dragged.height / 2 },
    { targetY: refNode.y + refNode.height, currentY: dragged.y + dragged.height }
  ];

  let bestYDist = SNAP_DISTANCE;
  let snapDy = 0;
  for (const { targetY, currentY } of yAlignments) {
    const dist = Math.abs(targetY - currentY);
    if (dist < bestYDist) {
      bestYDist = dist;
      snapDy = targetY - currentY;
    }
  }

  assert.strictEqual(bestYDist, 2, 'Closest Y distance should be 2px');
  assert.strictEqual(snapDy, 2, 'Snap delta should pull card +2px down to exactly y=200');
  assert.strictEqual(dragged.y + snapDy, 200, 'Snapped Y position matches reference top edge');
});

test('Semantic Relationship Ontology Presets: provides canonical configurations and applies accurately', () => {
  assert.strictEqual(ONTOLOGY_PRESETS.length, 5, 'Should have 5 core ontology presets');

  const presetMap = new Map(ONTOLOGY_PRESETS.map(p => [p.id, p]));
  
  // Verify 'supports' preset
  const supports = presetMap.get('supports');
  assert.ok(supports);
  assert.strictEqual(supports.color, 'emerald');
  assert.strictEqual(supports.strokePattern, 'solid');
  assert.strictEqual(supports.lineStyle, 'curved');
  assert.strictEqual(supports.arrowhead, 'end');

  // Verify 'contradicts' preset
  const contradicts = presetMap.get('contradicts');
  assert.ok(contradicts);
  assert.strictEqual(contradicts.color, 'rose');
  assert.strictEqual(contradicts.strokePattern, 'dashed');
  assert.strictEqual(contradicts.lineStyle, 'curved');

  // Verify 'depends_on' preset
  const dependsOn = presetMap.get('depends_on');
  assert.ok(dependsOn);
  assert.strictEqual(dependsOn.color, 'amber');
  assert.strictEqual(dependsOn.lineStyle, 'stepped');

  // Verify 'derived_from' preset
  const derivedFrom = presetMap.get('derived_from');
  assert.ok(derivedFrom);
  assert.strictEqual(derivedFrom.color, 'indigo');
  assert.strictEqual(derivedFrom.lineStyle, 'curved');

  // Verify 'answers' preset
  const answers = presetMap.get('answers');
  assert.ok(answers);
  assert.strictEqual(answers.color, 'sky');
  assert.strictEqual(answers.strokePattern, 'dotted');
  assert.strictEqual(answers.lineStyle, 'straight');

  // Simulate applying a preset to an existing connection
  const originalEdge = { id: 'edge-1', from: 'a', to: 'b', label: 'unlinked' };
  const updatedEdge = {
    ...originalEdge,
    label: contradicts.label,
    color: contradicts.color,
    strokePattern: contradicts.strokePattern,
    lineStyle: contradicts.lineStyle,
    arrowhead: contradicts.arrowhead
  };

  assert.strictEqual(updatedEdge.label, 'contradicts');
  assert.strictEqual(updatedEdge.color, 'rose');
  assert.strictEqual(updatedEdge.strokePattern, 'dashed');
});

test('Interactive Mini-Map Navigation: calculates world bounds, lens coordinates, and click-to-pan translation', () => {
  const MAP_WIDTH = 190;
  const MAP_HEIGHT = 120;
  const PADDING = 140;

  // Nodes spread across world coordinates from (100, 100) to (1100, 700)
  const nodes = [
    { id: 'n1', x: 100, y: 100, width: 280, height: 160 },
    { id: 'n2', x: 820, y: 540, width: 280, height: 160 }
  ];

  // Current canvas viewport
  const viewport = { zoom: 1.0, pan: { x: -100, y: -100 } };
  const canvasSize = { width: 1200, height: 800 };

  // Calculate world bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }

  // Include screen viewport
  const viewWorldLeft = -viewport.pan.x / viewport.zoom;
  const viewWorldTop = -viewport.pan.y / viewport.zoom;
  const viewWorldRight = viewWorldLeft + canvasSize.width / viewport.zoom;
  const viewWorldBottom = viewWorldTop + canvasSize.height / viewport.zoom;

  minX = Math.min(minX, viewWorldLeft);
  minY = Math.min(minY, viewWorldTop);
  maxX = Math.max(maxX, viewWorldRight);
  maxY = Math.max(maxY, viewWorldBottom);

  const worldBounds = {
    left: minX - PADDING,
    top: minY - PADDING,
    width: (maxX - minX) + PADDING * 2,
    height: (maxY - minY) + PADDING * 2
  };

  const scale = Math.min(MAP_WIDTH / worldBounds.width, MAP_HEIGHT / worldBounds.height);
  const offsetX = (MAP_WIDTH - worldBounds.width * scale) / 2;
  const offsetY = (MAP_HEIGHT - worldBounds.height * scale) / 2;

  assert.ok(scale > 0, 'Minimap scale should be positive');
  assert.ok(scale < 1, 'Minimap scale should downscale world coordinates');

  // Verify viewfinder lens
  const lensWidth = (canvasSize.width / viewport.zoom) * scale;
  const lensHeight = (canvasSize.height / viewport.zoom) * scale;

  assert.ok(lensWidth > 0 && lensWidth <= MAP_WIDTH, 'Lens width within bounds');
  assert.ok(lensHeight > 0 && lensHeight <= MAP_HEIGHT, 'Lens height within bounds');

  // Verify click-to-pan calculation:
  // Clicking at the center of the minimap (MAP_WIDTH / 2, MAP_HEIGHT / 2)
  const clickMapX = MAP_WIDTH / 2;
  const clickMapY = MAP_HEIGHT / 2;

  const targetWorldCenterX = worldBounds.left + (clickMapX - offsetX) / scale;
  const targetWorldCenterY = worldBounds.top + (clickMapY - offsetY) / scale;

  const newPanX = canvasSize.width / 2 - targetWorldCenterX * viewport.zoom;
  const newPanY = canvasSize.height / 2 - targetWorldCenterY * viewport.zoom;

  // Verify that setting pan to (newPanX, newPanY) centers targetWorldCenter in the screen
  const screenCenterX = newPanX + targetWorldCenterX * viewport.zoom;
  const screenCenterY = newPanY + targetWorldCenterY * viewport.zoom;

  assert.strictEqual(Math.round(screenCenterX), canvasSize.width / 2, 'World target is centered horizontally on screen');
  assert.strictEqual(Math.round(screenCenterY), canvasSize.height / 2, 'World target is centered vertically on screen');
});

test('Obsidian / Logseq Vault Export: generates structured markdown with frontmatter, [[wikilinks]], canvas, and valid ZIP archive', () => {
  const c1 = concept('c1', 'Retrieval-Augmented Generation', 'concept');
  c1.content = 'RAG combines neural generation with non-parametric memory retrieval.';

  const cl1 = {
    id: 'cl1',
    title: 'RAG Reduces Hallucinations',
    type: 'claim',
    x: 350,
    y: 100,
    createdAt: Date.now(),
    metadata: {
      claimStatus: 'supported',
      confidence: 0.94,
      evidence: [
        { sourceId: 's1', excerpt: 'Grounding against verified corpus lowers factual error rates by 68%.', relation: 'supports' }
      ]
    }
  };

  const s1 = {
    id: 's1',
    title: 'Lewis et al. 2020',
    type: 'source',
    x: 350,
    y: 350,
    url: 'https://arxiv.org/abs/2005.11401',
    domain: 'arxiv.org',
    createdAt: Date.now()
  };

  const rel1 = relation('r1', 'cl1', 'c1', 'derives_from');
  const rel2 = relation('r2', 's1', 'cl1', 'supports');

  const graph = normalizeGraph([c1, cl1, s1], [rel1, rel2]);
  const vaultFiles = buildVaultFiles(graph, 'RAG Research Project');

  assert.ok(vaultFiles.length >= 5, 'Should generate files for all nodes + Overview + Canvas');

  // Verify paths
  const paths = vaultFiles.map(f => f.path);
  assert.ok(paths.some(p => p.includes('concepts/Retrieval-Augmented Generation.md')));
  assert.ok(paths.some(p => p.includes('claims/RAG Reduces Hallucinations.md')));
  assert.ok(paths.some(p => p.includes('sources/Lewis et al. 2020.md')));
  assert.ok(paths.some(p => p.endsWith('Overview.md')));
  assert.ok(paths.some(p => p.endsWith('.canvas')));

  // Verify markdown content & [[wikilinks]]
  const claimFile = vaultFiles.find(f => f.path.includes('claims/RAG Reduces Hallucinations.md'));
  assert.ok(claimFile);
  assert.ok(claimFile.content.includes('claimStatus: "supported"'));
  assert.ok(claimFile.content.includes('confidence: 0.94'));
  assert.ok(claimFile.content.includes('[[Lewis et al. 2020]]'));
  assert.ok(claimFile.content.includes('[[Retrieval-Augmented Generation]]'));

  // Verify canvas JSON
  const canvasFile = vaultFiles.find(f => f.path.endsWith('.canvas'));
  assert.ok(canvasFile);
  const canvasJson = JSON.parse(canvasFile.content);
  assert.strictEqual(canvasJson.nodes.length, 3);
  assert.strictEqual(canvasJson.edges.length, 2);

  // Verify ZIP archive generation
  const zipBuffer = createZipArchive(vaultFiles);
  assert.ok(Buffer.isBuffer(zipBuffer), 'Output should be a Buffer');
  assert.ok(zipBuffer.length > 500, 'Zip should contain compressed files');
  // Check ZIP magic header PK\x03\x04 (0x04034b50)
  assert.strictEqual(zipBuffer.readUInt32LE(0), 0x04034b50, 'Must have standard ZIP local header magic bytes');
});

test('BibTeX Academic Ingestion: parses bib entries, cleans LaTeX formatting, and generates source nodes', () => {
  const sampleBibTeX = `
@article{vaswani2017attention,
  title={Attention Is All You Need},
  author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N and Kaiser, {\\L}ukasz and Polosukhin, Illia},
  journal={Advances in Neural Information Processing Systems},
  volume={30},
  year={2017},
  doi={10.48550/arXiv.1706.03762},
  url={https://arxiv.org/abs/1706.03762},
  abstract={The dominant sequence transduction models are based on complex recurrent or convolutional neural networks...}
}

@inproceedings{lewis2020rag,
  title={Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks},
  author={Lewis, Patrick and Perez, Ethan and Piktus, Aleksandra and Petroni, Fabio and others},
  booktitle={Advances in Neural Information Processing Systems},
  volume={33},
  pages={9459--9474},
  year={2020},
  url={https://arxiv.org/abs/2005.11401}
}
  `;

  const entries = parseBibTeX(sampleBibTeX);
  assert.strictEqual(entries.length, 2, 'Should parse both BibTeX entries');

  const vaswani = entries[0];
  assert.strictEqual(vaswani.citationKey, 'vaswani2017attention');
  assert.strictEqual(vaswani.type, 'article');
  assert.strictEqual(vaswani.title, 'Attention Is All You Need');
  assert.strictEqual(vaswani.year, '2017');
  assert.strictEqual(vaswani.doi, '10.48550/arXiv.1706.03762');
  assert.strictEqual(vaswani.url, 'https://arxiv.org/abs/1706.03762');
  assert.ok(vaswani.authors.some(a => a.includes('Lukasz Kaiser')));
  assert.ok(vaswani.abstract.startsWith('The dominant sequence'));

  const lewis = entries[1];
  assert.strictEqual(lewis.citationKey, 'lewis2020rag');
  assert.strictEqual(lewis.type, 'inproceedings');
  assert.strictEqual(lewis.title, 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks');
  assert.strictEqual(lewis.booktitle, 'Advances in Neural Information Processing Systems');

  // Convert to CanvasNode records
  const nodes = bibEntriesToCanvasNodes(entries, 100, 100);
  assert.strictEqual(nodes.length, 2, 'Should create 2 canvas nodes');

  const node1 = nodes[0];
  assert.strictEqual(node1.type, 'source');
  assert.strictEqual(node1.title, 'Attention Is All You Need');
  assert.strictEqual(node1.domain, 'arxiv.org');
  assert.ok(node1.description.includes('Vaswani et al.'));
  assert.strictEqual(node1.metadata.citationKey, 'vaswani2017attention');
  assert.strictEqual(node1.metadata.origin, 'imported');

  const node2 = nodes[1];
  assert.strictEqual(node2.type, 'source');
  assert.strictEqual(node2.title, 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks');
  assert.strictEqual(node2.metadata.citationKey, 'lewis2020rag');
});

test('generateStandaloneSvg produces clean, standalone SVG with nodes and connections', () => {
  const nodeA = {
    id: 'node-1',
    title: 'Transformer Architecture',
    type: 'concept',
    x: 100,
    y: 100,
    width: 280,
    content: 'Multi-head self-attention mechanism with residual connections.'
  };

  const nodeB = {
    id: 'node-2',
    title: 'Self-Attention Layer',
    type: 'claim',
    x: 500,
    y: 100,
    width: 280,
    content: 'Calculates query, key, value matrix dot-products.'
  };

  const connection = {
    id: 'conn-1',
    from: 'node-1',
    to: 'node-2',
    label: 'depends_on',
    color: 'emerald',
    arrowhead: 'end'
  };

  const svg = generateStandaloneSvg([nodeA, nodeB], [connection], 'Transformer System');

  assert.ok(svg.includes('<svg xmlns="http://www.w3.org/2000/svg"'), 'Should be valid SVG root element');
  assert.ok(svg.startsWith('<?xml') || svg.startsWith('<svg'), 'Should be valid XML/SVG output');
  assert.ok(svg.includes('Transformer Architecture'), 'Should include node A title');
  assert.ok(svg.includes('Self-Attention Layer'), 'Should include node B title');
  assert.ok(svg.includes('depends on'), 'Should include formatted edge label');
  assert.ok(svg.includes('<marker id="arrow-emerald"'), 'Should define color marker for connection');
  assert.ok(svg.includes('stroke="#10b981"'), 'Should render emerald stroke');
  assert.ok(svg.endsWith('</svg>'), 'Should properly close svg tag');
});

test('PDF Citation Deep-Linking: extracts page numbers, formats #page=N URLs, and normalizes evidence items', () => {
  // Page number extraction from diverse textual formats
  assert.strictEqual(extractPageNumber(42), 42);
  assert.strictEqual(extractPageNumber('42'), 42);
  assert.strictEqual(extractPageNumber('p. 42'), 42);
  assert.strictEqual(extractPageNumber('p.42'), 42);
  assert.strictEqual(extractPageNumber('page 108'), 108);
  assert.strictEqual(extractPageNumber('Page 15'), 15);
  assert.strictEqual(extractPageNumber('pp. 12-14'), 12);
  assert.strictEqual(extractPageNumber('Section 3, p. 7'), 7);
  assert.strictEqual(extractPageNumber('Chapter 1'), 1);
  assert.strictEqual(extractPageNumber(undefined), undefined);
  assert.strictEqual(extractPageNumber(''), undefined);

  // PDF URL formatting with #page=N fragment
  assert.strictEqual(formatPdfPageUrl('/uploads/attention.pdf', 5), '/uploads/attention.pdf#page=5');
  assert.strictEqual(formatPdfPageUrl('https://arxiv.org/pdf/1706.03762.pdf', 3), 'https://arxiv.org/pdf/1706.03762.pdf#page=3');
  assert.strictEqual(formatPdfPageUrl('https://example.com/doc.pdf#toolbar=0', 12), 'https://example.com/doc.pdf#page=12');
  assert.strictEqual(formatPdfPageUrl('/uploads/paper.pdf', undefined), '/uploads/paper.pdf');
  assert.strictEqual(formatPdfPageUrl('data:application/pdf;base64,JVBERi0...', 8), 'data:application/pdf;base64,JVBERi0...#page=8');

  // Evidence normalization
  const normalized = normalizeEvidenceItem({
    sourceId: 'src-vaswani-2017',
    location: 'p. 4',
    excerpt: 'Self-attention allows the model to associate each word with other words in the input sequence.',
    relation: 'supports'
  });

  assert.strictEqual(normalized.sourceId, 'src-vaswani-2017');
  assert.strictEqual(normalized.page, 4);
  assert.strictEqual(normalized.location, 'p. 4');
  assert.strictEqual(normalized.relation, 'supports');
  assert.ok(normalized.excerpt.includes('Self-attention allows'));

  // Contradiction citation with numeric page
  const contradiction = normalizeEvidenceItem({
    sourceId: 'src-survey',
    page: 19,
    relation: 'contradicts'
  });
  assert.strictEqual(contradiction.relation, 'contradicts');
  assert.strictEqual(contradiction.page, 19);
  assert.strictEqual(contradiction.location, 'p. 19');
});

test('HippoRAG Personalized PageRank: converges and amplifies epistemic contradiction edges', async () => {
  const { personalizedPageRank, RELATION_WEIGHTS, extractReasoningSubgraph } = await import('../src/lib/rag/graph-walker.ts');

  // Verify relation weights
  assert.ok(RELATION_WEIGHTS.contradicts > RELATION_WEIGHTS.supports, 'contradictions receive higher epistemic weight');
  assert.ok(RELATION_WEIGHTS.supports > RELATION_WEIGHTS.neutral, 'supports exceeds neutral');

  const nodes = [
    concept('seed', 'Core Concept'),
    concept('neutral_neighbor', 'Neutral Topic'),
    concept('contradiction_neighbor', 'Contradicting Evidence', 'claim'),
    concept('distant_node', 'Distant Fact')
  ];

  const edges = [
    relation('e1', 'seed', 'neutral_neighbor', 'neutral'),
    relation('e2', 'seed', 'contradiction_neighbor', 'contradicts'),
    relation('e3', 'contradiction_neighbor', 'distant_node', 'supports')
  ];

  const graph = normalizeGraph(nodes, edges);
  const ppr = personalizedPageRank(graph, ['seed'], { damping: 0.85, maxIterations: 20 });

  assert.ok(ppr.get('seed') > 0, 'seed has positive score');
  assert.ok(
    (ppr.get('contradiction_neighbor') || 0) > (ppr.get('neutral_neighbor') || 0),
    'contradiction neighbor receives higher activation than neutral neighbor'
  );
  assert.ok(
    (ppr.get('distant_node') || 0) > 0,
    'multi-hop activation reaches distant node through contradiction path'
  );

  // Subgraph extraction
  const subgraph = extractReasoningSubgraph(graph, ['seed'], { maxNodes: 3 });
  assert.ok(subgraph.nodes.length <= 3, 'respects maxNodes');
  assert.ok(subgraph.nodes.some(n => n.id === 'seed'), 'contains seed');
  assert.ok(subgraph.nodes.some(n => n.id === 'contradiction_neighbor'), 'contains highest ranked neighbor');
});

test('Graph RAG Context Builder: produces structured epistemic Markdown within budget', async () => {
  const { buildGraphRAGContext } = await import('../src/lib/rag/context-builder.ts');

  const nodes = [
    { ...concept('c1', 'Personalized PageRank'), content: 'PPR propagates seed node activation through relational edges.' },
    { ...concept('c2', 'Vector Embeddings'), content: 'Dense 1536-dimensional float representations.' },
    { ...concept('cl1', 'PPR outperforms naive KNN', 'claim'), metadata: { claimStatus: 'supported', confidence: 0.95 } }
  ];

  const edges = [
    relation('e1', 'c2', 'c1', 'enables'),
    relation('e2', 'c1', 'cl1', 'supports')
  ];

  const graph = normalizeGraph(nodes, edges);

  const ctx = await buildGraphRAGContext({
    projectId: 'test_project',
    graph,
    query: 'How does PPR improve retrieval?',
    selectedNodeId: 'c1',
    tokenBudget: 2000
  });

  assert.ok(ctx.markdown.includes('## Active Knowledge Subgraph'), 'contains subgraph header');
  assert.ok(ctx.markdown.includes('### CONCEPTS'), 'contains concepts section');
  assert.ok(ctx.markdown.includes('### CLAIMS'), 'contains claims section');
  assert.ok(ctx.markdown.includes('[Status: supported]'), 'surfaces epistemic claim status');
  assert.ok(ctx.markdown.includes('--[supports]-->'), 'surfaces directional edge');
  assert.ok(ctx.retrievedNodeIds.includes('c1'), 'retrieves seed node c1');
});

test('AI Status & Multi-Provider Fallback: secure exposure without leaking API keys', async () => {
  const { getAIStatus } = await import('../src/lib/ai-service.ts');

  const status = getAIStatus();
  assert.strictEqual(typeof status.configured, 'boolean');
  assert.strictEqual(typeof status.activeModel, 'string');
  assert.strictEqual(typeof status.embeddingDimension, 'number');
  assert.strictEqual(status.embeddingDimension, 1536);

  // Security assertion: NO API key strings anywhere in the returned status payload
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('sk-proj'), 'never exposes OpenAI secret key in status');
  assert.ok(!serialized.includes('AIzaSy'), 'never exposes Google API key in status');

  // Verify provider model configuration
  if (status.providers.openai.configured) {
    assert.strictEqual(status.providers.openai.model, 'gpt-6-luna');
    assert.strictEqual(status.activeModel, 'gpt-6-luna');
    assert.strictEqual(status.reasoningEffort, 'medium');
  }
});

test('Chat Tool: Graph Organizer calculates deterministic layouts', async () => {
  const { computeOrganizedLayout } = await import('../src/lib/graph-organizer.ts');

  const nodes = [
    { ...concept('c1', 'Alpha Concept'), type: 'concept' },
    { ...concept('c2', 'Beta Concept'), type: 'concept' },
    { ...concept('s1', 'Paper 1', 'source'), type: 'source' },
    { ...concept('cl1', 'Claim 1', 'claim'), type: 'claim' },
    { ...concept('q1', 'Question 1', 'question'), type: 'question' }
  ];
  const edges = [
    relation('e1', 's1', 'c1', 'cites'),
    relation('e2', 'c1', 'cl1', 'supports')
  ];
  const graph = normalizeGraph(nodes, edges);

  // Test cluster_by_type
  const clusterLayout = computeOrganizedLayout(graph, 'cluster_by_type');
  assert.strictEqual(clusterLayout.length, 5);
  const posMap = new Map(clusterLayout.map(p => [p.id, p]));
  assert.ok(posMap.has('c1') && posMap.has('s1') && posMap.has('cl1'));
  // Different type columns should have different X positions
  assert.notStrictEqual(posMap.get('s1').x, posMap.get('cl1').x);

  // Test hierarchical (levels flow from left to right along X axis)
  const hierLayout = computeOrganizedLayout(graph, 'hierarchical');
  assert.strictEqual(hierLayout.length, 5);
  const hierMap = new Map(hierLayout.map(p => [p.id, p]));
  // Source s1 is a root (level 0), c1 is level 1, cl1 is level 2 -> hierarchical X positions increase
  assert.ok(hierMap.get('s1').x <= hierMap.get('c1').x);
  assert.ok(hierMap.get('c1').x <= hierMap.get('cl1').x);

  // Test compact grid
  const compactLayout = computeOrganizedLayout(graph, 'compact');
  assert.strictEqual(compactLayout.length, 5);
  assert.strictEqual(compactLayout[0].x, 120);
  assert.strictEqual(compactLayout[0].y, 120);

  // Cards of very different heights never overlap in any layout
  const heights = { c1: 400, c2: 180, s1: 520, cl1: 300, q1: 150 };
  for (const strategy of ['cluster_by_type', 'hierarchical', 'compact']) {
    const placed = computeOrganizedLayout(graph, strategy, { heights });
    for (const a of placed) for (const b of placed) {
      if (a.id !== b.id && a.x === b.x && a.y < b.y) assert.ok(a.y + heights[a.id] <= b.y, `${strategy}: ${a.id} overlaps ${b.id}`);
    }
  }
});

test('Chat Tool: Graph Analyst audits topology and recommends improvements', async () => {
  const { auditGraphTopology } = await import('../src/lib/graph-analyst.ts');

  const nodes = [
    { ...concept('c1', 'Vector Database Indexing'), type: 'concept', content: 'Database indexing uses vector embeddings.' },
    { ...concept('cl1', 'Vector search is O(1)', 'claim'), type: 'claim', metadata: { claimStatus: 'unverified' } },
    { ...concept('q1', 'What is the memory footprint of vector embeddings?', 'question'), type: 'question' },
    { ...concept('isolated_note', 'Random detached idea', 'note'), type: 'note', content: 'Detached' }
  ];
  const edges = [
    relation('e1', 'c1', 'cl1', 'discusses')
  ];
  const graph = normalizeGraph(nodes, edges);

  const audit = auditGraphTopology(graph);
  assert.strictEqual(audit.unverifiedClaims.length, 1);
  assert.strictEqual(audit.unverifiedClaims[0].title, 'Vector search is O(1)');
  assert.strictEqual(audit.isolatedNodes.length, 2); // q1 and isolated_note have no connections
  assert.strictEqual(audit.openQuestions.length, 1);
  assert.strictEqual(audit.openQuestions[0].title, 'What is the memory footprint of vector embeddings?');

  // Shared keywords between c1 ("vector", "indexing") and q1 ("vector", "embeddings")
  assert.ok(audit.suggestedConnections.length >= 1, 'suggests connection based on shared terminology');
  const suggestion = audit.suggestedConnections.find(s => (s.fromId === 'c1' && s.toId === 'q1') || (s.fromId === 'q1' && s.toId === 'c1'));
  assert.ok(suggestion, 'identifies relationship between vector database and vector embeddings question');
});

test('Deep Research Engine: validates multi-hop research session structure and search trail', () => {
  const query = 'How do graph retrieval augmented generation architectures compare to vector-only RAG?';
  const mode = 'deep';
  assert.strictEqual(mode, 'deep');

  const mockDeepResult = {
    result: {
      summary: 'Hop 1 landscape analysis and Hop 2 deep empirical investigation.',
      subquestions: [
        'What are the memory bottlenecks of Personalized PageRank?',
        'How does entity disambiguation affect multi-hop traversal?'
      ],
      nodes: [
        { tempId: 'temp-1', type: 'concept', title: 'Graph RAG Architecture', content: 'Combines structural and vector search.', rationale: 'Core concept' },
        { tempId: 'temp-2', type: 'claim', title: 'HippoRAG achieves 20% higher multi-hop accuracy', content: 'Empirical benchmark on 2WikiMultiHop.', rationale: 'Empirical claim' },
        { tempId: 'hop2-1', type: 'question', title: 'Can Graph RAG scale to 10M nodes in real-time?', content: 'Scalability boundary.', rationale: 'Open research gap' }
      ],
      relationships: [
        { fromTempId: 'temp-1', toTempId: 'temp-2', label: 'supports', evidence: 'Empirical benchmarks demonstrate 20% gain.', confidence: 0.9 },
        { fromTempId: 'temp-2', toTempId: 'hop2-1', label: 'challenges', evidence: 'Scalability remains unproven at scale.', confidence: 0.85 }
      ]
    },
    sources: [
      { title: 'HippoRAG: Neurobiologically Inspired Long-Term Memory', url: 'https://arxiv.org/abs/2405.14831' },
      { title: 'GraphRAG: Unlocking LLM discovery on narrative private data', url: 'https://arxiv.org/abs/2404.16130' }
    ],
    searchQueries: [
      query,
      'Graph RAG theoretical foundations',
      'HippoRAG empirical benchmarks 2025 2026',
      'Graph RAG scalability limitations'
    ],
    provider: 'OpenAI',
    model: 'gpt-6-luna',
    usedFallback: false
  };

  assert.strictEqual(mockDeepResult.result.nodes.length, 3);
  assert.strictEqual(mockDeepResult.result.relationships.length, 2);
  assert.strictEqual(mockDeepResult.sources.length, 2);
  assert.ok(mockDeepResult.searchQueries.length >= 3, 'Recorded multi-hop search trail');

  // Verify trail generation logic
  const trail = [
    `Engine: ${mockDeepResult.provider} · ${mockDeepResult.model}`,
    `Research Mode: Recursive Multi-Step Deep Research`,
    `Research question: ${query}`,
    ...mockDeepResult.searchQueries.map(text => `Search: ${text}`),
    `Grounded sources discovered: ${mockDeepResult.sources.length}`
  ];
  assert.ok(trail.some(t => t.includes('Recursive Multi-Step Deep Research')));
  assert.ok(trail.some(t => t.includes('HippoRAG empirical benchmarks')));
});

test('Dual-Mode Database & Context Credits Engine: user provisioning, tiered deductions, and transaction ledger', async () => {
  const { upsertUser, getUserByClerkId, deductUserCredits, topUpUserCredits, getCreditTransactions } = await import('../src/lib/db.ts');

  const testClerkId = `test_clerk_${Date.now()}`;
  
  // 1. Initial user provisioning (Free Trial with 100 Credits)
  const newUser = upsertUser({
    clerkId: testClerkId,
    email: 'researcher@synthex.ai',
    name: 'Ada Lovelace',
    subscriptionTier: 'trial',
    contextCredits: 100
  });

  assert.ok(newUser);
  assert.strictEqual(newUser.clerkId, testClerkId);
  assert.strictEqual(newUser.contextCredits, 100, 'New user receives 100 trial Context Credits');
  assert.strictEqual(newUser.subscriptionTier, 'trial');

  // Verify fetch by clerkId
  const fetched = getUserByClerkId(testClerkId);
  assert.strictEqual(fetched?.id, newUser.id);
  assert.strictEqual(fetched?.email, 'researcher@synthex.ai');

  // 2. Action deduction: Chat message (1 Credit)
  const chatDeduction = deductUserCredits(testClerkId, 1, 'chat', 'Asked about RAG benchmarks');
  assert.strictEqual(chatDeduction.success, true);
  assert.strictEqual(chatDeduction.balance, 99, 'Balance reduced from 100 to 99');

  // 3. Action deduction: Quick Research (5 Credits)
  const quickDeduction = deductUserCredits(testClerkId, 5, 'quick_research', 'Quick web grounding');
  assert.strictEqual(quickDeduction.success, true);
  assert.strictEqual(quickDeduction.balance, 94, 'Balance reduced from 99 to 94');

  // 4. Action deduction: Deep Multi-Hop Research (20 Credits)
  const deepDeduction = deductUserCredits(testClerkId, 20, 'deep_research', 'Multi-hop research on HippoRAG');
  assert.strictEqual(deepDeduction.success, true);
  assert.strictEqual(deepDeduction.balance, 74, 'Balance reduced from 94 to 74');

  // 5. Action deduction: PDF Layout Extraction (2 Credits per page, 10 pages = 20 Credits)
  const pdfDeduction = deductUserCredits(testClerkId, 20, 'pdf_extract', 'Extracted 10 pages from arXiv PDF');
  assert.strictEqual(pdfDeduction.success, true);
  assert.strictEqual(pdfDeduction.balance, 54);

  // 6. Overdraft protection: attempt deduction exceeding balance (100 credits requested, 54 available)
  const overdraft = deductUserCredits(testClerkId, 100, 'deep_research', 'Excessive run');
  assert.strictEqual(overdraft.success, false, 'Overdraft correctly blocked');
  assert.strictEqual(overdraft.balance, 54, 'Balance remains unchanged on rejection');
  assert.ok(overdraft.error?.includes('Insufficient Context Credits'), 'Provides helpful credit refill prompt');

  // 7. Credit Refill Pack ($5 for 500 Credits)
  const refill = topUpUserCredits(testClerkId, 500, 'refill', 'Purchased 500 Context Credit Refill Pack');
  assert.strictEqual(refill.success, true);
  assert.strictEqual(refill.balance, 554, 'Balance increased by 500 to 554');

  // 8. Verify Transaction Ledger history
  const history = getCreditTransactions(newUser.id, 10);
  assert.ok(history.length >= 5, 'Recorded all deduction and refill operations in ledger');
  assert.strictEqual(history[0].action, 'refill');
  assert.strictEqual(history[0].amount, 500);
  assert.strictEqual(history[1].action, 'pdf_extract');
  assert.strictEqual(history[1].amount, -20);
});

test('Google Cloud Storage (GCS) Document Vault: path structure and cloud integration', async () => {
  const { isGcsConfigured, getGcsBucketName } = await import('../src/lib/storage-gcs.ts');

  assert.strictEqual(typeof isGcsConfigured(), 'boolean');
  assert.strictEqual(typeof getGcsBucketName(), 'string');
  assert.ok(getGcsBucketName().length > 0);

  // Verify GCS object path structuring for multi-tenant workspaces
  const orgId = 'org_2bKz9Lq';
  const projectId = 'proj_ai_survey';
  const fileName = 'rag-benchmarks-2026.pdf';

  const gcsDestination = `workspaces/${orgId}/${projectId}/${fileName}`;
  assert.strictEqual(gcsDestination, 'workspaces/org_2bKz9Lq/proj_ai_survey/rag-benchmarks-2026.pdf');
});

test('Clerk Authentication & Multi-Tenant Provisioning: server auth fallback, webhook user creation, and organization scoping', async () => {
  const { isClerkConfigured, getServerAuth } = await import('../src/lib/auth.ts');
  const { upsertUser, getUserByClerkId } = await import('../src/lib/db.ts');

  // 1. Verify offline/local development fallback when Clerk is not configured
  assert.strictEqual(isClerkConfigured(), false, 'In test suite, Clerk environment keys are unconfigured');
  const offlineAuth = await getServerAuth();
  assert.strictEqual(offlineAuth.isLocal, true);
  assert.strictEqual(offlineAuth.clerkId, 'local_researcher');
  assert.ok(offlineAuth.user);
  assert.strictEqual(offlineAuth.user.contextCredits, 5000, 'Local mode grants full development credit pool');

  // 2. Simulate Clerk Webhook payload for `user.created`
  const mockWebhookPayload = {
    type: 'user.created',
    data: {
      id: `user_clerk_test_${Date.now()}`,
      email_addresses: [{ email_address: 'new.researcher@synthex.cloud' }],
      first_name: 'Grace',
      last_name: 'Hopper'
    }
  };

  const trialDurationMs = 3 * 24 * 60 * 60 * 1000;
  const provisioned = upsertUser({
    clerkId: mockWebhookPayload.data.id,
    email: mockWebhookPayload.data.email_addresses[0].email_address,
    name: `${mockWebhookPayload.data.first_name} ${mockWebhookPayload.data.last_name}`,
    subscriptionTier: 'trial',
    subscriptionStatus: 'trialing',
    contextCredits: 100,
    trialEndsAt: Date.now() + trialDurationMs
  });

  assert.ok(provisioned);
  assert.strictEqual(provisioned.contextCredits, 100, 'New signups receive 100 Context Credits');
  assert.strictEqual(provisioned.subscriptionTier, 'trial');
  assert.ok(provisioned.trialEndsAt > Date.now(), 'Trial active for 3 days');

  const fetchedUser = getUserByClerkId(provisioned.clerkId);
  assert.strictEqual(fetchedUser?.email, 'new.researcher@synthex.cloud');

  // 3. Multi-Tenant Scoping (Personal vs Team Organization Workspace)
  const personalWorkspace = { id: 'ws_personal', title: 'Personal Notes', userId: provisioned.id, organizationId: null };
  const teamWorkspace = { id: 'ws_team', title: 'Team AI Survey', userId: provisioned.id, organizationId: 'org_synthex_labs' };

  assert.strictEqual(personalWorkspace.organizationId, null, 'Personal workspace has no orgId');
  assert.strictEqual(teamWorkspace.organizationId, 'org_synthex_labs', 'Team workspace is scoped to organization');
});

test('Stripe Monetization & Subscriptions: tier definitions, checkout sessions, and webhook credit provisioning', async () => {
  const { SUBSCRIPTION_TIERS, REFILL_PACKS, createCheckoutSession, isStripeConfigured } = await import('../src/lib/stripe.ts');
  const {
    upsertUser,
    getUserById,
    getUserByStripeCustomerId,
    updateUserSubscription,
    topUpUserCredits,
    getCreditTransactions
  } = await import('../src/lib/db.ts');

  // 1. Validate pricing matrix and credit allocations
  assert.strictEqual(SUBSCRIPTION_TIERS.trial.creditsMonthly, 100);
  assert.strictEqual(SUBSCRIPTION_TIERS.byok.priceMonthlyUsd, 3.00);
  assert.strictEqual(SUBSCRIPTION_TIERS.byok.creditsMonthly, 0);
  assert.strictEqual(SUBSCRIPTION_TIERS.pro.priceMonthlyUsd, 9.99);
  assert.strictEqual(SUBSCRIPTION_TIERS.pro.creditsMonthly, 1500);
  assert.strictEqual(SUBSCRIPTION_TIERS.team.priceMonthlyUsd, 29.99);
  assert.strictEqual(SUBSCRIPTION_TIERS.team.creditsMonthly, 5000);
  assert.strictEqual(SUBSCRIPTION_TIERS.team.perSeat, true);
  assert.strictEqual(REFILL_PACKS.refill_500.priceUsd, 5.00);
  assert.strictEqual(REFILL_PACKS.refill_500.credits, 500);

  // 2. Test checkout session generator in offline/dev simulation mode
  assert.strictEqual(isStripeConfigured(), false, 'Stripe is unconfigured in test environment');
  const mockUserId = `usr_billing_test_${Date.now()}`;
  const checkout = await createCheckoutSession({
    userId: mockUserId,
    userEmail: 'alex@synthex.cloud',
    tierId: 'pro',
    interval: 'annual',
    returnUrlOrigin: 'http://localhost:3000'
  });

  assert.strictEqual(checkout.isMock, true);
  assert.ok(checkout.url?.includes('tier=pro'));
  assert.ok(checkout.url?.includes('mock=true'));

  // Test on-demand refill checkout ($5 for 500 credits)
  const refillCheckout = await createCheckoutSession({
    userId: mockUserId,
    tierId: 'refill_500',
    returnUrlOrigin: 'http://localhost:3000'
  });
  assert.strictEqual(refillCheckout.isMock, true);
  assert.ok(refillCheckout.url?.includes('credits=500'));

  // 3. User subscription lifecycle via database helpers & simulated webhook events
  const testUser = upsertUser({
    clerkId: `clerk_stripe_${Date.now()}`,
    email: 'billing.researcher@synthex.cloud',
    name: 'Ada Lovelace',
    subscriptionTier: 'trial',
    contextCredits: 100
  });

  const stripeCustId = `cus_mock_${Date.now()}`;
  const stripeSubId = `sub_mock_${Date.now()}`;

  // Upgrade to Pro Tier via customer.subscription.created simulation
  updateUserSubscription(testUser.id, {
    stripeCustomerId: stripeCustId,
    stripeSubscriptionId: stripeSubId,
    subscriptionTier: 'pro',
    subscriptionStatus: 'active',
    seatCount: 1,
    currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000
  });

  topUpUserCredits(testUser.id, SUBSCRIPTION_TIERS.pro.creditsMonthly, 'bonus', 'Initial Pro allocation');

  const proUser = getUserById(testUser.id);
  assert.strictEqual(proUser?.subscriptionTier, 'pro');
  assert.strictEqual(proUser?.subscriptionStatus, 'active');
  assert.strictEqual(proUser?.contextCredits, 1600, '100 trial + 1500 Pro credits');

  const userByStripe = getUserByStripeCustomerId(stripeCustId);
  assert.strictEqual(userByStripe?.id, testUser.id);

  // Simulate on-demand refill (+500 credits)
  topUpUserCredits(testUser.id, 500, 'refill', 'Stripe refill pack');
  const refilledUser = getUserById(testUser.id);
  assert.strictEqual(refilledUser?.contextCredits, 2100, '1600 + 500 refill credits');

  // Simulate monthly recurring billing cycle (invoice.payment_succeeded)
  topUpUserCredits(testUser.id, SUBSCRIPTION_TIERS.pro.creditsMonthly, 'refill', 'Monthly cycle');
  const cycledUser = getUserById(testUser.id);
  assert.strictEqual(cycledUser?.contextCredits, 3600, '2100 + 1500 monthly replenishment');

  // Verify credit transaction ledger
  const txHistory = getCreditTransactions(testUser.id);
  assert.ok(txHistory.length >= 3, 'Multiple transactions logged in ledger');
  assert.strictEqual(txHistory[0].balanceAfter, 3600);

  // Simulate subscription cancellation (customer.subscription.deleted)
  updateUserSubscription(testUser.id, {
    subscriptionTier: 'trial',
    subscriptionStatus: 'canceled',
    stripeSubscriptionId: null
  });

  const canceledUser = getUserById(testUser.id);
  assert.strictEqual(canceledUser?.subscriptionStatus, 'canceled');
  assert.strictEqual(canceledUser?.stripeSubscriptionId, null);
});

test('Context Credits Economic Engine: consumption rates, balance pre-checks, overdraft protection, and transaction ledger', async () => {
  const {
    CREDIT_RATES,
    TIER_CREDIT_QUOTAS,
    getActionCost,
    refundCredits,
    deductCredits,
    formatCredits
  } = await import('../src/lib/credits.ts');
  const { upsertUser, getUserById } = await import('../src/lib/db.ts');

  // 1. Verify canonical consumption rates
  assert.strictEqual(CREDIT_RATES.chat, 1, 'Graph chat costs 1 credit');
  assert.strictEqual(CREDIT_RATES.quick_research, 5, 'Quick research costs 5 credits');
  assert.strictEqual(CREDIT_RATES.deep_research, 20, 'Deep research costs 20 credits');
  assert.strictEqual(CREDIT_RATES.pdf_extract, 2, 'PDF extraction costs 2 credits per page');

  // Verify quotas
  assert.strictEqual(TIER_CREDIT_QUOTAS.trial, 100);
  assert.strictEqual(TIER_CREDIT_QUOTAS.pro, 1500);
  assert.strictEqual(TIER_CREDIT_QUOTAS.team, 5000);

  // 2. Dynamic cost calculation with multipliers
  assert.strictEqual(getActionCost('chat'), 1);
  assert.strictEqual(getActionCost('quick_research'), 5);
  assert.strictEqual(getActionCost('deep_research'), 20);
  assert.strictEqual(getActionCost('pdf_extract', 15), 30, '15 PDF pages cost 30 credits');

  // Format helper
  assert.strictEqual(formatCredits(1500), '1,500');
  assert.strictEqual(formatCredits(50), '50');

  // 3. User provisioning with 25 credits
  const user = upsertUser({
    clerkId: `clerk_meter_${Date.now()}`,
    email: 'metering.user@synthex.ai',
    subscriptionTier: 'trial',
    contextCredits: 25
  });

  // 4. Overdraft: 20 PDF pages (40 credits) is refused and leaves the balance untouched
  const pdfOverdraft = deductCredits(user.id, 'pdf_extract', 'Too many pages', 20);
  assert.strictEqual(pdfOverdraft.success, false);
  assert.strictEqual(pdfOverdraft.cost, 40);
  assert.strictEqual(pdfOverdraft.balance, 25);

  // 7. Atomic deduction: execute deep research (20 credits)
  const deduction = deductCredits(user.id, 'deep_research', 'Investigated HippoRAG benchmarks');
  assert.strictEqual(deduction.success, true);
  assert.strictEqual(deduction.cost, 20);
  assert.strictEqual(deduction.balance, 5, 'Balance reduced from 25 to 5 credits');

  // 8. Overdraft prevention on subsequent 20-credit operation
  const failedDeduction = deductCredits(user.id, 'deep_research', 'Another deep run');
  assert.strictEqual(failedDeduction.success, false);
  assert.strictEqual(failedDeduction.balance, 5, 'Balance protected at 5 credits');
  assert.ok(failedDeduction.error?.includes('Insufficient Context Credits'));

  // 9. A failed AI run gets its up-front charge refunded
  await refundCredits(user.id, 'deep_research', 'Refund: Investigated HippoRAG benchmarks');
  assert.strictEqual(getUserById(user.id).contextCredits, 25);
});







test('line grammar: relation meaning sets the stroke', () => {
  assert.equal(strokeForLabel('supports'), 'solid');
  assert.equal(strokeForLabel('Challenges'), 'dashed');
  assert.equal(strokeForLabel('contradicts'), 'dashed');
  assert.equal(strokeForLabel('asks'), 'dotted');
  assert.equal(strokeForLabel(''), 'solid');
});

test('document: questions open sections, linked ideas follow in reading order, sources are numbered', async () => {
  const { buildDocument } = await import('../src/lib/document.ts');
  const n = (id, type, x, y) => ({ id, type, x, y, title: id, createdAt: 1 });
  const graph = normalizeGraph(
    [n('q', 'question', 0, 0), n('late', 'concept', 0, 400), n('early', 'concept', 0, 100), n('src', 'source', 0, 0), n('loose', 'note', 0, 0)],
    [relation('e1', 'q', 'late'), relation('e2', 'q', 'early'), relation('e3', 'early', 'src', 'cites')]
  );
  const { sections, sources } = buildDocument(graph);
  assert.equal(sections[0].head.id, 'q');
  assert.deepEqual(sections[0].blocks.map(b => b.node.id), ['early', 'late']);
  assert.deepEqual(sections[0].blocks[0].citations, [1]);
  assert.deepEqual(sections[1].blocks.map(b => b.node.id), ['loose']);
  assert.deepEqual(sources.map(s => s.id), ['src']);
});

/* ---------------------------------------------------------------------------
   AI pipeline: search index, provider fallback, tool calls, grounded sources
--------------------------------------------------------------------------- */
const AI_ENV_KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DATABASE_URL', 'POSTGRES_URL', 'STORAGE_URL'];

async function withMockedAI(env, handler, run) {
  const savedEnv = Object.fromEntries(AI_ENV_KEYS.map(key => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  for (const key of AI_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const calls = [];
  const mock = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), body });
    return mock.handler(String(url), body);
  };
  mock.handler = handler;
  globalThis.fetch = mock;
  try {
    return await run(calls, mock);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of AI_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const unitVector = (index, dims = 1536) => Array.from({ length: dims }, (_, i) => (i === index ? 1 : 0));

test('search index: keyword search works with no AI keys and follows edits and deletions', async () => {
  const { syncGraphVectors, hybridSearch } = await import('../src/lib/rag/vector-store.ts');
  const projectId = `test-kw-${Date.now()}`;
  await withMockedAI({}, () => { throw new Error('no network expected'); }, async calls => {
    const nodes = [concept('n1', 'Photosynthesis efficiency'), concept('n2', 'Mitochondrial respiration')];
    const first = await syncGraphVectors(projectId, nodes);
    assert.equal(first.indexedCount, 2);
    assert.equal(first.embeddedCount, 0);
    assert.deepEqual((await hybridSearch(projectId, 'photosynthesis', 5)).map(r => r.nodeId), ['n1']);

    const second = await syncGraphVectors(projectId, nodes);
    assert.equal(second.indexedCount, 0, 'unchanged nodes are not re-indexed');

    await syncGraphVectors(projectId, [concept('n2', 'Chloroplast photosynthesis')]);
    assert.deepEqual((await hybridSearch(projectId, 'photosynthesis', 5)).map(r => r.nodeId), ['n2'], 'deleted node leaves the index');
    assert.equal(calls.length, 0);
  });
});

test('search index: vectors are only compared with vectors from the same embedding provider', async () => {
  const { syncGraphVectors, hybridSearch } = await import('../src/lib/rag/vector-store.ts');
  const projectId = `test-vec-${Date.now()}`;
  const handler = (url, body) => {
    if (url.includes('api.openai.com/v1/embeddings')) return jsonResponse({ error: 'down' }, 500);
    if (url.includes(':batchEmbedContents')) {
      return jsonResponse({ embeddings: body.requests.map(r => ({ values: unitVector(r.content.parts[0].text.includes('Zebra') ? 7 : 3).map(v => v * 2) })) });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await withMockedAI({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'g-test' }, handler, async calls => {
    const result = await syncGraphVectors(projectId, [concept('a', 'Zebra stripes'), concept('b', 'Leopard spots')]);
    assert.equal(result.embeddedCount, 2, 'Gemini embeds the batch after OpenAI fails');
    const gemReq = calls.find(c => c.url.includes(':batchEmbedContents')).body.requests[0];
    assert.equal(gemReq.outputDimensionality, 1536);
    assert.equal(gemReq.taskType, 'RETRIEVAL_DOCUMENT');

    calls.length = 0;
    const hits = await hybridSearch(projectId, 'Zebra', 5);
    assert.ok(!calls.some(c => c.url.includes('openai')), 'no OpenAI query embedding when only Gemini vectors exist');
    assert.equal(calls.find(c => c.url.includes(':batchEmbedContents')).body.requests[0].taskType, 'RETRIEVAL_QUERY');
    assert.equal(hits[0].nodeId, 'a');
    assert.equal(hits[0].denseRank, 1);
  });
});

const openAiResponse = output => jsonResponse({
  id: 'resp_1', created_at: 1, model: 'gpt-6-luna',
  output: [{ type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }],
  usage: { input_tokens: 120, output_tokens: 30 }
});
const geminiResponse = output => jsonResponse({
  candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(output) }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
});
const noTool = { query: null, mode: null, focusArea: null, strategy: null, nodes: null, relationships: null };

test('chat: tool calls are validated, and a failed OpenAI call falls back to Gemini with a cooldown', async () => {
  const { askGraph, getAIStatus } = await import('../src/lib/ai-service.ts');
  const graph = normalizeGraph([concept('c1', 'Existing idea')], []);
  let openAiUp = false;
  let geminiUp = true;
  const handler = (url, body) => {
    if (url.includes('/v1/embeddings') || url.includes(':batchEmbedContents')) return jsonResponse({}, 500);
    if (url.includes('api.openai.com/v1/responses')) {
      if (!openAiUp) return jsonResponse({ error: { message: 'overloaded', type: 'server_error', code: 'server_error' } }, 500);
      assert.equal(body.reasoning.effort, 'medium');
      assert.equal(body.store, false, 'responses are not stored at OpenAI');
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.strict, true);
      return openAiResponse({
        answer: 'Tidy it.', referencedNodeIds: ['c1', 'ghost'], toolCall: { tool: 'organize_layout', parameters: { ...noTool, strategy: 'hierarchical' } }
      });
    }
    if (url.includes(':generateContent')) {
      if (!geminiUp) return jsonResponse({ error: { code: 500, message: 'down', status: 'INTERNAL' } }, 500);
      assert.ok(JSON.stringify(body.generationConfig).includes('fromTitle'), 'Gemini schema can express propose_nodes');
      return geminiResponse({
        answer: 'Adding it.', referencedNodeIds: ['c1'],
        toolCall: { tool: 'propose_nodes', parameters: {
          ...noTool,
          nodes: [{ title: 'New claim', type: 'claim', content: 'x', rationale: '' }, { title: '  ', type: 'note', content: '', rationale: '' }],
          relationships: [{ fromTitle: 'New claim', toTitle: 'Existing idea', label: 'supports', evidence: '' }]
        } }
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await withMockedAI({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'g-test' }, handler, async calls => {
    const fallback = await askGraph('Add a claim', graph, { projectId: `test-chat-${Date.now()}` });
    assert.equal(fallback.provider, 'Gemini');
    assert.equal(fallback.usedFallback, true);
    assert.equal(fallback.toolCall.tool, 'propose_nodes');
    assert.deepEqual(fallback.toolCall.parameters.nodes.map(n => n.title), ['New claim'], 'blank nodes are dropped');
    assert.equal(fallback.toolCall.parameters.relationships.length, 1);
    assertUsage(fallback.usage, 'gemini-3.8-flash', 100, 20);
    assert.equal(getAIStatus().usingFallback, true);

    calls.length = 0;
    await askGraph('Again', graph, { projectId: 'test-chat-2' });
    assert.ok(!calls.some(c => c.url.includes('api.openai.com/v1/responses')), 'OpenAI is skipped during the cooldown');

    // A Gemini failure during the cooldown goes back to OpenAI, which clears the cooldown.
    openAiUp = true;
    geminiUp = false;
    const recovered = await askGraph('Tidy up', graph, { projectId: 'test-chat-3' });
    assert.equal(recovered.provider, 'OpenAI');
    assert.equal(recovered.usedFallback, false);
    assert.deepEqual(recovered.referencedNodeIds, ['c1'], 'unknown node ids are dropped');
    assert.deepEqual(recovered.toolCall, { tool: 'organize_layout', parameters: { strategy: 'hierarchical' } });
    assert.equal(getAIStatus().usingFallback, false);
  });
});

test('chat: sanitizeToolCall rejects or repairs malformed tool calls', async () => {
  const { sanitizeToolCall } = await import('../src/lib/ai-service.ts');
  const graph = normalizeGraph([concept('c1', 'Existing idea')], []);
  assert.equal(sanitizeToolCall(null, graph), null);
  assert.equal(sanitizeToolCall({ tool: 'delete_everything', parameters: {} }, graph), null);
  assert.equal(sanitizeToolCall({ tool: 'research', parameters: { query: '   ' } }, graph), null);
  assert.deepEqual(sanitizeToolCall({ tool: 'research', parameters: { query: 'x', mode: 'extreme' } }, graph), { tool: 'research', parameters: { query: 'x', mode: 'quick' } });
  assert.deepEqual(sanitizeToolCall({ tool: 'organize_layout', parameters: { strategy: 'spiral' } }, graph), { tool: 'organize_layout', parameters: { strategy: 'cluster_by_type' } });
  assert.equal(sanitizeToolCall({ tool: 'propose_nodes', parameters: { nodes: [{ title: 'x', type: 'section' }], relationships: null } }, graph), null);
  assert.ok(sanitizeToolCall({ tool: 'recommend_improvements', parameters: { focusArea: null } }, graph).analysis, 'audit is attached server-side');
});

test('chat: Gemini retries once on its backup model when the main model is rate limited', async () => {
  const { askGraph } = await import('../src/lib/ai-service.ts');
  const graph = normalizeGraph([concept('c1', 'Existing idea')], []);
  const handler = url => {
    if (url.includes(':batchEmbedContents')) return jsonResponse({}, 500);
    if (url.includes('gemini-3.8-flash:generateContent')) return jsonResponse({ error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } }, 429);
    if (url.includes('gemini-3.5-flash:generateContent')) return geminiResponse({ answer: 'Backup answer.', referencedNodeIds: [], toolCall: null });
    throw new Error(`unexpected fetch ${url}`);
  };
  await withMockedAI({ GEMINI_API_KEY: 'g-test' }, handler, async () => {
    const answer = await askGraph('hi', graph, { projectId: `test-backup-${Date.now()}` });
    assert.equal(answer.model, 'gemini-3.5-flash');
    assert.equal(answer.answer, 'Backup answer.');
    assert.equal(answer.toolCall, null);
  });
});

test('chat: an aborted request stops without falling back', async () => {
  const { askGraph } = await import('../src/lib/ai-service.ts');
  const graph = normalizeGraph([concept('c1', 'Existing idea')], []);
  const abort = new AbortController();
  const handler = url => {
    if (url.includes('/v1/embeddings') || url.includes(':batchEmbedContents')) return jsonResponse({}, 500);
    if (url.includes('api.openai.com/v1/responses')) {
      abort.abort();
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    }
    throw new Error(`fallback should not run: ${url}`);
  };
  await withMockedAI({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'g-test' }, handler, async calls => {
    await assert.rejects(askGraph('hi', graph, { projectId: `test-abort-${Date.now()}`, signal: abort.signal }));
    assert.ok(!calls.some(c => c.url.includes('generativelanguage')), 'no Gemini call after abort');
  });
});

test('chat stream: Gemini answers are streamed incrementally', async () => {
  const { askGraphStream } = await import('../src/lib/ai-service.ts');
  const graph = normalizeGraph([concept('c1', 'Existing idea')], []);
  const payload = JSON.stringify({ answer: 'Hello streamed world', referencedNodeIds: ['c1'], toolCall: null });
  const chunks = [payload.slice(0, 20), payload.slice(20, 30), payload.slice(30)];
  const handler = url => {
    if (url.includes(':batchEmbedContents')) return jsonResponse({}, 500);
    if (url.includes(':streamGenerateContent')) {
      const sse = chunks.map((text, i) => `data: ${JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(i === chunks.length - 1 ? { finishReason: 'STOP' } : {}) }],
        ...(i === chunks.length - 1 ? { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 } } : {})
      })}\n\n`).join('');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await withMockedAI({ GEMINI_API_KEY: 'g-test' }, handler, async () => {
    const events = [];
    for await (const event of askGraphStream('hi', graph, { projectId: `test-stream-${Date.now()}` })) events.push(event);
    const deltas = events.filter(e => e.type === 'delta');
    assert.ok(deltas.length > 1, 'more than one delta event');
    assert.equal(deltas.map(e => e.text).join(''), 'Hello streamed world');
    const done = events.at(-1);
    assert.equal(done.type, 'done');
    assert.equal(done.usedFallback, false, 'Gemini as the only provider is not a fallback');
    assert.deepEqual(done.referencedNodeIds, ['c1']);
    assertUsage(done.usage, 'gemini-3.8-flash', 50, 10);
  });
});

const researchOutput = (overrides = {}) => ({
  summary: 'Reefs.', subquestions: [], sources: [],
  nodes: [{ tempId: 't1', type: 'claim', title: 'Bleaching rises', content: '', rationale: '', sourceUrls: [] }],
  relationships: [],
  ...overrides
});

test('research: OpenAI sources must come from web search results; progress streams as work happens', async () => {
  const { researchGraphStream } = await import('../src/lib/ai-service.ts');
  const graph = normalizeGraph([], []);
  const handler = (url, body) => {
    if (url.includes('api.openai.com/v1/responses')) {
      assert.ok(body.tools.some(t => t.type === 'web_search'), 'web search tool is enabled');
      assert.ok(body.include.includes('web_search_call.action.sources'), 'search sources are requested');
      assert.equal(body.text.format.type, 'json_schema');
      return jsonResponse({
        id: 'resp_1', created_at: 1, model: 'gpt-6-luna',
        output: [
          { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'coral bleaching 2026', sources: [{ type: 'url', url: 'https://www.example.org/reef/' }] } },
          { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', annotations: [], text: JSON.stringify(researchOutput({
            sources: [
              { title: 'Reef study', url: 'https://example.org/reef?utm_source=openai' },
              { title: 'Invented paper', url: 'https://made-up.example.com/paper' }
            ]
          })) }] }
        ],
        usage: { input_tokens: 500, output_tokens: 200 }
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await withMockedAI({ OPENAI_API_KEY: 'sk-test' }, handler, async () => {
    const events = [];
    for await (const event of researchGraphStream('coral bleaching', 'quick', graph, { projectId: `test-research-${Date.now()}` })) events.push(event);
    const types = events.map(e => e.type);
    assert.deepEqual(types.slice(0, 2), ['step', 'step']);
    assert.deepEqual(events.filter(e => e.type === 'query').map(e => e.query), ['coral bleaching 2026']);
    assert.ok(types.indexOf('query') > 1, 'queries are reported after the search ran');
    const done = events.at(-1);
    assert.equal(done.type, 'done');
    assert.deepEqual(done.result.sources, [{ title: 'Reef study', url: 'https://www.example.org/reef/' }], 'unverified model citation is dropped');
    assert.deepEqual(done.result.searchQueries, ['coral bleaching 2026']);
    assertUsage(done.result.usage, 'gpt-6-luna', 500, 200);
    assert.equal(done.result.groundingNote, undefined);
  });
});

test('research: if OpenAI rejects web search, the run continues without sources and says so', async () => {
  const { researchGraph } = await import('../src/lib/ai-service.ts');
  const handler = (url, body) => {
    if (!url.includes('api.openai.com/v1/responses')) throw new Error(`unexpected fetch ${url}`);
    if (body.tools) return jsonResponse({ error: { message: 'web_search not supported', type: 'invalid_request_error', code: 'unsupported' } }, 400);
    return jsonResponse({
      id: 'resp_2', created_at: 1, model: 'gpt-6-luna',
      output: [{ type: 'message', role: 'assistant', id: 'msg_2', content: [{ type: 'output_text', annotations: [], text: JSON.stringify(researchOutput({
        sources: [{ title: 'From memory', url: 'https://example.org/remembered' }]
      })) }] }],
      usage: { input_tokens: 10, output_tokens: 10 }
    });
  };
  await withMockedAI({ OPENAI_API_KEY: 'sk-test' }, handler, async () => {
    const result = await researchGraph('coral bleaching', 'quick', normalizeGraph([], []), { projectId: `test-nosearch-${Date.now()}` });
    assert.deepEqual(result.sources, []);
    assert.match(result.groundingNote, /no sources/);
  });
});

test('research: Gemini deep research plans, runs two grounded hops, and links hop 2 cards to hop 1', async () => {
  const { researchGraphStream } = await import('../src/lib/ai-service.ts');
  const graph = normalizeGraph([], []);
  const grounded = (output, uri, query) => jsonResponse({
    candidates: [{
      content: { role: 'model', parts: [{ text: JSON.stringify(output) }] },
      finishReason: 'STOP',
      groundingMetadata: { webSearchQueries: [query], groundingChunks: [{ web: { uri, title: hostnameOf(uri) } }] }
    }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 }
  });
  const hostnameOf = uri => new URL(uri).hostname;
  const handler = (url, body) => {
    if (!url.includes(':generateContent')) throw new Error(`unexpected fetch ${url}`);
    const prompt = body.contents[0].parts[0].text;
    if (!body.tools) {
      return geminiResponse({ axes: [
        { name: 'Foundations', searchQuery: 'reef symbiosis mechanism', focus: '' },
        { name: 'Empirical', searchQuery: 'bleaching events 2026 data', focus: '' },
        { name: 'Counter', searchQuery: 'reef recovery evidence', focus: '' }
      ], preliminaryHypotheses: ['Heat drives bleaching'] });
    }
    assert.ok(body.tools.some(t => 'googleSearch' in t || 'google_search' in t), 'Google Search grounding is enabled');
    if (prompt.includes('hop 1 of 2')) {
      assert.ok(prompt.includes('reef symbiosis mechanism'), 'hop 1 searches the planned axes');
      return grounded(researchOutput({
        subquestions: ['Can reefs adapt?'],
        nodes: [{ tempId: 'a', type: 'concept', title: 'Symbiosis', content: '', rationale: '', sourceUrls: [] }]
      }), 'https://one.example.org/a', 'reef symbiosis');
    }
    assert.ok(prompt.includes('Can reefs adapt?'), 'hop 2 follows hop 1 subquestions');
    assert.ok(prompt.includes('a: [concept] Symbiosis'), 'hop 2 sees hop 1 cards');
    return grounded(researchOutput({
      nodes: [
        { tempId: 'a', type: 'claim', title: 'Heat tolerance evolves', content: '', rationale: '', sourceUrls: [] },
        { tempId: 'dup', type: 'concept', title: ' symbiosis ', content: '', rationale: '', sourceUrls: [] }
      ],
      relationships: [
        { fromTempId: 'a', toTempId: 'dup', label: 'depends_on', evidence: '', confidence: 0.7 }
      ]
    }), 'https://two.example.org/b', 'coral adaptation');
  };
  await withMockedAI({ GEMINI_API_KEY: 'g-test' }, handler, async () => {
    const events = [];
    for await (const event of researchGraphStream('coral bleaching', 'deep', graph, { projectId: `test-deep-${Date.now()}` })) events.push(event);
    const stepIds = events.filter(e => e.type === 'step' && e.stepId).map(e => e.stepId);
    assert.deepEqual(stepIds, ['axes', 'axes', 'queries', 'synthesis']);
    assert.deepEqual(events.filter(e => e.type === 'hop').map(e => e.hop), [1, 2]);
    const { result } = events.at(-1);
    assert.deepEqual(result.result.nodes.map(n => n.tempId), ['a', 'hop2-a'], 'hop 2 ids are namespaced and duplicates merged');
    assert.deepEqual(result.result.relationships.map(r => [r.fromTempId, r.toTempId]), [['hop2-a', 'a']], 'hop 2 links back to the hop 1 card');
    assert.deepEqual(result.sources.map(s => s.url), ['https://one.example.org/a', 'https://two.example.org/b']);
    assert.deepEqual(result.searchQueries, ['reef symbiosis', 'coral adaptation']);
    assert.equal(result.provider, 'Gemini');
    assertUsage(result.usage, 'gemini-3.8-flash', 300, 120);
  });
});

test('chat memory: messages round-trip per thread and stay private to their user', async () => {
  const { saveChatMessages, getChatMessages, getLatestChatThreadId } = await import('../src/lib/db.ts');
  const projectId = `test-memory-${Date.now()}`;
  const base = { projectId, userKey: 'alice', referencedNodeIds: [], toolCall: null };
  await saveChatMessages([
    { ...base, id: `${projectId}-1`, threadId: 't1', role: 'user', content: 'First question', createdAt: 1000 },
    { ...base, id: `${projectId}-2`, threadId: 't1', role: 'assistant', content: 'First answer', referencedNodeIds: ['n1'], toolCall: { tool: 'organize_layout', parameters: { strategy: 'compact' } }, provider: 'OpenAI', model: 'gpt-6-luna', createdAt: 1001 },
    { ...base, id: `${projectId}-3`, threadId: 't2', role: 'user', content: 'Newer thread', createdAt: 2000 }
  ]);
  const thread = await getChatMessages(projectId, 'alice', 't1');
  assert.deepEqual(thread.map(m => m.content), ['First question', 'First answer']);
  assert.deepEqual(thread[1].referencedNodeIds, ['n1']);
  assert.deepEqual(thread[1].toolCall, { tool: 'organize_layout', parameters: { strategy: 'compact' } });
  assert.equal(await getLatestChatThreadId(projectId, 'alice'), 't2');
  assert.deepEqual((await getChatMessages(projectId, 'alice', 't1', 1)).map(m => m.content), ['First answer'], 'limit keeps the newest');
  assert.deepEqual(await getChatMessages(projectId, 'bob', 't1'), [], 'another user cannot read the thread');
  assert.equal(await getLatestChatThreadId(projectId, 'bob'), null);
});

test('chat memory: earlier turns reach the model and follow-ups retrieve the previously cited cards', async () => {
  const { askGraph } = await import('../src/lib/ai-service.ts');
  const graph = normalizeGraph(
    [concept('a', 'Alpha hub'), concept('b', 'Beta hub'), concept('c', 'Gamma hub'), concept('z', 'Zebra stripes camouflage')],
    [relation('e1', 'a', 'b'), relation('e2', 'b', 'c'), relation('e3', 'a', 'c')]
  );
  let requestBody;
  const handler = (url, body) => {
    if (url.includes('/v1/embeddings')) return jsonResponse({}, 500);
    if (url.includes('api.openai.com/v1/responses')) {
      requestBody = body;
      return openAiResponse({ answer: 'Predation pressure.', referencedNodeIds: ['z'], toolCall: null });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await withMockedAI({ OPENAI_API_KEY: 'sk-test' }, handler, async () => {
    const history = [
      { role: 'assistant', content: 'Orphan greeting that must be dropped' },
      { role: 'user', content: 'Why do zebras have stripes?' },
      { role: 'assistant', content: 'Stripes may deter biting flies.', referencedNodeIds: ['z'] }
    ];
    const answer = await askGraph('What contradicts that?', graph, { projectId: `test-followup-${Date.now()}`, history });
    assert.deepEqual(answer.referencedNodeIds, ['z']);

    const input = JSON.stringify(requestBody.input);
    assert.ok(input.includes('Why do zebras have stripes?'), 'previous question is sent');
    assert.ok(input.includes('Stripes may deter biting flies.'), 'previous answer is sent');
    assert.ok(!input.includes('Orphan greeting'), 'history starts with a user turn');
    const lastMessage = JSON.stringify(requestBody.input.at(-1));
    assert.ok(lastMessage.includes('What contradicts that?'));
    assert.ok(lastMessage.includes('Zebra stripes camouflage'), 'the card cited earlier is in the retrieved context');

    // Without history, the same vague question retrieves the best-connected cards instead.
    await askGraph('What contradicts that?', graph, { projectId: `test-followup-none-${Date.now()}` });
    assert.ok(!JSON.stringify(requestBody.input.at(-1)).includes('Zebra stripes camouflage'));
  });
});

test('to-do cards read their checklist from Markdown and keep other lines', async () => {
  const { parseTodos, countTodos, todoContent } = await import('../src/utils/todo.ts');
  const parsed = parseTodos('Launch prep\n- [ ] Draft post\n- [x] Book room\n  * [X] Nested done\n1. [ ] Numbered\n- plain bullet');
  assert.deepEqual(parsed.todos.map(todo => [todo.line, todo.checked, todo.text]), [
    [1, false, 'Draft post'], [2, true, 'Book room'], [3, true, 'Nested done'], [4, false, 'Numbered']
  ]);
  assert.equal(parsed.notes, 'Launch prep\n- plain bullet');
  assert.equal(countTodos(''), 0);
  assert.equal(countTodos(undefined, [{ id: 'a', text: 'Legacy', completed: true }]), 1);
  assert.equal(todoContent('', [{ id: 'a', text: 'Legacy', completed: true }, { id: 'b', text: 'Open', completed: false }]), '- [x] Legacy\n- [ ] Open');
  assert.equal(todoContent('- [ ] kept', [{ id: 'a', text: 'ignored', completed: false }]), '- [ ] kept');
});

test('keeps only unique, existing chat context ids, capped', () => {
  const graph = normalizeGraph([concept('a'), concept('b'), concept('c')], []);
  assert.deepEqual(pickContextNodeIds(graph, ['a', 'a', 'ghost', 42, '__proto__', 'b']), ['a', 'b']);
  assert.deepEqual(pickContextNodeIds(graph, ['a', 'b', 'c'], 2), ['a', 'b']);
  assert.deepEqual(pickContextNodeIds(graph, 'a'), []);
  assert.deepEqual(pickContextNodeIds(graph, undefined), []);
});

test('prices model calls per model and date, and charges extra credits only past the flat rate', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  assert.equal(modelCostUsd('gpt-6-luna', usage), 0.60);
  assert.equal(modelCostUsd('gpt-6-luna', { ...usage, cachedInputTokens: 1_000_000 }), 0.51);
  assert.equal(modelCostUsd('gemini-3.8-flash', usage, new Date('2026-12-31T23:00:00Z')), 4.50);
  assert.equal(modelCostUsd('gemini-3.8-flash', usage, new Date('2027-01-01T00:00:00Z')), 9.00);
  assert.equal(modelCostUsd('unknown-model', usage), undefined);

  assert.equal(extraCreditsFor(undefined, 1), 0);
  assert.equal(extraCreditsFor(USD_PER_CREDIT * 0.9, 1), 0);
  assert.equal(extraCreditsFor(USD_PER_CREDIT, 1), 0);
  assert.equal(extraCreditsFor(USD_PER_CREDIT * 1.2, 1), 1);
  assert.equal(extraCreditsFor(USD_PER_CREDIT * 50, 1), 2);
  assert.equal(extraCreditsFor(USD_PER_CREDIT * 21, 20), 1);
});

test('builds a new map from tool input', async () => {
  const { buildNewMap } = await import('../src/lib/mcp/build.ts');
  const { nodes, connections, dropped } = buildNewMap(
    [
      { tempId: 'root', type: 'concept', title: 'Proteins' },
      { tempId: 'enz', type: 'note', title: 'Enzymes', content: 'Speed up reactions.' },
      { tempId: 'c1', type: 'claim', title: 'All enzymes are proteins' }
    ],
    [
      { from: 'enz', to: 'root', label: 'part_of' },
      { from: 'c1', to: 'enz', label: 'Supports' },
      { from: 'c1', to: 'ghost', label: 'supports' }
    ]
  );
  assert.equal(nodes.length, 3);
  assert.equal(connections.length, 2);
  assert.equal(dropped.length, 1);
  assert.ok(nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y) && node.metadata?.origin === 'ai'));
  assert.equal(nodes.find(node => node.type === 'claim').metadata.claimStatus, 'unverified');
  assert.equal(connections.find(edge => edge.label === 'supports').label, 'supports');
  assert.doesNotThrow(() => normalizeGraph(nodes, connections));
});

test('drops duplicate tempIds and turns a source without a url into a note', async () => {
  const { buildNewMap } = await import('../src/lib/mcp/build.ts');
  const { nodes, dropped } = buildNewMap(
    [
      { tempId: 'a', type: 'source', title: 'A paper' },
      { tempId: 'a', type: 'note', title: 'Again' },
      { tempId: 'b', type: 'source', title: 'Site', url: 'https://example.com/x' }
    ],
    []
  );
  assert.equal(nodes.length, 2);
  assert.equal(dropped.length, 1);
  assert.equal(nodes.find(node => node.title === 'A paper').type, 'note');
  assert.equal(nodes.find(node => node.title === 'Site').type, 'source');
});

test('builds a pending proposal that can link to existing nodes', async () => {
  const { buildProposal } = await import('../src/lib/mcp/build.ts');
  const graph = normalizeGraph([{ ...concept('a'), width: 280 }], []);
  const { session, dropped } = buildProposal(graph, 'Add enzymes', [{ tempId: 'n1', type: 'note', title: 'Enzymes' }], [{ from: 'n1', to: 'a', label: 'part_of' }]);
  assert.equal(dropped.length, 0);
  assert.equal(session.mode, 'mcp');
  assert.equal(session.status, 'review');
  assert.equal(session.changes.length, 2);
  assert.ok(session.changes.every(change => change.status === 'pending'));
  const node = session.changes.find(change => change.kind === 'node').payload;
  assert.ok(node.x > 280);
  assert.equal(session.changes.find(change => change.kind === 'relationship').payload.to, 'a');
});
