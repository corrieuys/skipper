/**
 * Curated GGUF embedding models the managed local server can run. Small,
 * permissively licensed, and all served by llama.cpp's `/v1/embeddings`.
 *
 * `pooling` is passed to llama-server explicitly rather than trusting the GGUF
 * metadata (older conversions omit it). `ctx` is the token window the server is
 * started with, and `docMaxChars` is how much of a document is embedded so a
 * long note never exceeds it (roughly 4 chars per token, with headroom).
 * `queryPrefix`/`docPrefix` are the instruction prefixes some models were
 * trained with (nomic); empty for the others.
 */
export interface LocalEmbeddingModel {
  id: string;
  label: string;
  file: string;
  url: string;
  bytes: number;
  dims: number;
  pooling: "mean" | "cls";
  ctx: number;
  docMaxChars: number;
  queryPrefix: string;
  docPrefix: string;
}

export const LOCAL_EMBEDDING_MODELS: LocalEmbeddingModel[] = [
  {
    id: "bge-small-en-v1.5",
    label: "BGE small en v1.5 (37 MB, 384 dims)",
    file: "bge-small-en-v1.5-q8_0.gguf",
    url: "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf",
    bytes: 36_806_944,
    dims: 384,
    pooling: "cls",
    ctx: 512,
    docMaxChars: 1200,
    queryPrefix: "",
    docPrefix: "",
  },
  {
    id: "all-minilm-l6-v2",
    label: "all-MiniLM-L6-v2 (25 MB, 384 dims)",
    file: "all-MiniLM-L6-v2-Q8_0.gguf",
    url: "https://huggingface.co/second-state/All-MiniLM-L6-v2-Embedding-GGUF/resolve/main/all-MiniLM-L6-v2-Q8_0.gguf",
    bytes: 25_008_064,
    dims: 384,
    pooling: "mean",
    ctx: 512,
    docMaxChars: 1200,
    queryPrefix: "",
    docPrefix: "",
  },
  {
    id: "bge-base-en-v1.5",
    label: "BGE base en v1.5 (118 MB, 768 dims)",
    file: "bge-base-en-v1.5-q8_0.gguf",
    url: "https://huggingface.co/CompendiumLabs/bge-base-en-v1.5-gguf/resolve/main/bge-base-en-v1.5-q8_0.gguf",
    bytes: 117_974_304,
    dims: 768,
    pooling: "cls",
    ctx: 512,
    docMaxChars: 1200,
    queryPrefix: "",
    docPrefix: "",
  },
  {
    id: "nomic-embed-text-v1.5",
    label: "Nomic embed text v1.5 (146 MB, 768 dims, long inputs)",
    file: "nomic-embed-text-v1.5.Q8_0.gguf",
    url: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf",
    bytes: 146_146_432,
    dims: 768,
    pooling: "mean",
    ctx: 2048,
    docMaxChars: 6000,
    queryPrefix: "search_query: ",
    docPrefix: "search_document: ",
  },
];

export const DEFAULT_LOCAL_EMBEDDING_MODEL_ID = "bge-small-en-v1.5";

export function findLocalEmbeddingModel(id: string): LocalEmbeddingModel | null {
  return LOCAL_EMBEDDING_MODELS.find((m) => m.id === id) ?? null;
}
