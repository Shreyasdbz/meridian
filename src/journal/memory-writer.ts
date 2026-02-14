// @meridian/journal — MemoryWriter: writes reflection results to stores (Phase 10.2)
//
// Takes ReflectionResult from the Reflector and persists it:
// 1. Creates an episode (always)
// 2. Stages facts and procedures for 24-hour review
// 3. Detects contradictions with existing facts (reduces confidence)
// 4. Optionally creates embeddings for the episode
//
// All new semantic/procedural memories go through staging first.

import type { FactCategory, ProcedureCategory } from '@meridian/shared';

import type { EmbeddingProvider, EmbeddingStore } from './embeddings.js';
import type { MemoryStore } from './memory-store.js';
import type { ReflectionResult } from './reflector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryWriterOptions {
  memoryStore: MemoryStore;
  embeddingStore?: EmbeddingStore;
  embeddingProvider?: EmbeddingProvider;
  logger?: MemoryWriterLogger;
}

export interface MemoryWriterLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export interface WriteResult {
  episodeId: string;
  stagedFacts: number;
  stagedProcedures: number;
  contradictionsFound: number;
  embeddingCreated: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTRADICTION_CONFIDENCE_REDUCTION = 0.2;
const MIN_CONTRADICTION_SIMILARITY = 3; // min shared words for keyword match

// ---------------------------------------------------------------------------
// No-op logger
// ---------------------------------------------------------------------------

const noopLogger: MemoryWriterLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// MemoryWriter
// ---------------------------------------------------------------------------

export class MemoryWriter {
  private readonly memoryStore: MemoryStore;
  private readonly embeddingStore?: EmbeddingStore;
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly logger: MemoryWriterLogger;

  constructor(options: MemoryWriterOptions) {
    this.memoryStore = options.memoryStore;
    this.embeddingStore = options.embeddingStore;
    this.embeddingProvider = options.embeddingProvider;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Write reflection results to memory stores.
   * Creates episode, stages facts/procedures, detects contradictions.
   */
  async write(
    reflection: ReflectionResult,
    jobId?: string,
  ): Promise<WriteResult> {
    const result: WriteResult = {
      episodeId: '',
      stagedFacts: 0,
      stagedProcedures: 0,
      contradictionsFound: 0,
      embeddingCreated: false,
    };

    // 1. Create episode (always)
    const episode = await this.memoryStore.createEpisode({
      content: this.buildEpisodeContent(reflection),
      summary: reflection.episode.summary,
      jobId,
    });
    result.episodeId = episode.id;

    this.logger.info('Episode created from reflection', {
      episodeId: episode.id,
      outcome: reflection.episode.outcome,
    });

    // 2. Stage facts (24-hour review period)
    for (const fact of reflection.facts) {
      await this.memoryStore.createStagedMemory({
        memoryType: 'semantic',
        content: fact.content,
        category: fact.category,
        confidence: fact.confidence,
        sourceEpisodeId: episode.id,
        jobId,
      });
      result.stagedFacts++;
    }

    // 3. Stage procedures
    for (const proc of reflection.procedures) {
      await this.memoryStore.createStagedMemory({
        memoryType: 'procedural',
        content: proc.content,
        category: proc.category,
        sourceEpisodeId: episode.id,
        jobId,
      });
      result.stagedProcedures++;
    }

    // 4. Detect and handle contradictions
    for (const contradiction of reflection.contradictions) {
      const handled = await this.handleContradiction(contradiction);
      if (handled) {
        result.contradictionsFound++;
      }
    }

    // 5. Create embedding for the episode (if provider available)
    if (this.embeddingProvider && this.embeddingStore) {
      try {
        const embedding = await this.embeddingProvider.embed(
          `${reflection.episode.summary} ${reflection.episode.outcome}`,
        );
        await this.embeddingStore.store(episode.id, 'episodic', embedding);
        result.embeddingCreated = true;
      } catch (error) {
        this.logger.warn('Failed to create episode embedding', {
          episodeId: episode.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.info('Reflection write complete', {
      episodeId: result.episodeId,
      stagedFacts: result.stagedFacts,
      stagedProcedures: result.stagedProcedures,
      contradictionsFound: result.contradictionsFound,
    });

    return result;
  }

  /**
   * Promote a staged memory to its final table.
   * Called by IdleMaintenance after the 24-hour staging period.
   */
  async promoteStagedMemory(stagedId: string): Promise<void> {
    const staged = await this.memoryStore.getStagedMemory(stagedId);
    if (!staged) {
      this.logger.warn('Staged memory not found for promotion', { stagedId });
      return;
    }

    if (staged.promotedAt || staged.rejectedAt) {
      this.logger.debug('Staged memory already processed', { stagedId });
      return;
    }

    if (staged.memoryType === 'semantic') {
      const fact = await this.memoryStore.createFact({
        category: (staged.category as FactCategory | undefined) ?? 'knowledge',
        content: staged.content,
        confidence: staged.confidence ?? 0.7,
        sourceEpisodeId: staged.sourceEpisodeId,
      });

      // Create embedding for the promoted fact
      if (this.embeddingProvider && this.embeddingStore) {
        try {
          const embedding = await this.embeddingProvider.embed(staged.content);
          await this.embeddingStore.store(fact.id, 'semantic', embedding);
        } catch (error) {
          this.logger.warn('Failed to create fact embedding', {
            factId: fact.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.logger.info('Fact promoted from staging', { factId: fact.id, stagedId });
    } else if (staged.memoryType === 'procedural') {
      const proc = await this.memoryStore.createProcedure({
        category: (staged.category as ProcedureCategory | undefined) ?? 'pattern',
        content: staged.content,
        sourceEpisodeId: staged.sourceEpisodeId,
      });

      // Create embedding for the promoted procedure
      if (this.embeddingProvider && this.embeddingStore) {
        try {
          const embedding = await this.embeddingProvider.embed(staged.content);
          await this.embeddingStore.store(proc.id, 'procedural', embedding);
        } catch (error) {
          this.logger.warn('Failed to create procedure embedding', {
            procedureId: proc.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.logger.info('Procedure promoted from staging', {
        procedureId: proc.id,
        stagedId,
      });
    }

    await this.memoryStore.markStagedMemoryPromoted(stagedId);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildEpisodeContent(reflection: ReflectionResult): string {
    const parts: string[] = [];

    parts.push(`Outcome: ${reflection.episode.outcome}`);
    parts.push(`Summary: ${reflection.episode.summary}`);

    if (reflection.facts.length > 0) {
      parts.push(`\nFacts discovered: ${reflection.facts.length}`);
      for (const fact of reflection.facts) {
        parts.push(`- [${fact.category}] ${fact.content} (confidence: ${fact.confidence})`);
      }
    }

    if (reflection.procedures.length > 0) {
      parts.push(`\nProcedures learned: ${reflection.procedures.length}`);
      for (const proc of reflection.procedures) {
        parts.push(`- [${proc.category}] ${proc.content}`);
      }
    }

    if (reflection.contradictions.length > 0) {
      parts.push(`\nContradictions: ${reflection.contradictions.length}`);
      for (const c of reflection.contradictions) {
        parts.push(`- Existing: ${c.existingFact}`);
        parts.push(`  New: ${c.newEvidence}`);
        parts.push(`  Resolution: ${c.suggestedResolution}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Handle a contradiction by finding matching facts and reducing confidence.
   * Returns true if a contradiction was actually resolved.
   */
  private async handleContradiction(contradiction: {
    existingFact: string;
    newEvidence: string;
    suggestedResolution: string;
  }): Promise<boolean> {
    // Find existing facts that match the contradiction's existingFact description
    const keywords = extractKeywords(contradiction.existingFact);
    if (keywords.length === 0) {
      return false;
    }

    // Search for matching facts
    const matchingFacts = await this.memoryStore.findFactsByContent(keywords[0] ?? '');
    if (matchingFacts.length === 0) {
      return false;
    }

    // Find the best match by keyword overlap
    let bestMatch = matchingFacts[0];
    if (!bestMatch) return false;
    let bestScore = 0;

    for (const fact of matchingFacts) {
      const factKeywords = extractKeywords(fact.content);
      const overlap = keywords.filter((k) => factKeywords.includes(k)).length;
      if (overlap > bestScore) {
        bestScore = overlap;
        bestMatch = fact;
      }
    }

    if (bestScore < MIN_CONTRADICTION_SIMILARITY) {
      this.logger.debug('No strong fact match for contradiction', {
        existingFact: contradiction.existingFact.slice(0, 100),
        bestScore,
      });
      return false;
    }

    // Reduce confidence of the contradicted fact
    const newConfidence = Math.max(0, bestMatch.confidence - CONTRADICTION_CONFIDENCE_REDUCTION);
    await this.memoryStore.updateFact(bestMatch.id, {
      confidence: newConfidence,
    });

    this.logger.info('Contradiction resolved: reduced fact confidence', {
      factId: bestMatch.id,
      oldConfidence: bestMatch.confidence,
      newConfidence,
      contradiction: contradiction.existingFact.slice(0, 100),
    });

    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract significant keywords from text for contradiction matching.
 * Strips common stop words and short tokens.
 */
export function extractKeywords(text: string): string[] {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'that',
    'this', 'it', 'its', 'and', 'or', 'but', 'not', 'no', 'so', 'if',
    'then', 'than', 'very', 'just', 'also', 'only',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}
