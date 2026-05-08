function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

function waitForTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已中止'));
  });
}

function normalizeSessionMeta(session) {
  if (!session || typeof session !== 'object') return null;
  return {
    id: String(session.id || ''),
    title: String(session.title || '新会话'),
    model: String(session.model || ''),
    grokConversationId: String(session.grokConversationId || ''),
    grokParentResponseId: String(session.grokParentResponseId || ''),
    createdAt: Number(session.createdAt || 0) || Date.now(),
    updatedAt: Number(session.updatedAt || 0) || Date.now(),
    isDefaultTitle: session.isDefaultTitle !== false,
    unread: Boolean(session.unread)
  };
}

function normalizeStoredMessage(sessionId, message, index = 0) {
  if (!message || typeof message !== 'object') return null;
  const id = String(message.id || `${sessionId}-message-${index + 1}`);
  const createdAt = Number(message.createdAt || message.updatedAt || 0) || Date.now();
  const order = Number(message.order);
  return {
    ...message,
    id,
    sessionId,
    createdAt,
    updatedAt: Number(message.updatedAt || createdAt) || createdAt,
    order: Number.isFinite(order) ? order : index,
    role: String(message.role || 'assistant')
  };
}

function normalizeAttachmentRecord(sessionId, attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const id = String(attachment.id || '');
  const blob = attachment.blob;
  if (!id || !(blob instanceof Blob)) return null;
  const createdAt = Number(attachment.createdAt || 0) || Date.now();
  return {
    id,
    sessionId,
    name: String(attachment.name || 'image'),
    mime: String(attachment.mime || blob.type || 'application/octet-stream'),
    size: Number(attachment.size || blob.size || 0) || 0,
    blob,
    grokFileId: String(attachment.grokFileId || ''),
    grokFileUri: String(attachment.grokFileUri || ''),
    grokUploadedAt: Number(attachment.grokUploadedAt || 0) || 0,
    createdAt,
    updatedAt: Number(attachment.updatedAt || createdAt) || createdAt
  };
}

export function createChatSessionStore(options = {}) {
  const {
    dbName = 'grok2api-chat-db',
    dbVersion = 3
  } = options;

  let dbPromise = null;

  async function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('当前环境不支持 IndexedDB'));
        return;
      }
      const request = indexedDB.open(dbName, dbVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('sessions')) {
          const sessionsStore = db.createObjectStore('sessions', { keyPath: 'id' });
          sessionsStore.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('messages')) {
          const messagesStore = db.createObjectStore('messages', { keyPath: 'id' });
          messagesStore.createIndex('sessionId', 'sessionId');
          messagesStore.createIndex('sessionIdOrder', ['sessionId', 'order']);
        }
        if (!db.objectStoreNames.contains('attachments')) {
          const attachmentsStore = db.createObjectStore('attachments', { keyPath: 'id' });
          attachmentsStore.createIndex('sessionId', 'sessionId');
          attachmentsStore.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('打开 IndexedDB 失败'));
      };
    });
    return dbPromise;
  }

  async function withTransaction(storeNames, mode, runner) {
    const db = await openDatabase();
    const transaction = db.transaction(storeNames, mode);
    const result = await runner(transaction);
    await waitForTransaction(transaction);
    return result;
  }

  async function getMeta(key) {
    return withTransaction(['meta'], 'readonly', async (transaction) => {
      const record = await promisifyRequest(transaction.objectStore('meta').get(key));
      return record ? record.value : null;
    });
  }

  async function setMeta(key, value) {
    return withTransaction(['meta'], 'readwrite', async (transaction) => {
      transaction.objectStore('meta').put({ key, value });
    });
  }

  async function getAllSessions() {
    return withTransaction(['sessions'], 'readonly', async (transaction) => {
      const rows = await promisifyRequest(transaction.objectStore('sessions').getAll());
      return Array.isArray(rows)
        ? rows
          .map((row) => normalizeSessionMeta(row))
          .filter(Boolean)
          .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        : [];
    });
  }

  async function saveSession(session) {
    const normalized = normalizeSessionMeta(session);
    if (!normalized || !normalized.id) return;
    return withTransaction(['sessions'], 'readwrite', async (transaction) => {
      transaction.objectStore('sessions').put(normalized);
    });
  }

  async function saveSessions(sessions) {
    const rows = Array.isArray(sessions) ? sessions.map((item) => normalizeSessionMeta(item)).filter(Boolean) : [];
    return withTransaction(['sessions'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('sessions');
      rows.forEach((row) => {
        if (row.id) store.put(row);
      });
    });
  }

  async function getSessionMessages(sessionId) {
    return withTransaction(['messages'], 'readonly', async (transaction) => {
      const store = transaction.objectStore('messages');
      const rows = await promisifyRequest(store.index('sessionId').getAll(sessionId));
      rows.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      return Array.isArray(rows)
        ? rows.map((row, index) => normalizeStoredMessage(sessionId, row, index)).filter(Boolean)
        : [];
    });
  }

  async function saveMessage(sessionId, message, orderHint = 0) {
    const normalized = normalizeStoredMessage(sessionId, message, orderHint);
    if (!normalized || !normalized.id) return;
    return withTransaction(['messages'], 'readwrite', async (transaction) => {
      transaction.objectStore('messages').put(normalized);
    });
  }

  async function saveMessages(sessionId, messages) {
    const rows = Array.isArray(messages)
      ? messages.map((item, index) => normalizeStoredMessage(sessionId, item, index)).filter(Boolean)
      : [];
    return withTransaction(['messages'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('messages');
      rows.forEach((row) => {
        store.put(row);
      });
    });
  }

  async function saveAttachment(sessionId, attachment) {
    const normalized = normalizeAttachmentRecord(sessionId, attachment);
    if (!normalized) return null;
    await withTransaction(['attachments'], 'readwrite', async (transaction) => {
      transaction.objectStore('attachments').put(normalized);
    });
    return {
      id: normalized.id,
      sessionId: normalized.sessionId,
      name: normalized.name,
      mime: normalized.mime,
      size: normalized.size,
      grokFileId: normalized.grokFileId,
      grokFileUri: normalized.grokFileUri,
      grokUploadedAt: normalized.grokUploadedAt,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt
    };
  }

  async function getAttachment(id) {
    const attachmentId = String(id || '').trim();
    if (!attachmentId) return null;
    return withTransaction(['attachments'], 'readonly', async (transaction) => {
      const row = await promisifyRequest(transaction.objectStore('attachments').get(attachmentId));
      return row && row.blob instanceof Blob ? row : null;
    });
  }

  async function updateAttachmentMeta(id, patch) {
    const attachmentId = String(id || '').trim();
    if (!attachmentId || !patch || typeof patch !== 'object') return null;
    return withTransaction(['attachments'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('attachments');
      const row = await promisifyRequest(store.get(attachmentId));
      if (!row) return null;
      const updated = {
        ...row,
        grokFileId: String(patch.grokFileId || patch.fileId || row.grokFileId || ''),
        grokFileUri: String(patch.grokFileUri || patch.fileUri || row.grokFileUri || ''),
        grokUploadedAt: Number(patch.grokUploadedAt || patch.uploadedAt || Date.now()) || Date.now(),
        updatedAt: Date.now()
      };
      store.put(updated);
      return updated;
    });
  }

  async function deleteSessionAttachments(sessionId) {
    return withTransaction(['attachments'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('attachments');
      const index = store.index('sessionId');
      await new Promise((resolve, reject) => {
        const request = index.openKeyCursor(IDBKeyRange.only(sessionId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('删除会话附件失败'));
      });
    });
  }

  async function deleteSessionMessages(sessionId) {
    return withTransaction(['messages'], 'readwrite', async (transaction) => {
      const store = transaction.objectStore('messages');
      const index = store.index('sessionId');
      await new Promise((resolve, reject) => {
        const request = index.openKeyCursor(IDBKeyRange.only(sessionId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('删除会话消息失败'));
      });
    });
  }

  async function deleteSession(sessionId) {
    return withTransaction(['sessions', 'messages', 'attachments'], 'readwrite', async (transaction) => {
      transaction.objectStore('sessions').delete(sessionId);
      const deleteBySession = (storeName, errorMessage) => new Promise((resolve, reject) => {
        const store = transaction.objectStore(storeName);
        const index = store.index('sessionId');
        const request = index.openKeyCursor(IDBKeyRange.only(sessionId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error(errorMessage));
      });
      await Promise.all([
        deleteBySession('messages', '删除会话消息失败'),
        deleteBySession('attachments', '删除会话附件失败')
      ]);
    });
  }

  async function importLegacySnapshot(snapshot) {
    const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
    const activeId = String(snapshot && snapshot.activeId || '');
    return withTransaction(['sessions', 'messages', 'meta'], 'readwrite', async (transaction) => {
      const sessionsStore = transaction.objectStore('sessions');
      const messagesStore = transaction.objectStore('messages');
      const metaStore = transaction.objectStore('meta');
      sessions.forEach((session, sessionIndex) => {
        const normalizedSession = normalizeSessionMeta(session);
        if (!normalizedSession || !normalizedSession.id) return;
        sessionsStore.put(normalizedSession);
        const messages = Array.isArray(session.messages) ? session.messages : [];
        messages.forEach((message, messageIndex) => {
          const normalizedMessage = normalizeStoredMessage(normalizedSession.id, message, messageIndex);
          if (!normalizedMessage) return;
          if (!Number.isFinite(normalizedMessage.order)) {
            normalizedMessage.order = messageIndex;
          }
          if (!normalizedMessage.createdAt) {
            normalizedMessage.createdAt = normalizedSession.createdAt + messageIndex;
          }
          if (!normalizedMessage.updatedAt) {
            normalizedMessage.updatedAt = normalizedMessage.createdAt;
          }
          messagesStore.put(normalizedMessage);
        });
      });
      metaStore.put({ key: 'activeSessionId', value: activeId });
      metaStore.put({ key: 'schemaVersion', value: dbVersion });
      metaStore.put({ key: 'legacyMigratedAt', value: Date.now() });
    });
  }

  async function getState() {
    const [activeId, sessions] = await Promise.all([
      getMeta('activeSessionId'),
      getAllSessions()
    ]);
    return {
      activeId: typeof activeId === 'string' ? activeId : '',
      sessions
    };
  }

  async function requestPersistentStorage() {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') return false;
    try {
      return await navigator.storage.persist();
    } catch (error) {
      return false;
    }
  }

  async function estimateStorage() {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return null;
    try {
      return await navigator.storage.estimate();
    } catch (error) {
      return null;
    }
  }

  return {
    openDatabase,
    getMeta,
    setMeta,
    getAllSessions,
    getState,
    saveSession,
    saveSessions,
    getSessionMessages,
      saveMessage,
      saveMessages,
      saveAttachment,
      getAttachment,
      updateAttachmentMeta,
      deleteSessionAttachments,
      deleteSessionMessages,
      deleteSession,
    importLegacySnapshot,
    requestPersistentStorage,
    estimateStorage
  };
}
