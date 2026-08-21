'use client';

import { useEffect, useRef, type FC } from 'react';
import {
  ActionBarPrimitive,
  AssistantIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAssistantState,
  useThread,
  useThreadViewport,
} from '@assistant-ui/react';
import {
  ArrowUpIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
  Trash2Icon,
} from 'lucide-react';
import { MarkdownText } from './MarkdownText';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/tailwind';

interface ThreadProps {
  onClear?: () => void;
  isLoadingHistory?: boolean;
  hasActiveConversation?: boolean;
}

const LoadingOverlay: FC<{ visible: boolean }> = ({ visible }) => (
  <div
    className={cn(
      'bg-base-100/60 absolute inset-0 z-20 flex items-center justify-center backdrop-blur-sm transition-opacity',
      visible ? 'opacity-100' : 'pointer-events-none opacity-0',
    )}
  >
    <div className='bg-base-content/10 size-8 animate-pulse rounded-full' />
  </div>
);

const ScrollToBottomButton: FC = () => {
  const isAtBottom = useThreadViewport((viewport) => viewport.isAtBottom);
  return (
    <ThreadPrimitive.ScrollToBottom
      className={cn(
        'bg-base-300 text-base-content border-base-content/10 absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 rounded-full border p-2 transition-opacity',
        isAtBottom && 'pointer-events-none opacity-0',
      )}
      aria-hidden={isAtBottom}
      aria-label='Scroll to bottom'
    >
      <ChevronDownIcon className='size-4' />
    </ThreadPrimitive.ScrollToBottom>
  );
};

export const Thread: FC<ThreadProps> = ({
  onClear,
  isLoadingHistory = false,
  hasActiveConversation = false,
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const initialMount = useRef(true);
  const messageCount = useThread((thread) => thread.messages.length);
  const lastRole = useThread((thread) => thread.messages.at(-1)?.role);
  const running = useThread((thread) => thread.isRunning);
  const showLoading = isLoadingHistory && hasActiveConversation;

  useEffect(() => {
    if (!initialMount.current || messageCount === 0 || !viewportRef.current) return;
    initialMount.current = false;
    requestAnimationFrame(() => {
      if (viewportRef.current) viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    });
  }, [messageCount]);

  useEffect(() => {
    if (lastRole !== 'user' || initialMount.current || !viewportRef.current) return;
    requestAnimationFrame(() => {
      const messages = viewportRef.current?.querySelectorAll('[data-message-role="user"]');
      messages?.item(messages.length - 1).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }, [messageCount, lastRole]);

  return (
    <ThreadPrimitive.Root className='bg-base-100 relative flex h-full w-full flex-col px-3'>
      <LoadingOverlay visible={showLoading} />
      {!hasActiveConversation && (
        <ThreadPrimitive.Empty>
          <div className='flex h-full flex-col items-center justify-center'>
            <div className='bg-base-content/10 mb-4 rounded-full p-3'>
              <BookOpenIcon className='text-base-content size-6' />
            </div>
            <h3 className='text-base-content mb-1 text-sm font-medium'>Ask about this book</h3>
            <p className='text-base-content/60 mb-4 text-xs'>Uses the book text directly</p>
            <Composer onClear={onClear} />
          </div>
        </ThreadPrimitive.Empty>
      )}
      <AssistantIf condition={(state) => !state.thread.isEmpty}>
        <div className='relative min-h-0 flex-1'>
          <ThreadPrimitive.Viewport
            ref={viewportRef}
            autoScroll={false}
            className='absolute inset-0 flex flex-col overflow-y-auto pt-2'
          >
            <ThreadPrimitive.Messages
              components={{ UserMessage, EditComposer, AssistantMessage }}
            />
            <p className='text-base-content/40 mx-auto w-full p-1 text-center text-[10px]'>
              AI can make mistakes. Verify with the book.
            </p>
            <div
              className={cn(
                'flex-shrink transition-all',
                running ? 'min-h-[50vh]' : lastRole === 'user' ? 'min-h-8' : 'min-h-4',
              )}
            />
          </ThreadPrimitive.Viewport>
          <ScrollToBottomButton />
        </div>
        <Composer onClear={onClear} />
      </AssistantIf>
    </ThreadPrimitive.Root>
  );
};

const Composer: FC<{ onClear?: () => void }> = ({ onClear }) => {
  const empty = useAssistantState((state) => state.composer.isEmpty);
  const running = useAssistantState((state) => state.thread.isRunning);
  return (
    <ComposerPrimitive.Root
      className='group/composer mx-auto mb-2 w-full'
      data-empty={empty}
      data-running={running}
    >
      <div className='bg-base-200 ring-base-content/10 overflow-hidden rounded-2xl shadow-sm ring-1 ring-inset'>
        <div className='flex items-end gap-0.5 p-1.5'>
          {onClear && (
            <button
              type='button'
              onClick={onClear}
              className='text-base-content hover:bg-base-300 mb-0.5 flex size-7 items-center justify-center rounded-full'
              aria-label='Clear chat'
            >
              <Trash2Icon className='size-3.5' />
            </button>
          )}
          <ComposerPrimitive.Input
            placeholder='Ask about this book...'
            rows={1}
            className='text-base-content placeholder:text-base-content/40 my-1 h-5 max-h-[200px] min-w-0 flex-1 resize-none bg-transparent text-sm outline-none'
          />
          <div className='bg-base-content text-base-100 relative mb-0.5 size-7 rounded-full'>
            <ComposerPrimitive.Send className='absolute inset-0 flex items-center justify-center group-data-[empty=true]/composer:hidden group-data-[running=true]/composer:hidden'>
              <ArrowUpIcon className='size-3.5' />
            </ComposerPrimitive.Send>
            <ComposerPrimitive.Cancel className='absolute inset-0 flex items-center justify-center group-data-[running=false]/composer:hidden'>
              <SquareIcon className='size-3' fill='currentColor' />
            </ComposerPrimitive.Cancel>
            <div className='absolute inset-0 flex items-center justify-center group-data-[empty=false]/composer:hidden group-data-[running=true]/composer:hidden'>
              <ArrowUpIcon className='size-3.5 opacity-40' />
            </div>
          </div>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className='group/message mx-auto mb-1 flex w-full flex-col pb-0.5'>
    <div className='prose prose-xs text-base-content [&_*]:!text-base-content [&_a]:!text-primary [&_code]:!text-base-content w-full select-text text-sm'>
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
    </div>
    <AssistantIf condition={(state) => state.message.status?.type !== 'running'}>
      <ActionBarPrimitive.Root className='flex h-6 items-center gap-0.5'>
        <BranchPicker />
        <ActionBarPrimitive.Reload className='text-base-content/40 hover:bg-base-200 flex size-6 items-center justify-center rounded-full'>
          <RefreshCwIcon className='size-3' />
        </ActionBarPrimitive.Reload>
        <ActionBarPrimitive.Copy className='text-base-content/40 hover:bg-base-200 flex size-6 items-center justify-center rounded-full'>
          <AssistantIf condition={({ message }) => message.isCopied}>
            <CheckIcon className='size-3' />
          </AssistantIf>
          <AssistantIf condition={({ message }) => !message.isCopied}>
            <CopyIcon className='size-3' />
          </AssistantIf>
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </AssistantIf>
  </MessagePrimitive.Root>
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root
    className='group/message mx-auto mb-1 flex w-full flex-col'
    data-message-role='user'
  >
    <div className='border-base-content/10 bg-base-200 text-base-content ml-auto max-w-[90%] rounded-2xl rounded-br-md border px-3 py-2'>
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
    </div>
    <ActionBarPrimitive.Root className='ml-auto flex h-6 items-center gap-0.5'>
      <ActionBarPrimitive.Edit className='text-base-content/40 flex size-6 items-center justify-center'>
        <PencilIcon className='size-3' />
      </ActionBarPrimitive.Edit>
      <ActionBarPrimitive.Copy className='text-base-content/40 flex size-6 items-center justify-center'>
        <CopyIcon className='size-3' />
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  </MessagePrimitive.Root>
);

const EditComposer: FC = () => (
  <MessagePrimitive.Root className='mx-auto flex w-full flex-col py-2'>
    <ComposerPrimitive.Root className='border-base-content/10 bg-base-200 ml-auto flex w-full max-w-[90%] flex-col rounded-2xl border'>
      <ComposerPrimitive.Input className='text-base-content min-h-10 w-full resize-none bg-transparent p-3 text-sm outline-none' />
      <div className='mx-2 mb-2 flex gap-1.5 self-end'>
        <ComposerPrimitive.Cancel asChild>
          <Button variant='ghost' size='sm'>
            Cancel
          </Button>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <Button size='sm'>Update</Button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  </MessagePrimitive.Root>
);

const BranchPicker: FC = () => (
  <BranchPickerPrimitive.Root
    hideWhenSingleBranch
    className='text-base-content/40 flex items-center text-[10px]'
  >
    <BranchPickerPrimitive.Previous asChild>
      <button type='button' className='flex size-6 items-center justify-center'>
        <ChevronLeftIcon className='size-3' />
      </button>
    </BranchPickerPrimitive.Previous>
    <span>
      <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
    </span>
    <BranchPickerPrimitive.Next asChild>
      <button type='button' className='flex size-6 items-center justify-center'>
        <ChevronRightIcon className='size-3' />
      </button>
    </BranchPickerPrimitive.Next>
  </BranchPickerPrimitive.Root>
);
