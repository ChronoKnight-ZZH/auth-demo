'use strict';
/**
 * chat-demo 历史归档（export_format_version = 3）的服务端校验与转换。
 *
 * 与前端 `chat-demo/src/services/chat/history` 保持同一套语义：
 * - 容器与元数据严格校验，无法识别的单个内容片段丢弃；
 * - 消息树按 id / parent_id 还原，current_message_id 决定当前分支；
 * - 图片条目按会话目录匹配，非图片附件只有元数据；
 * - 转换结果必须符合 `/v1/sessions` 保存的本地 Session 结构。
 */
const EXPORT_FORMAT_VERSION = 3;
const MAX_MESSAGES = 5000;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_TITLE_CHARS = 255;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class ImportError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ImportError';
    this.code = 'INVALID_ARCHIVE_DATA';
  }
}

const fail = (reason) => {
  throw new ImportError(reason);
};

const record = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('对象结构无效');
  }
  return value;
};
const string = (value) => (typeof value === 'string' ? value : fail('字符串字段无效'));
const boolean = (value) => (typeof value === 'boolean' ? value : fail('布尔字段无效'));
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : fail('数字字段无效'));
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : fail('计数字段无效'));

const nullable = (read) => (value) => (value === null ? null : read(value));
const list = (read) => (value) => (Array.isArray(value) ? value.map(read) : fail('数组字段无效'));
const oneOf = (...values) => (value) => (values.includes(value) ? value : fail('枚举字段无效'));

/** 校验 RFC3339 UTC 时间，保留原文（可能带微秒/纳秒） */
const time = (value) => {
  if (typeof value !== 'string') {
    fail('时间字段无效');
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value);
  if (!match) {
    fail('时间格式无效');
  }
  const milliseconds = `${match[1]}.${(match[2] || '').padEnd(3, '0').slice(0, 3)}Z`;
  const parsed = new Date(milliseconds);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== milliseconds) {
    fail('时间超出范围');
  }
  return value;
};

const toMillis = (value) => Date.parse(value);

const tipStyle = oneOf('INFO', 'WARNING', 'CAUTION');
const searchStatus = oneOf('WIP', 'FINISHED', 'FAILED');
const toolMetadata = (item) => ({
  ...('stage_id' in item ? { stage_id: count(item.stage_id) } : {}),
  ...('group_id' in item ? { group_id: count(item.group_id) } : {}),
});

const searchResult = (value) => {
  const item = record(value);
  return {
    url: string(item.url),
    title: string(item.title),
    snippet: string(item.snippet),
    published_at: nullable(time)(item.published_at),
    site_name: nullable(string)(item.site_name),
    ...('site_icon' in item ? { site_icon: nullable(string)(item.site_icon) } : {}),
  };
};

const fileEntry = (value) => {
  const item = record(value);
  const id = string(item.id);
  if (!FILE_ID_RE.test(id)) {
    fail('附件 id 无效');
  }
  return {
    id,
    file_name: string(item.file_name),
    file_size: count(item.file_size),
    token_usage: nullable(count)(item.token_usage),
    inserted_at: time(item.inserted_at),
    export_path: nullable(string)(item.export_path),
    is_image: boolean(item.is_image),
    width: nullable(count)(item.width),
    height: nullable(count)(item.height),
  };
};

class FragmentError extends Error {}

/** 单个片段的格式错误只丢弃该片段，不拖垮整个会话 */
const readFragment = (value) => {
  try {
    return readFragmentStrict(value);
  } catch (error) {
    if (error instanceof ImportError || error instanceof FragmentError) {
      return null;
    }
    throw error;
  }
};

const readFragmentStrict = (value) => {
  const item = record(value);
  const type = string(item.type);
  switch (type) {
    case 'REQUEST':
      return { type, content: string(item.content) };
    case 'RESPONSE':
      return { type, content: string(item.content) };
    case 'TEMPLATE_RESPONSE':
      return { type, content: string(item.content) };
    case 'THINK':
      return {
        type,
        content: string(item.content),
        elapsed_secs: nullable(number)(item.elapsed_secs),
      };
    case 'TIP':
      return { type, content: string(item.content), style: tipStyle(item.style) };
    case 'CONTENT_RISK':
      return { type, content: string(item.content), style: tipStyle(item.style) };
    case 'PARTIAL_FILE_READ': {
      const ratio = number(item.ratio);
      return { type, ratio: ratio >= 0 && ratio <= 100 ? ratio : fail('截断比例无效') };
    }
    case 'TOOL_SEARCH':
      return {
        type,
        queries: list(string)(item.queries),
        results: list(searchResult)(item.results),
        ...('status' in item ? { status: searchStatus(item.status) } : {}),
        ...toolMetadata(item),
      };
    case 'TOOL_OPEN':
      return {
        type,
        status: searchStatus(item.status),
        url: nullable(string)(item.url),
        title: nullable(string)(item.title),
        ...('snippet' in item ? { snippet: nullable(string)(item.snippet) } : {}),
        ...('site_name' in item ? { site_name: nullable(string)(item.site_name) } : {}),
        published_at: nullable(time)(item.published_at),
        ...toolMetadata(item),
      };
    case 'TOOL_FIND':
      return {
        type,
        status: oneOf('WIP', 'FINISHED', 'NO_RESULT', 'FAILED')(item.status),
        ...('pattern' in item ? { pattern: string(item.pattern) } : {}),
        ...toolMetadata(item),
      };
    case 'READ_LINK':
      return {
        type,
        results: list((result) => {
          const entry = record(result);
          return {
            signature: string(entry.signature),
            ...('url' in entry ? { url: string(entry.url) } : {}),
            ...('title' in entry ? { title: nullable(string)(entry.title) } : {}),
          };
        })(item.results),
      };
    case 'FILE':
      return { type, files: list(fileEntry)(item.files) };
    case 'TOOL_IMAGE_SEARCH':
      return {
        type,
        status: searchStatus(item.status),
        ...('image_indexes' in item ? { image_indexes: list(count)(item.image_indexes) } : {}),
        ...toolMetadata(item),
        results: list((result) => {
          const entry = record(result);
          return {
            title: string(entry.title),
            source_page_url: string(entry.source_page_url),
            snippet: string(entry.snippet),
            site_name: nullable(string)(entry.site_name),
            published_at: nullable(time)(entry.published_at),
          };
        })(item.results),
      };
    default:
      throw new FragmentError();
  }
};

const message = (value) => {
  const item = record(value);
  return {
    id: count(item.id),
    parent_id: nullable(count)(item.parent_id),
    role: oneOf('USER', 'ASSISTANT')(item.role),
    status: oneOf(
      'WIP',
      'FINISHED',
      'CONTENT_FILTER',
      'FAILED',
      'INCOMPLETE',
      'CONTEXT_LENGTH_EXCEEDED',
      'TIMEOUT'
    )(item.status),
    thinking_enabled: boolean(item.thinking_enabled),
    search_enabled: boolean(item.search_enabled),
    accumulated_token_usage: count(item.accumulated_token_usage),
    inserted_at: time(item.inserted_at),
    fragments: list(readFragment)(item.fragments).filter((fragment) => fragment !== null),
  };
};

const sessionId = (value) => {
  const id = string(value);
  if (!SESSION_ID_RE.test(id)) {
    fail('会话 id 无效');
  }
  return id;
};

function checkManifest(value) {
  const version = record(value).export_format_version;
  if (typeof version === 'number' && version > EXPORT_FORMAT_VERSION) {
    fail(`归档版本 ${version} 高于当前支持的 ${EXPORT_FORMAT_VERSION}`);
  }
  if (version !== EXPORT_FORMAT_VERSION) {
    fail(`不支持的归档版本: ${String(version)}`);
  }
}

function readSessionIndex(value) {
  return list((entry) => {
    const item = record(entry);
    return {
      id: sessionId(item.id),
      title: nullable(string)(item.title),
      message_count: count(item.message_count),
      inserted_at: time(item.inserted_at),
      updated_at: time(item.updated_at),
    };
  })(value);
}

function readSessionFile(value) {
  const item = record(value);
  if (!Array.isArray(item.messages)) {
    fail('会话缺少消息数组');
  }
  if (item.messages.length > MAX_MESSAGES) {
    fail('会话消息数量超过上限');
  }
  return {
    id: sessionId(item.id),
    title: nullable(string)(item.title),
    // current_message_id 允许为 0（空会话），非空会话在还原时校验存在性
    current_message_id: count(item.current_message_id),
    inserted_at: time(item.inserted_at),
    updated_at: time(item.updated_at),
    messages: list(message)(item.messages),
  };
}

const isWebUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const toolBlocks = (id, input, kind, result) => [
  {
    type: 'server_tool_use',
    id,
    name: kind === 'read_link' ? 'deepseek_read_url' : 'deepseek_web_search',
    input,
    kind,
    caller: { type: 'direct' },
  },
  ...(result ? [result] : []),
];

const fetchResult = (toolUseId, content) => ({
  type: 'web_fetch_tool_result',
  tool_use_id: toolUseId,
  kind: 'deep_search',
  content,
});

const fetched = (url, title, publishedAt) => ({
  type: 'web_fetch_result',
  url,
  content: {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: '' },
    title,
  },
  published_at: publishedAt,
});

const unavailable = {
  type: 'web_fetch_tool_result_error',
  error_code: 'unavailable',
};

const toBlocks = (fragments, messageId) => {
  const searchKind = fragments.some(
    (item) => item.type === 'TOOL_OPEN' || item.type === 'TOOL_FIND'
  )
    ? 'deep_search'
    : 'search';

  return fragments.flatMap((item, index) => {
    const id = `history-${messageId}-${index}`;
    switch (item.type) {
      case 'RESPONSE':
        return [{ type: 'text', text: item.content }];
      case 'TEMPLATE_RESPONSE':
        return [{ type: 'text', text: item.content, isTemplate: true }];
      case 'THINK':
        return [
          {
            type: 'thinking',
            thinking: item.content,
            ...(item.elapsed_secs === null ? {} : { elapsedSeconds: item.elapsed_secs }),
          },
        ];
      case 'TOOL_SEARCH':
        return toolBlocks(
          id,
          { action: 'search', query: item.queries[0] || '', queries: item.queries },
          searchKind,
          item.status === 'WIP'
            ? undefined
            : {
                type: 'web_search_tool_result',
                tool_use_id: id,
                kind: searchKind,
                content:
                  item.status === 'FAILED'
                    ? [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
                    : item.results
                        .filter((result) => isWebUrl(result.url))
                        .map((result) => ({
                          type: 'web_search_result',
                          url: result.url,
                          title: result.title,
                          snippet: result.snippet,
                          site_icon:
                            result.site_icon && isWebUrl(result.site_icon)
                              ? result.site_icon
                              : null,
                          site_name: result.site_name,
                          page_age: result.published_at,
                          encrypted_content: '',
                        })),
              }
        );
      case 'TOOL_OPEN':
        if (!item.url || !isWebUrl(item.url)) {
          return [];
        }
        return toolBlocks(
          id,
          { action: 'open_page', url: item.url },
          'deep_search',
          item.status === 'WIP'
            ? undefined
            : fetchResult(
                id,
                item.status === 'FINISHED'
                  ? fetched(item.url, item.title, item.published_at)
                  : unavailable
              )
        );
      case 'TOOL_FIND':
        return toolBlocks(
          id,
          { action: 'find_in_page', url: '', pattern: item.pattern || '' },
          'deep_search',
          item.status === 'WIP'
            ? undefined
            : fetchResult(id, item.status === 'FINISHED' ? fetched('', null, null) : unavailable)
        );
      case 'READ_LINK':
        return item.results.flatMap((result, resultIndex) => {
          const url = result.url && isWebUrl(result.url) ? result.url : '';
          if (!url && !result.signature.trim()) {
            return [];
          }
          const toolId = `${id}-${resultIndex}`;
          return toolBlocks(toolId, { action: 'read_link', url }, 'read_link', {
            type: 'web_fetch_tool_result',
            tool_use_id: toolId,
            kind: 'read_link',
            content: fetched(url, result.title || null, null),
            signature: result.signature,
          });
        });
      default:
        return [];
    }
  });
};

const replyStatus = {
  FINISHED: 'done',
  CONTENT_FILTER: 'done',
  FAILED: 'error',
  CONTEXT_LENGTH_EXCEEDED: 'error',
  INCOMPLETE: 'stopped',
  TIMEOUT: 'error',
  WIP: 'stopped',
};

const toUser = (item, toFile) => ({
  id: String(item.id),
  role: 'user',
  createdAt: toMillis(item.inserted_at),
  content: item.fragments.map((fragment) => (fragment.type === 'REQUEST' ? fragment.content : '')).join(''),
  files: item.fragments.flatMap((fragment) =>
    fragment.type === 'FILE' ? fragment.files.map(toFile) : []
  ),
});

const toAssistant = (item) => {
  const id = String(item.id);
  const blocks = toBlocks(item.fragments, id);
  const refused = item.status === 'CONTENT_FILTER';
  return {
    id,
    role: 'assistant',
    createdAt: toMillis(item.inserted_at),
    model: null,
    thinking: item.thinking_enabled,
    search: item.search_enabled,
    prefix: false,
    status: replyStatus[item.status],
    ...(refused ? { stopReason: 'refusal' } : {}),
    blocks: refused
      ? blocks.filter(
          (block) => block.type !== 'thinking' && (block.type !== 'text' || block.isTemplate)
        )
      : blocks,
  };
};

const buildTree = (file, toFile) => {
  const sorted = [...file.messages].sort((a, b) => a.id - b.id);
  const byId = new Map();
  const messages = sorted.map((item) => {
    const { id, parent_id: parentId } = item;
    const parent = parentId === null ? undefined : byId.get(parentId);
    if (
      byId.has(id) ||
      (parentId === null ? item.role !== 'USER' : !parent) ||
      (parent && parent.role === (item.role === 'USER' ? 'user' : 'assistant'))
    ) {
      fail('消息树分支无效');
    }
    const local = item.role === 'USER' ? toUser(item, toFile) : toAssistant(item);
    local.parentId = parent ? parent.id : null;
    if (parent) {
      parent.selectedChildId = local.id;
    }
    byId.set(id, local);
    return local;
  });
  if (messages.length === 0) {
    return { messages, rootMessageId: null };
  }
  let current = byId.get(file.current_message_id);
  if (!current) {
    fail('current_message_id 不在消息树中');
  }
  current.selectedChildId = undefined;
  while (current.parentId) {
    const parent = byId.get(Number(current.parentId));
    if (!parent) {
      fail('消息父节点缺失');
    }
    parent.selectedChildId = current.id;
    current = parent;
  }
  return { messages, rootMessageId: current.id };
};

/**
 * 收集会话引用的图片条目：fileId → { path, name, size, insertedAt }。
 * 图片路径必须位于本会话目录下；同一条目不能对应不同文件。
 */
function collectSessionImages(file) {
  const images = new Map();
  for (const item of file.messages) {
    for (const fragment of item.fragments) {
      if (fragment.type !== 'FILE') {
        continue;
      }
      for (const entry of fragment.files) {
        if (!entry.is_image || entry.export_path === null) {
          continue;
        }
        const path = entry.export_path.normalize('NFC');
        if (!path.startsWith(`chat_sessions/${file.id}_files/`)) {
          fail(`图片路径不在会话目录内: ${path}`);
        }
        const existing = images.get(entry.id);
        if (existing && existing.path !== path) {
          fail(`同一附件对应多个图片路径: ${entry.id}`);
        }
        if (!existing) {
          images.set(entry.id, {
            fileId: entry.id,
            path,
            name: entry.file_name,
            size: entry.file_size,
            insertedAt: toMillis(entry.inserted_at),
          });
        }
      }
    }
  }
  return images;
}

/**
 * 转换为服务端保存的本地 Session。
 * resolvedFiles: fileId → { storageId, mime, isImage }（图片未归档时缺省）
 */
function toLocalSession(file, resolvedFiles = new Map()) {
  const toFile = (entry) => {
    const resolved = resolvedFiles.get(entry.id);
    return {
      id: entry.id,
      serverId: null,
      storageId: resolved ? resolved.storageId : null,
      name: entry.file_name,
      size: entry.file_size,
      // 归档声称图片但内容不是已知图片时降级为文件卡片，避免服务端内联不安全内容
      isImage: resolved ? entry.is_image && resolved.isImage : entry.is_image,
      mimeType: resolved ? resolved.mime : '',
    };
  };

  const tree = buildTree(file, toFile);
  const title = [...(file.title || '')].slice(0, MAX_TITLE_CHARS).join('');
  const session = {
    id: file.id,
    title,
    createdAt: toMillis(file.inserted_at),
    updatedAt: toMillis(file.updated_at),
    rootMessageId: tree.rootMessageId,
    messages: tree.messages,
  };

  const bytes = Buffer.byteLength(JSON.stringify(session.messages), 'utf8');
  if (bytes > MAX_SESSION_BYTES) {
    fail(`会话 ${file.id} 消息 JSON 超过 ${MAX_SESSION_BYTES} 字节`);
  }
  for (const item of session.messages) {
    if (!MESSAGE_ID_RE.test(item.id)) {
      fail(`消息 id 无法保存: ${item.id}`);
    }
  }
  return { session, images: collectSessionImages(file) };
}

module.exports = {
  EXPORT_FORMAT_VERSION,
  MAX_SESSION_BYTES,
  MAX_TITLE_CHARS,
  ImportError,
  checkManifest,
  readSessionIndex,
  readSessionFile,
  toLocalSession,
  collectSessionImages,
};
