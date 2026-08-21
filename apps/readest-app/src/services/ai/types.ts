import type { LanguageModel } from 'ai';

export type AIProviderName = 'ollama' | 'ai-gateway' | 'openrouter';

export interface AIProvider {
  id: AIProviderName;
  name: string;
  requiresAuth: boolean;
  getModel(): LanguageModel;
  isAvailable(): Promise<boolean>;
  healthCheck(): Promise<boolean>;
}

export interface AISettings {
  enabled: boolean;
  provider: AIProviderName;
  ollamaBaseUrl: string;
  ollamaModel: string;
  aiGatewayApiKey?: string;
  aiGatewayModel?: string;
  aiGatewayCustomModel?: string;
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  openrouterModel?: string;
  spoilerProtection: boolean;
}

export interface AIConversation {
  id: string;
  bookHash: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface AIMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}
