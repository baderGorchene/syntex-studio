/**
 * Server-side AI entry point used by the API routes.
 * Chat lives in ai-chat.ts and research in ai-research.ts, both on the Vercel AI SDK;
 * provider selection and fallback live in ai-providers.ts.
 */
import type { CanvasNode } from '../types/canvas';
import { syncGraphVectors } from './rag/vector-store.ts';
import { EMBEDDING_DIMENSION, GEMINI_EMBEDDING_MODEL, OPENAI_EMBEDDING_MODEL } from './rag/embeddings.ts';
import { GEMINI_MODEL, OPENAI_MODEL, geminiKey, openAiKey, providerPlan, type ProviderName } from './ai-providers.ts';

export { askGraph, askGraphStream, sanitizeToolCall } from './ai-chat.ts';
export type { GraphAnswer, ChatStreamEvent, ChatOptions } from './ai-chat.ts';
export { researchGraph, researchGraphStream } from './ai-research.ts';
export type { ResearchGeneration, ResearchResultPayload, ResearchStreamEvent, ResearchOptions } from './ai-research.ts';

export interface AIStatus {
  configured: boolean;
  activeProvider: ProviderName | 'None';
  activeModel: string;
  reasoningEffort: 'medium';
  embeddingModel: string;
  embeddingDimension: number;
  fallbackConfigured: boolean;
  fallbackProvider: ProviderName | null;
  fallbackModel: string | null;
  usingFallback: boolean;
  /** The desktop app runs without AI: keys stay on the cloud server. */
  desktop?: boolean;
  providers: {
    openai: { configured: boolean; model: string; embeddings: string };
    gemini: { configured: boolean; model: string; embeddings: string };
  };
}

export function getAIStatus(): AIStatus {
  const hasOpenAI = Boolean(openAiKey());
  const hasGemini = Boolean(geminiKey());

  const openaiInfo = {
    configured: hasOpenAI,
    model: OPENAI_MODEL,
    embeddings: `${OPENAI_EMBEDDING_MODEL} (${EMBEDDING_DIMENSION}d)`
  };
  const geminiInfo = {
    configured: hasGemini,
    model: GEMINI_MODEL,
    embeddings: `${GEMINI_EMBEDDING_MODEL} (${EMBEDDING_DIMENSION}d)`
  };
  const providers = { openai: openaiInfo, gemini: geminiInfo };

  const desktop = process.env.SYNTHEX_DESKTOP === '1';
  if (desktop || (!hasOpenAI && !hasGemini)) {
    return {
      ...(desktop ? { desktop: true } : {}),
      configured: false,
      activeProvider: 'None',
      activeModel: 'None',
      reasoningEffort: 'medium',
      embeddingModel: 'None (keyword search only)',
      embeddingDimension: EMBEDDING_DIMENSION,
      fallbackConfigured: false,
      fallbackProvider: null,
      fallbackModel: null,
      usingFallback: false,
      providers
    };
  }

  const [active, fallback] = providerPlan();
  const info = (p: ProviderName) => (p === 'OpenAI' ? openaiInfo : geminiInfo);
  return {
    configured: true,
    activeProvider: active.provider,
    activeModel: info(active.provider).model,
    reasoningEffort: 'medium',
    // New documents are embedded by the first configured provider (OpenAI, then Gemini).
    embeddingModel: hasOpenAI ? openaiInfo.embeddings : geminiInfo.embeddings,
    embeddingDimension: EMBEDDING_DIMENSION,
    fallbackConfigured: Boolean(fallback),
    fallbackProvider: fallback?.provider ?? null,
    fallbackModel: fallback ? info(fallback.provider).model : null,
    usingFallback: active.usedFallback,
    providers
  };
}

/**
 * Background helper to update node embeddings and the keyword search index
 */
export function indexGraphNodes(projectId: string, nodes: CanvasNode[]) {
  syncGraphVectors(projectId, nodes).catch(err => {
    console.warn(`Search indexing error for project "${projectId}":`, err instanceof Error ? err.message : err);
  });
}
