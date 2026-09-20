import type { ConversationState } from '../../types';

// Centralized, predictable conversation state machine.

const TRANSITIONS: Record<ConversationState, ConversationState[]> = {
  disconnected: ['connecting'],
  connecting: ['connected', 'error', 'disconnected'],
  connected: ['listening', 'disconnected', 'error'],
  listening: ['processing', 'connected', 'error', 'disconnected'],
  processing: ['speaking', 'listening', 'error', 'connected'],
  speaking: ['interrupted', 'listening', 'connected', 'error'],
  interrupted: ['listening', 'processing', 'connected'],
  error: ['connecting', 'disconnected', 'connected'],
};

export function canTransition(from: ConversationState, to: ConversationState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Force-safe transition: returns `to` if legal, otherwise `from`. */
export function transition(from: ConversationState, to: ConversationState): ConversationState {
  return canTransition(from, to) ? to : from;
}

export const STATE_LABEL: Record<ConversationState, string> = {
  disconnected: 'Offline',
  connecting: 'Connecting to Maya…',
  connected: 'Maya is online',
  listening: "I'm listening…",
  processing: 'Maya is thinking…',
  speaking: 'Maya is speaking…',
  interrupted: 'Interrupted — listening…',
  error: 'Something went wrong',
};
