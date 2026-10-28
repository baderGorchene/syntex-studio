import { randomUUID } from 'node:crypto';
import { researchGraph, researchGraphStream } from '@/lib/ai-service';
import {
  getAllConnectionsFromDb,
  getAllNodesFromDb,
  getResearchSessions,
  saveResearchSession,
  userHasProjectAccess
} from '@/lib/db';
import { normalizeGraph, strokeForLabel } from '@/lib/graph';
import { getServerAuth } from '@/lib/auth';
import { chargeExtraForUsage, deductCredits, extraCreditsNotice, refundCredits } from '@/lib/credits';
import { RESEARCH_INPUT_LIMITS, RESEARCH_MODE_LABELS, type CanvasNode, type Connection, type ResearchChange, type ResearchMode, type ResearchSession } from '@/types/canvas';
import type { MeteredAction } from '@/lib/plans';
import { EDGE_LABELS } from '@/lib/mcp/build';

const MODES: Record<ResearchMode, { credit: MeteredAction; maxNodes: number; maxEdges: number; trail: string }> = {
  quick: { credit: 'quick_research', maxNodes: 6, maxEdges: 12, trail: 'Quick Single-Shot Research' },
  deep: { credit: 'deep_research', maxNodes: 14, maxEdges: 18, trail: 'Recursive Multi-Step Deep Research (Multi-Hop Grounding)' },
  organize: { credit: 'organize_thinking', maxNodes: 16, maxEdges: 24, trail: 'Organize thinking: the user\'s own notes sorted into a map, no web search' },
  check: { credit: 'check_plan', maxNodes: 22, maxEdges: 32, trail: 'Plan check: notes organized, then searched for outdated information and better alternatives' }
};

function isResearchMode(value: unknown): value is ResearchMode {
  return typeof value === 'string' && Object.hasOwn(MODES, value);
}

const nodeTypes = new Set(['concept', 'note', 'claim', 'question', 'hypothesis', 'ai_insight']);
const edgeLabels = new Set(EDGE_LABELS);

function buildSessionFromResearchResult(
  query: string,
  mode: ResearchMode,
  graph: ReturnType<typeof normalizeGraph>,
  resultPayload: {
    result: { summary: string; subquestions: string[]; nodes: Array<{ tempId: string; type: string; title: string; content?: string; rationale?: string }>; relationships: Array<{ fromTempId: string; toTempId: string; label: string; evidence?: string; confidence?: number }> };
    sources: Array<{ title: string; url: string }>;
    searchQueries: string[];
    provider: string;
    model: string;
    usedFallback: boolean;
    groundingNote?: string;
  }
): ResearchSession {
  const { result, sources, searchQueries, provider, model, usedFallback, groundingNote } = resultPayload;
  const existingSourceUrls = new Set(Object.values(graph.nodesById).map(node => node.url).filter(Boolean));
  const idByTempId = new Map<string, string>();
  const changes: ResearchChange[] = [];
  const baseX = Math.max(200, ...Object.values(graph.nodesById).map(node => node.x + (node.width || 280))) + 120;
  const baseY = Math.min(220, ...Object.values(graph.nodesById).map(node => node.y));

  for (const [index, item] of result.nodes.slice(0, MODES[mode].maxNodes).entries()) {
    if (!item || !nodeTypes.has(item.type) || typeof item.tempId !== 'string' || typeof item.title !== 'string') continue;
    const id = `research-${randomUUID()}`;
    idByTempId.set(item.tempId, id);
    const type = item.type as CanvasNode['type'];
    const node: CanvasNode = {
      id, type,
      x: baseX + (index % 3) * 330,
      y: baseY + Math.floor(index / 3) * 245,
      width: type === 'question' ? 300 : 280,
      color: type === 'question' ? 'terracotta' : type === 'claim' ? 'neutral' : 'cobalt',
      title: item.title.trim().slice(0, 500),
      content: String(item.content || '').slice(0, 12000),
      createdAt: Date.now(),
      metadata: {
        origin: 'ai',
        ...(type === 'claim' ? { claimStatus: 'unverified' as const } : {}),
        rationale: String(item.rationale || '').slice(0, 2000)
      }
    };
    if (node.title) changes.push({ id: randomUUID(), kind: 'node', payload: node, status: 'pending', rationale: node.metadata?.rationale });
  }

  const sourceNodes: CanvasNode[] = sources
    .filter(source => !existingSourceUrls.has(source.url))
    .map((source, index) => ({
      id: `research-${randomUUID()}`,
      type: 'source',
      x: baseX + (index % 3) * 330,
      y: baseY + 260 + Math.floor(index / 3) * 245,
      width: 280,
      color: 'sage',
      title: source.title.slice(0, 300),
      url: source.url,
      domain: (() => { try { return new URL(source.url).hostname; } catch { return ''; } })(),
      description: 'Discovered through grounded search. Review before using as evidence.',
      createdAt: Date.now(),
      metadata: { origin: 'ai', rationale: 'Discovered during this research run; not yet linked to a claim.' }
    }));
  for (const source of sourceNodes) changes.push({
    id: randomUUID(), kind: 'node', payload: source, status: 'pending', rationale: source.metadata?.rationale
  });

  const newNodeIds = new Set([...idByTempId.values()]);
  const newEdges: Connection[] = result.relationships.slice(0, MODES[mode].maxEdges).flatMap(item => {
    const from = idByTempId.get(item.fromTempId);
    const to = idByTempId.get(item.toTempId);
    if (!from || !to || !newNodeIds.has(from) || !newNodeIds.has(to) || from === to) return [];
    const proposedLabel = item.label.trim().toLowerCase().replace(/\s+/g, '_');
    const label = edgeLabels.has(proposedLabel) ? proposedLabel : 'related_to';
    const edge: Connection = {
      id: `research-edge-${randomUUID()}`,
      from, to, label,
      color: 'neutral',
      arrowhead: 'end',
      lineStyle: 'curved',
      strokePattern: strokeForLabel(label),
      animated: false,
      metadata: {
        origin: 'ai',
        confidence: typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : undefined,
        evidence: String(item.evidence || '').slice(0, 2000)
      }
    };
    return [edge];
  });
  for (const edge of newEdges) changes.push({
    id: randomUUID(), kind: 'relationship', payload: edge, status: 'pending', rationale: edge.metadata?.evidence
  });

  return {
    id: randomUUID(), query, mode, status: 'review',
    summary: result.summary.slice(0, 6000),
    trail: [
      `Engine: ${provider} · ${model}${usedFallback ? ' (Automatic Fallback Triggered)' : ''}`,
      `Research Mode: ${MODES[mode].trail}`,
      `${mode === 'organize' || mode === 'check' ? 'Notes' : 'Research question'}: ${query.length > 300 ? `${query.slice(0, 300)}…` : query}`,
      ...searchQueries.map(text => `Search: ${text.slice(0, 500)}`),
      `Grounded sources discovered: ${sources.length}`,
      ...(groundingNote ? [groundingNote] : []),
      `Staged ${changes.filter(c => c.kind === 'node').length} nodes and ${changes.filter(c => c.kind === 'relationship').length} relationships for human review`,
      'Generated knowledge is unverified and remains pending until reviewed.'
    ],
    changes,
    createdAt: Date.now()
  };
}

export async function GET(request: Request) {
  try {
    const auth = await getServerAuth();
    const userId = auth.user?.id || auth.userId;
    const orgId = auth.orgId;
    const clerkId = auth.clerkId;
    if (!auth.isLocal && !userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const projectId = new URL(request.url).searchParams.get('projectId') || '';
    if (!projectId || projectId.length > 80 || !(await userHasProjectAccess(projectId, userId, orgId, clerkId))) {
      return Response.json({ error: 'Project not found.' }, { status: 404 });
    }
    const sessions = await getResearchSessions(projectId);
    return Response.json({ sessions });
  } catch (error) {
    console.error('Failed to load research history:', error);
    return Response.json({ error: 'Could not load research history.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await getServerAuth();
    const userId = auth.user?.id || auth.userId;
    const orgId = auth.orgId;
    const clerkId = auth.clerkId;
    if (!auth.isLocal && !userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const length = Number(request.headers.get('content-length') || 0);
    if (length > 20_000) return Response.json({ error: 'Research request is too large.' }, { status: 413 });
    const body = await request.json();
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    if (!isResearchMode(body?.mode)) return Response.json({ error: 'Choose quick, deep, organize or check.' }, { status: 400 });
    const mode: ResearchMode = body.mode;
    const maxLength = RESEARCH_INPUT_LIMITS[mode];
    if (!query || query.length > maxLength) {
      return Response.json({ error: mode === 'organize' || mode === 'check'
        ? `Keep your notes under ${maxLength.toLocaleString('en-US')} characters.`
        : `Enter a research question under ${maxLength} characters.` }, { status: 400 });
    }
    if (!projectId || projectId.length > 80 || !(await userHasProjectAccess(projectId, userId, orgId, clerkId))) {
      return Response.json({ error: 'Project not found.' }, { status: 404 });
    }

    const [rawNodes, rawEdges] = await Promise.all([
      getAllNodesFromDb(projectId),
      getAllConnectionsFromDb(projectId)
    ]);
    const graph = normalizeGraph(rawNodes as CanvasNode[], rawEdges as Connection[]);

    // Charge Context Credits up front (atomic), refund if the run fails.
    const creditAction = MODES[mode].credit;
    const creditNote = `${RESEARCH_MODE_LABELS[mode]}: "${query.slice(0, 50)}..."`;
    let creditsRemaining: number | undefined;
    if (userId) {
      const charge = await deductCredits(userId, creditAction, creditNote);
      if (!charge.success) {
        return Response.json({
          error: 'INSUFFICIENT_CREDITS',
          message: charge.error || `Insufficient Context Credits for ${RESEARCH_MODE_LABELS[mode].toLowerCase()}. Please top up to continue.`,
          requiredCredits: charge.cost,
          currentBalance: charge.balance
        }, { status: 402 });
      }
      creditsRemaining = charge.balance;
    }
    const refund = async () => { if (userId) await refundCredits(userId, creditAction, `Refund: ${creditNote}`); };
    // A run whose real model cost ran past its flat rate pays the difference, and the user is told.
    const chargeExtra = async (costUsd: number | undefined) => {
      if (!userId) return {};
      const extra = await chargeExtraForUsage(userId, creditAction, costUsd, creditNote).catch(err => {
        console.error('Extra credit charge failed:', err);
        return { extraCredits: 0, balance: undefined };
      });
      if (extra.balance !== undefined) creditsRemaining = extra.balance;
      return extra.extraCredits ? { extraCredits: extra.extraCredits, creditNotice: extraCreditsNotice(extra.extraCredits, creditAction) } : {};
    };

    const wantsStream = request.headers.get('accept')?.includes('text/event-stream') || body?.stream === true;

    if (wantsStream) {
      const encoder = new TextEncoder();
      // The run is not aborted when the client disconnects: the finished session is saved
      // to research history, so the user can still open what they paid for.
      let open = true;
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: string, data: unknown) => {
            if (open) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          try {
            for await (const event of researchGraphStream(query, mode, graph, { projectId })) {
              if (event.type === 'done') {
                const session = buildSessionFromResearchResult(query, mode, graph, event.result);
                await saveResearchSession(session, projectId);
                const extra = await chargeExtra(event.result.usage?.costUsd);
                send('done', { session, result: event.result, creditsRemaining, ...extra });
              } else {
                send(event.type, event);
              }
            }
          } catch (err) {
            console.error('Research stream failed:', err);
            await refund().catch(refundErr => console.error('Credit refund failed:', refundErr));
            const errorMsg = err instanceof Error && err.message === 'AI_NOT_CONFIGURED'
              ? 'AI is not configured on the server.'
              : 'Research run could not complete. Your credits were refunded.';
            send('error', { error: errorMsg });
          } finally {
            if (open) {
              open = false;
              controller.close();
            }
          }
        },
        cancel() {
          open = false;
        }
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive'
        }
      });
    }

    let session: ResearchSession;
    let costUsd: number | undefined;
    try {
      const resultPayload = await researchGraph(query, mode, graph, { projectId });
      costUsd = resultPayload.usage?.costUsd;
      session = buildSessionFromResearchResult(query, mode, graph, resultPayload);
      await saveResearchSession(session, projectId);
    } catch (err) {
      await refund().catch(refundErr => console.error('Credit refund failed:', refundErr));
      throw err;
    }

    const extra = await chargeExtra(costUsd);
    return Response.json({ session, creditsRemaining, ...extra }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'AI_NOT_CONFIGURED') {
      return Response.json({ error: 'Add OPENAI_API_KEY or GEMINI_API_KEY to the server environment to enable research.' }, { status: 503 });
    }
    console.error('Research run failed:', error);
    return Response.json({ error: 'Research could not complete. Try again.' }, { status: 502 });
  }
}

