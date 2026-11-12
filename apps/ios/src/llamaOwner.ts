/**
 * One llama.cpp context at a time in the app: a loaded model holds
 * gigabytes, and two would not fit an iPhone's per-app limit. The holder
 * says how to let it go. The Model Spike page takes the runtime over and
 * lets the Assistant's model go; the Assistant takes it only when no
 * measurement holds it.
 */
export type LlamaHolder = 'assistant' | 'spike';

let holder: { readonly name: LlamaHolder; readonly release: () => Promise<void> } | undefined;

/** Takes the runtime for `name`, letting another holder go first; false where the Assistant would evict a measurement. */
export const takeLlama = async (
  name: LlamaHolder,
  release: () => Promise<void>,
): Promise<boolean> => {
  if (holder !== undefined && holder.name !== name) {
    if (name === 'assistant') {
      return false;
    }
    const previous = holder;
    holder = undefined;
    await previous.release().catch(() => undefined);
  }
  holder = { name, release };
  return true;
};

/** `name` has let go of its context. */
export const letGoLlama = (name: LlamaHolder): void => {
  if (holder?.name === name) {
    holder = undefined;
  }
};

/** Who holds the runtime now. */
export const llamaHolder = (): LlamaHolder | undefined => holder?.name;
