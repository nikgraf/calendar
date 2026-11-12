/**
 * One llama.cpp context at a time in the app: a loaded model holds
 * gigabytes, and two would not fit an iPhone's per-app limit. The holder
 * says how to let it go, and whether it did: the Assistant's model always
 * lets go; the Model Spike page lets go of a model that sits loaded, not
 * of one that is loading or being measured.
 */
export type LlamaHolder = 'assistant' | 'spike';

let holder: { readonly name: LlamaHolder; readonly release: () => Promise<boolean> } | undefined;

/** Takes the runtime for `name`, asking another holder to let go first; false where it would not. */
export const takeLlama = async (
  name: LlamaHolder,
  release: () => Promise<boolean>,
): Promise<boolean> => {
  if (holder !== undefined && holder.name !== name) {
    const previous = holder;
    const freed = await previous.release().catch(() => false);
    if (!freed) {
      return false;
    }
    if (holder === previous) {
      holder = undefined;
    }
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
