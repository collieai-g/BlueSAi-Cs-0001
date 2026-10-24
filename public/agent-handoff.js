(() => {
  // Host APIs are optional. This bridge never opens guessed URLs, signs in to
  // another service, or claims an editor request has executed an AI task.
  let toolCallbacks = null;
  const registered = new Set();
  const validSnapshot = task => Boolean(task?.snapshot && Array.isArray(task.snapshot.facts) && Number.isSafeInteger(task.revision));
  const expiredSnapshot = task => !validSnapshot(task) || task.snapshot.facts.some(fact =>
    fact.expiresAt != null && (!Number.isFinite(fact.expiresAt) || fact.expiresAt <= Date.now()));
  const terminal = task => !task || task.contextStale || expiredSnapshot(task) || ['result_saved', 'cancelled'].includes(task.status);
  const packet = task => ({
    taskId: task.id, instruction: task.instruction, status: task.status,
    version: task.version, revision: task.revision, verificationCode: task.verificationCode,
    prompt: task.prompt, contextStale: Boolean(task.contextStale), resultText: task.resultText || null,
    resultScope: 'returned draft only; no knowledge adoption or customer sending',
  });
  const content = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  function selected(taskId) {
    const task = toolCallbacks?.getSelectedTask();
    if (!task || typeof taskId !== 'string' || task.id !== taskId) throw new Error('請先在頁面選擇這個任務。');
    if (terminal(task)) throw new Error('任務已結束或資料已更新，請重新準備任務。');
    return task;
  }
  function validateArgs(args, names) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !names.includes(key))) throw new Error('任務工具參數無效。');
  }
  async function execute(fn) {
    try { return content(await fn()); }
    catch (error) {
      try { await toolCallbacks?.onError?.(error); } catch { /* The tool still reports the original failure. */ }
      return { isError: true, content: [{ type: 'text', text: error.message || '操作未完成。' }] };
    }
  }
  function canRegister() {
    return window.top === window && typeof document.modelContext?.registerTool === 'function';
  }
  async function copy(target, task) {
    if (terminal(task) || !target || typeof target.value !== 'string' || target.value !== task.prompt) throw new Error('任務資料已更新或過期，請先重新核對或準備新任務。');
    if (typeof window.navigator?.clipboard?.writeText !== 'function') {
      target.focus(); target.select(); return false;
    }
    try { await window.navigator.clipboard.writeText(target.value); return true; }
    catch { target.focus(); target.select(); return false; }
  }
  window.csAgentBridge = {
    copy,
    describe() {
      const route = typeof document.oai?.annotation?.request === 'function'
        ? '此瀏覽器可開啟目前 AI 對話的任務編輯器，由你確認送出。'
        : typeof window.openai?.sendFollowUpMessage === 'function'
          ? '此介面可將任務交給目前 AI 對話。'
          : '此瀏覽器可複製任務，再貼到目前 Codex／DOT 對話。';
      return route + (registered.size === 2 ? ' 站內任務工具可用。' : ' 可貼回結果保存為草稿。');
    },
    invoke(task, target) {
      if (terminal(task) || typeof task.prompt !== 'string' || !target?.isConnected ||
          target.value !== task.prompt || !target.getClientRects().length) throw new Error('請先選擇有效任務，並展開任務內容。');
      const annotation = document.oai?.annotation;
      if (typeof annotation?.request === 'function') {
        const initialComment = `請由目前 Codex／DOT 處理已選任務 ${task.id}。先讀任務內容，可用 bluesai_get_task 讀取，並以 bluesai_save_task_result 保存草稿。只整理草稿，不發送客戶訊息。`;
        // Keep this synchronous in the user click stack: no await, fetch or
        // clipboard operation may precede the native request.
        const result = annotation.request(target, {
          initialComment: initialComment.slice(0, 240), mode: 'default',
          metadata: { taskId: task.id, agent: 'BlueSAi-Cs-#0001' },
        });
        return { kind: 'annotation', accepted: result?.accepted === true };
      }
      if (typeof window.openai?.sendFollowUpMessage === 'function') {
        const result = window.openai.sendFollowUpMessage({ prompt: task.prompt, title: '交給目前 Codex／DOT 處理' });
        return { kind: 'host', promise: Promise.resolve(result).then(value => value !== false && value?.accepted !== false) };
      }
      return { kind: 'copy', promise: copy(target, task) };
    },
    registerTools(callbacks) {
      toolCallbacks = callbacks;
      if (!canRegister()) return false;
      const definitions = [{
        name: 'bluesai_get_task',
        description: 'Read only the customer-service draft task explicitly selected in this page. Rejects stale context and does not expose task history or credentials.',
        inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: args => execute(async () => {
          validateArgs(args, ['taskId']); selected(args.taskId);
          const task = await toolCallbacks.readTask(args.taskId);
          selected(args.taskId);
          if (terminal(task)) throw new Error('任務資料已更新，請在頁面準備新任務。');
          return packet(task);
        }),
      }, {
        name: 'bluesai_save_task_result',
        description: 'Save an unverified returned draft for the explicitly selected task. Never adopts knowledge, sends customer messages, or controls a WhatsApp conversation.',
        inputSchema: {
          type: 'object', properties: {
            taskId: { type: 'string' }, expectedVersion: { type: 'integer', minimum: 1 },
            verificationCode: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 8000 },
          }, required: ['taskId', 'expectedVersion', 'verificationCode', 'text'], additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
        execute: args => execute(async () => {
          validateArgs(args, ['taskId', 'expectedVersion', 'verificationCode', 'text']);
          const task = selected(args.taskId);
          if (!Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 1 ||
              typeof args.verificationCode !== 'string' || args.verificationCode !== task.verificationCode ||
              typeof args.text !== 'string' || !args.text.trim() || args.text.length > 8000) throw new Error('請核對任務版本、核對碼及草稿內容。');
          const result = await toolCallbacks.saveResult(args.taskId, args.expectedVersion, {
            taskId: args.taskId, verificationCode: args.verificationCode, text: args.text,
          });
          return { taskId: result.id, version: result.version, status: result.status, resultText: result.resultText, resultScope: 'unverified draft saved; no knowledge adoption or customer sending' };
        }),
      }];
      for (const definition of definitions) {
        if (registered.has(definition.name)) continue;
        document.modelContext.registerTool(definition); registered.add(definition.name);
      }
      return registered.size === definitions.length;
    },
  };
})();
