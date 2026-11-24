import { createContext } from 'react';

/**
 * Lets something inside the Assistant's conversation grow without the
 * conversation jumping to its end: the lesson banner's "How it works"
 * calls it right before it opens or closes, and the conversation skips the
 * one scroll that growth would set off. A no-op outside a conversation.
 */
export const ConversationHoldContext = createContext<() => void>(() => {});
