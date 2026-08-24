'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider,
  useAssistantRuntime,
  useLocalRuntime,
  type ThreadHistoryAdapter,
  type ThreadMessage,
} from '@assistant-ui/react';
import { BookOpenIcon, Loader2Icon } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { createTauriAdapter } from '@/services/ai';
import {
  DEFAULT_BOOK_CONTEXT_CHARACTERS,
  extractBookText,
  renderBookContext,
  type LongContextBook,
} from '@/services/ai/bookContext';
import type { AIMessage, AISettings } from '@/services/ai/types';
import { getEffectiveAISettings } from '@/services/ai/effectiveSettings';
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig';
import { Thread } from '@/components/assistant/Thread';

const convertToExportedMessages = (
  messages: AIMessage[],
): { message: ThreadMessage; parentId: string | null }[] =>
  messages.map((message, index) => {
    const base = {
      id: message.id,
      content: [{ type: 'text' as const, text: message.content }],
      createdAt: new Date(message.createdAt),
      metadata: { custom: {} },
    };
    const threadMessage: ThreadMessage =
      message.role === 'user'
        ? ({ ...base, role: 'user', attachments: [] } as unknown as ThreadMessage)
        : ({
            ...base,
            role: 'assistant',
            status: { type: 'complete', reason: 'stop' },
          } as unknown as ThreadMessage);
    return { message: threadMessage, parentId: index > 0 ? messages[index - 1]!.id : null };
  });

interface AIAssistantProps {
  bookKey: string;
}

interface ChatProps {
  settings: AISettings;
  bookTitle: string;
  authorName: string;
  currentPage: number;
  bookContext: string;
  contextTruncated: boolean;
}

const Chat = (props: ChatProps) => {
  const { activeConversationId, messages, addMessage, isLoadingHistory } = useAIChatStore();
  const optionsRef = useRef(props);
  useEffect(() => {
    optionsRef.current = props;
  });
  const adapter = useMemo(() => createTauriAdapter(() => optionsRef.current), []);
  const historyAdapter = useMemo<ThreadHistoryAdapter | undefined>(() => {
    if (!activeConversationId) return undefined;
    return {
      async load() {
        return { messages: convertToExportedMessages(messages) };
      },
      async append(item) {
        const message = item.message;
        if (message.role === 'system') return;
        const content = message.content
          .filter(
            (part): part is { type: 'text'; text: string } =>
              'type' in part && part.type === 'text',
          )
          .map((part) => part.text)
          .join('\n');
        if (content)
          await addMessage({
            conversationId: activeConversationId,
            role: message.role as 'user' | 'assistant',
            content,
          });
      },
    };
  }, [activeConversationId, messages, addMessage]);
  const runtime = useLocalRuntime(adapter, {
    adapters: historyAdapter ? { history: historyAdapter } : undefined,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadBridge
        isLoadingHistory={isLoadingHistory}
        hasActiveConversation={Boolean(activeConversationId)}
      />
    </AssistantRuntimeProvider>
  );
};

const ThreadBridge = ({
  isLoadingHistory,
  hasActiveConversation,
}: {
  isLoadingHistory: boolean;
  hasActiveConversation: boolean;
}) => {
  const assistantRuntime = useAssistantRuntime();
  const { setActiveConversation } = useAIChatStore();
  const handleClear = useCallback(() => {
    void setActiveConversation(null);
    assistantRuntime.switchToNewThread();
  }, [assistantRuntime, setActiveConversation]);
  return (
    <Thread
      onClear={handleClear}
      isLoadingHistory={isLoadingHistory}
      hasActiveConversation={hasActiveConversation}
    />
  );
};

const AIAssistant = ({ bookKey }: AIAssistantProps) => {
  const _ = useTranslation();
  const { settings } = useSettingsStore();
  const bookData = useBookDataStore((state) => state.getBookData(bookKey));
  const progress = useBookProgress(bookKey);
  const [book, setBook] = useState<LongContextBook | null>(null);
  const [loading, setLoading] = useState(true);
  const runtimeConfig = useRuntimeConfig();
  const aiSettings = getEffectiveAISettings(settings?.aiSettings, runtimeConfig);
  const currentPage = progress?.pageinfo?.current ?? 0;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setBook(null);
    if (!aiSettings.enabled || !bookData?.bookDoc) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    // Do not materialize every chapter in a large EPUB on memory-constrained
    // mobile WebViews. The downstream prompt cannot use more than this budget
    // anyway, so opening later chapter documents only risks a renderer reload.
    void extractBookText(bookData.bookDoc, {
      maxCharacters: DEFAULT_BOOK_CONTEXT_CHARACTERS,
    }).then((extracted) => {
      if (!cancelled) {
        setBook(extracted);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [aiSettings.enabled, bookData?.bookDoc]);

  const context = useMemo(
    () =>
      book
        ? renderBookContext(book, {
            maxCharacters: DEFAULT_BOOK_CONTEXT_CHARACTERS,
            maxPage: aiSettings?.spoilerProtection ? currentPage : undefined,
          })
        : null,
    [book, aiSettings?.spoilerProtection, currentPage],
  );

  if (!aiSettings.enabled) {
    return (
      <div className='flex h-full items-center justify-center p-4'>
        <p className='text-muted-foreground text-sm'>{_('Enable AI in Settings')}</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className='flex h-full items-center justify-center'>
        <Loader2Icon className='text-primary size-6 animate-spin' />
      </div>
    );
  }
  if (!context?.text) {
    return (
      <div className='flex h-full flex-col items-center justify-center gap-3 p-4 text-center'>
        <BookOpenIcon className='text-primary size-6' />
        <p className='text-muted-foreground text-sm'>{_('No readable book text found')}</p>
      </div>
    );
  }

  return (
    <Chat
      settings={aiSettings}
      bookTitle={bookData?.book?.title || 'Unknown'}
      authorName={bookData?.book?.author || ''}
      currentPage={currentPage}
      bookContext={context.text}
      contextTruncated={context.truncated}
    />
  );
};

export default AIAssistant;
