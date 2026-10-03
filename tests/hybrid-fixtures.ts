/** Deliberate synthetic geometry, not a learned model or a quality benchmark. */
export function syntheticEmbeddings(
  vectors: Record<string, number[]> = {},
  config: { baseUrl?: string; modelId?: string; dimensions?: number } = {},
) {
  const dimensions = config.dimensions ?? 4;
  const provider = {
    config: {
      baseUrl: config.baseUrl ?? 'http://synthetic-embedding.invalid/v1/',
      modelId: config.modelId ?? 'synthetic-context-v1',
      dimensions,
    },
    calls: [] as string[][],
    fail: false,
    beforeEmbed: undefined as undefined | (() => Promise<void>),
    async embed(texts: string[]) {
      provider.calls.push([...texts]);
      if (provider.beforeEmbed) await provider.beforeEmbed();
      if (provider.fail) throw new Error('Synthetic provider unavailable');
      const fallback = Array<number>(dimensions).fill(0);
      fallback[dimensions - 1] = 1;
      return {
        vectors: texts.map(text => [...(vectors[text] ?? fallback)]),
        dimensions,
        model: provider.config.modelId,
      };
    },
  };
  return provider;
}
