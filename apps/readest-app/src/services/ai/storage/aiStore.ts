import type { AIConversation, AIMessage } from '../types';
import { aiLogger } from '../logger';

const DB_NAME = 'bukshelf-ai';
const DB_VERSION = 1;
const CONVERSATIONS_STORE = 'conversations';
const MESSAGES_STORE = 'messages';

class AIStore {
  private db: IDBDatabase | null = null;
  private conversationCache = new Map<string, AIConversation[]>();

  private async openDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CONVERSATIONS_STORE)) {
          const conversations = database.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'id' });
          conversations.createIndex('bookHash', 'bookHash', { unique: false });
        }
        if (!database.objectStoreNames.contains(MESSAGES_STORE)) {
          const messages = database.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
          messages.createIndex('conversationId', 'conversationId', { unique: false });
        }
      };
    });
  }

  async saveConversation(conversation: AIConversation): Promise<void> {
    const database = await this.openDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(CONVERSATIONS_STORE, 'readwrite');
      transaction.objectStore(CONVERSATIONS_STORE).put(conversation);
      transaction.oncomplete = () => {
        this.conversationCache.delete(conversation.bookHash);
        resolve();
      };
      transaction.onerror = () => {
        aiLogger.store.error('saveConversation', transaction.error?.message || 'TX error');
        reject(transaction.error);
      };
    });
  }

  async getConversations(bookHash: string): Promise<AIConversation[]> {
    const cached = this.conversationCache.get(bookHash);
    if (cached) return cached;
    const database = await this.openDB();
    return new Promise((resolve, reject) => {
      const request = database
        .transaction(CONVERSATIONS_STORE, 'readonly')
        .objectStore(CONVERSATIONS_STORE)
        .index('bookHash')
        .getAll(bookHash);
      request.onsuccess = () => {
        const conversations = (request.result as AIConversation[]).sort(
          (left, right) => right.updatedAt - left.updatedAt,
        );
        this.conversationCache.set(bookHash, conversations);
        resolve(conversations);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteConversation(id: string): Promise<void> {
    const database = await this.openDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([CONVERSATIONS_STORE, MESSAGES_STORE], 'readwrite');
      transaction.objectStore(CONVERSATIONS_STORE).delete(id);
      const cursor = transaction.objectStore(MESSAGES_STORE).index('conversationId').openCursor(id);
      cursor.onsuccess = () => {
        const value = cursor.result;
        if (value) {
          value.delete();
          value.continue();
        }
      };
      transaction.oncomplete = () => {
        this.conversationCache.clear();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async updateConversationTitle(id: string, title: string): Promise<void> {
    const database = await this.openDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(CONVERSATIONS_STORE, 'readwrite');
      const store = transaction.objectStore(CONVERSATIONS_STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const conversation = request.result as AIConversation | undefined;
        if (conversation) store.put({ ...conversation, title, updatedAt: Date.now() });
      };
      transaction.oncomplete = () => {
        this.conversationCache.clear();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async saveMessage(message: AIMessage): Promise<void> {
    const database = await this.openDB();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(MESSAGES_STORE, 'readwrite');
      transaction.objectStore(MESSAGES_STORE).put(message);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getMessages(conversationId: string): Promise<AIMessage[]> {
    const database = await this.openDB();
    return new Promise((resolve, reject) => {
      const request = database
        .transaction(MESSAGES_STORE, 'readonly')
        .objectStore(MESSAGES_STORE)
        .index('conversationId')
        .getAll(conversationId);
      request.onsuccess = () =>
        resolve(
          (request.result as AIMessage[]).sort((left, right) => left.createdAt - right.createdAt),
        );
      request.onerror = () => reject(request.error);
    });
  }
}

export const aiStore = new AIStore();
