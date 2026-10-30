declare module 'subset-font' {
  /**
   * The font cut down to `text`'s characters (harfbuzz, in WebAssembly).
   * Variation axes are kept unless `variationAxes` pins them.
   */
  export default function subsetFont(
    font: Uint8Array,
    text: string,
    options?: {
      noLayoutClosure?: boolean;
      preserveNameIds?: ReadonlyArray<number>;
      targetFormat?: 'sfnt' | 'truetype' | 'woff' | 'woff2';
      variationAxes?: Record<string, number | { default?: number; max: number; min: number }>;
    },
  ): Promise<Uint8Array>;
}
