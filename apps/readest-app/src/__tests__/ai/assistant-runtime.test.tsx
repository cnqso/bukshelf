import { render } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type ThreadHistoryAdapter,
  useAssistantRuntime,
  useLocalRuntime,
} from '@assistant-ui/react';
import { describe, expect, test } from 'vitest';

const modelAdapter: ChatModelAdapter = {
  async *run() {},
};

const historyAdapter: ThreadHistoryAdapter = {
  async load() {
    return { messages: [] };
  },
  async append() {},
};

const RuntimeProbe = () => {
  const runtime = useAssistantRuntime();
  runtime.thread.composer.setText('ready');
  return <output>{runtime.thread.composer.getState().text}</output>;
};

const RuntimeHarness = () => {
  const runtime = useLocalRuntime(modelAdapter, {
    adapters: { history: historyAdapter },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RuntimeProbe />
    </AssistantRuntimeProvider>
  );
};

describe('Reader AI assistant runtime', () => {
  test('initializes a local runtime with persistent conversation history', () => {
    const { getByText } = render(<RuntimeHarness />);

    expect(getByText('ready')).toBeTruthy();
  });
});
