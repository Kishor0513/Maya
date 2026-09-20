// ─── Maya core domain types ────────────────────────────────────────────────
// Strict, no `any`. Unknown external payloads use `unknown`.

export type MayaState =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'happy'
  | 'sad'
  | 'excited'
  | 'playful'
  | 'curious'
  | 'concerned';

export type ConversationState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'interrupted'
  | 'error';

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'error';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  text: string;
  timestamp: number;
  audioUrl?: string;
  partial?: boolean;
  sources?: SourceRef[];
  toolCalls?: ToolCallRecord[];
}

export interface SourceRef {
  title: string;
  url?: string;
}

export interface ToolCallRecord {
  name: string;
  summary: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  summary?: string;
}

export interface ConversationSummary {
  id: string;
  date: string;
  summary: string;
  importantTopics: string[];
}

export type MemoryCategory =
  | 'profile'
  | 'preference'
  | 'project'
  | 'interest'
  | 'person'
  | 'event'
  | 'goal'
  | 'fact';

export interface Memory {
  id: string;
  type: MemoryCategory;
  key: string;
  value: string;
  confidence: number;
  sourceConversationId?: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
}

export interface EmotionalState {
  mood: number; // -1..1
  energy: number; // 0..1
  affection: number; // 0..1
  curiosity: number; // 0..1
  excitement: number; // 0..1
  concern: number; // 0..1
}

export interface RelationshipState {
  familiarity: number; // 0..1
  trust: number; // 0..1
  conversationCount: number;
  sharedTopics: string[];
  importantMoments: Memory[];
}

export interface ConversationContext {
  sessionId: string;
  recentMessages: ChatMessage[];
  summary?: string;
  relevantMemories: Memory[];
  emotionalState: EmotionalState;
  relationshipState: RelationshipState;
  language: LanguageOption;
  userName?: string;
  /** Reply channel — controls response length. Defaults to voice. */
  channel?: 'voice' | 'text';
}

export interface MayaPersonality {
  name: string;
  traits: string[];
  communicationStyle: string;
  humorLevel: number;
  affectionLevel: number;
  curiosityLevel: number;
  emotionalExpressiveness: number;
  verbosity: number;
}

export interface VoiceEmotion {
  speed: number;
  pitch: number;
  stability: number;
  expressiveness: number;
}

export interface VoiceSettings {
  voiceId: string;
  speed: number;
  pitch: number;
  expressiveness: number;
  autoPlay: boolean;
}

export type LanguageOption = 'auto' | 'en' | 'ne' | 'hi';

export type VoiceMode = 'auto' | 'push-to-talk' | 'manual';

export interface AudioSettings {
  vadEnabled: boolean;
  vadSensitivity: number; // 0..1
  silenceMs: number;
  inputDeviceId?: string;
}

export interface AISettings {
  provider: string; // 'demo' | 'openai-compatible' | 'custom'
  model: string;
  endpoint: string;
  language: LanguageOption;
}

export interface AppearanceSettings {
  theme: 'dark' | 'light' | 'system';
  ambientEffects: boolean;
  animations: boolean;
}

export interface ConversationSettings {
  autoListen: boolean;
  allowInterrupt: boolean;
  autoPlayResponses: boolean;
}

export interface PrivacySettings {
  storeConversations: boolean;
  memoryEnabled: boolean;
}

export interface AppSettings {
  appearance: AppearanceSettings;
  voice: VoiceSettings;
  audio: AudioSettings;
  ai: AISettings;
  conversation: ConversationSettings;
  privacy: PrivacySettings;
  voiceMode: VoiceMode;
  userName: string;
  onboarded: boolean;
}

export interface AIChunk {
  text?: string;
  done?: boolean;
  sources?: SourceRef[];
  mayaState?: MayaState;
  toolActivity?: string;
}

export interface AIResponse {
  text: string;
  sources?: SourceRef[];
}

export type RealtimeEvent =
  | { type: 'transcript.partial'; text: string }
  | { type: 'transcript.final'; text: string }
  | { type: 'response.text'; text: string; done?: boolean }
  | { type: 'audio.chunk'; data: ArrayBuffer }
  | { type: 'maya.state'; state: MayaState }
  | { type: 'sources'; sources: SourceRef[] }
  | { type: 'tool.activity'; name: string; summary: string }
  | { type: 'error'; message: string; code?: string };

export interface MayaTool {
  name: string;
  description: string;
  execute(args: unknown): Promise<unknown>;
}

export interface MayaError {
  code:
    | 'mic-denied'
    | 'network'
    | 'ws-closed'
    | 'ai-timeout'
    | 'tts-failure'
    | 'stt-failure'
    | 'invalid-key'
    | 'rate-limit'
    | 'backend-unavailable'
    | 'unsupported-browser'
    | 'unknown';
  message: string;
  recoverable: boolean;
}

export interface MayaAvatarProps {
  state: MayaState;
  inputLevel: number;
  outputLevel: number;
  emotion: EmotionalState;
}
