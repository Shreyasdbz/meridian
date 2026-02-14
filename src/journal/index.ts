// @meridian/journal — public API

// Phase 10.1: Memory Storage & Retrieval
export { MemoryStore } from './memory-store.js';
export type {
  MemoryStoreOptions,
  MemoryStoreLogger,
  Episode,
  Fact,
  Procedure,
  Memory,
  CreateEpisodeOptions,
  CreateFactOptions,
  CreateProcedureOptions,
  UpdateEpisodeOptions,
  UpdateFactOptions,
  UpdateProcedureOptions,
  ListOptions,
  StagedMemory,
  CreateStagedMemoryOptions,
  MemoryExport,
} from './memory-store.js';

export {
  OllamaEmbeddingProvider,
  ApiEmbeddingProvider,
  MockEmbeddingProvider,
  EmbeddingStore,
  cosineSimilarity,
} from './embeddings.js';
export type {
  EmbeddingProvider,
  OllamaEmbeddingConfig,
  ApiEmbeddingConfig,
  EmbeddingStoreOptions,
  EmbeddingStoreLogger,
  EmbeddingSearchResult,
} from './embeddings.js';

export { HybridRetrieval, reciprocalRankFusion, sanitizeFtsQuery } from './retrieval.js';
export type {
  HybridRetrievalOptions,
  RetrievalLogger,
} from './retrieval.js';

// Phase 10.2: Reflection Pipeline
export { Reflector, shouldReflect, reducePii, reducePiiRegex, classifyContent } from './reflector.js';
export type {
  ReflectorConfig,
  ReflectorLogger,
  ReflectionInput,
  ReflectionResult,
  GearBrief,
} from './reflector.js';

export { MemoryWriter, extractKeywords } from './memory-writer.js';
export type {
  MemoryWriterOptions,
  MemoryWriterLogger,
  WriteResult,
} from './memory-writer.js';

export { GearSuggester, isValidBrief } from './gear-suggester.js';
export type {
  GearSuggesterOptions,
  GearSuggesterLogger,
  SavedGearBrief,
} from './gear-suggester.js';
