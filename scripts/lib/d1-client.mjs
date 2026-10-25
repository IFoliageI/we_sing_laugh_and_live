// ============================================================
//  Cloudflare D1 构建期 REST 客户端（零第三方依赖，只用全局 fetch）
//
//  ⚠️ 本文件所有 URL / 请求头 / 请求体字段名 / 响应结构均以官方文档为准，
//     禁止凭记忆改字段名。来源（2026-04 版文档，已逐字核对）：
//
//  1) 查询 D1 数据库（POST .../query）
//     https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/index.md
//     · URL   : POST https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query
//     · 认证  : Authorization: Bearer <CLOUDFLARE_API_TOKEN> + Content-Type: application/json
//     · 请求体: { "sql": "...", "params": ["a", "b"] }
//               或 { "batch": [ { "sql": "...", "params": [...] }, ... ] }
//     · 响应  : { "success": true, "errors": [{code,message,documentation_url,source}],
//                "messages": [...], "result": [ { "success": true, "results": [ {...} ], "meta": {...} } ] }
//       ★ 行数据在 result[i].results —— 两层嵌套，别写成 payload.results
//       ★ 顶层 success 与每个 result[i].success 都要检查；errors[] 非空即失败
//     · meta  : changed_db / changes / duration / last_row_id / rows_read / rows_written / ...
//     · 一条 sql 可用分号连接多语句，官方说明会按 batch 执行
//
//  2) 导出 D1 为 SQL（POST .../export，轮询模式）
//     https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/index.md
//     · 请求体: { "output_format": "polling", "current_bookmark": "<上一轮 at_bookmark>", "dump_options": {...} }
//     · 响应  : result = { at_bookmark, error, status: "complete"|"error", result: { filename, signed_url } }
//     · 说明  : 导出期间 D1 不可用；必须持续轮询，超过时限会自动取消
//
//  3) D1 平台限制（分批策略的硬约束依据）
//     https://developers.cloudflare.com/d1/platform/limits/index.md
//     · 单条 SQL 语句最大 100,000 字节（100 KB）
//     · 单次查询最多 100 个绑定参数
//     · 单次查询最大 30 秒
//     · 单行 / 字符串 / BLOB 最大 2,000,000 字节
//     · params 官方标注为 array of string → 本客户端把所有绑定参数统一转成字符串
//
//  安全约定：
//   · token 只从环境变量读取（CLOUDFLARE_API_TOKEN），绝不写盘、绝不拼进 SQL、绝不打印；
//   · 所有面向用户的错误信息都会经过 scrubSecret()，万一响应回显 token 也会被替换成 [REDACTED]；
//   · signed_url 视同一次性凭据，不写进日志。
// ============================================================

export const D1_ENV = Object.freeze({
  accountId: 'CLOUDFLARE_ACCOUNT_ID',
  databaseId: 'CLOUDFLARE_D1_DATABASE_ID',
  token: 'CLOUDFLARE_API_TOKEN',
  /** 可选：覆盖 API 根地址（自建代理 / 测试用），默认官方地址。 */
  baseUrl: 'CLOUDFLARE_D1_API_BASE',
  /** 可选：单次请求超时毫秒数，默认 30000。 */
  timeoutMs: 'D1_TIMEOUT_MS',
});

export const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_PAGE_SIZE = 100;
export const DEFAULT_BATCH_STATEMENTS_PER_REQUEST = 20;

/** D1 官方限制（数值来自上方的 limits 文档，改之前先重新核对文档）。 */
export const D1_LIMITS = Object.freeze({
  maxBoundParamsPerQuery: 100,
  maxSqlBytes: 100_000,
  maxQueryDurationMs: 30_000,
  maxRowBytes: 2_000_000,
});

/** 配置缺失：人话错误，调用方应据此给出「去配哪个环境变量」的提示。 */
export class D1ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'D1ConfigError';
  }
}

/**
 * D1 调用失败：携带 HTTP 状态码与 D1 返回的 errors[]，便于排查。
 * secret 只用于构造时给 errors[] 打码，不会被保存到实例上。
 */
export class D1ApiError extends Error {
  constructor(message, { status = null, errors = [], label = '', sql = '', secret = '' } = {}) {
    super(message);
    this.name = 'D1ApiError';
    this.status = status;
    // errors 里可能回显请求头中的 token：构造时就打码，调用方直接打印 / 序列化也不会泄露。
    this.errors = scrubErrorPayload(errors, secret);
    this.label = label;
    this.sql = sql;
  }
}

/** 把敏感字串从任意文本里抹掉（用于错误信息兜底）。 */
export function scrubSecret(text, secret) {
  const value = String(text ?? '');
  if (!secret) return value;
  return value.split(String(secret)).join('[REDACTED]');
}

/**
 * 把 D1 返回的 errors[] 里的字符串值统一打码，结构（数组 / 对象 / 键顺序）原样保留。
 * 只改字符串值、不改 code 等非字符串字段，调用方仍可按 code 判断；
 * 这样 JSON.stringify(error.errors) 也不会再包含 token。
 */
export function scrubErrorPayload(errors, secret) {
  if (!Array.isArray(errors)) return [];
  const scrubValue = (value) => {
    if (typeof value === 'string') return scrubSecret(value, secret);
    if (Array.isArray(value)) return value.map(scrubValue);
    if (value && typeof value === 'object') {
      const copy = {};
      for (const [key, item] of Object.entries(value)) copy[key] = scrubValue(item);
      return copy;
    }
    return value;
  };
  return errors.map(scrubValue);
}

/** SQL 单行预览：只保留前 160 个字符，避免错误信息被超长 SQL 淹没。 */
export function sqlPreview(sql, maxLength = 160) {
  const oneLine = String(sql ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine;
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

function assertSqlSize(sql, label) {
  const bytes = byteLength(sql);
  if (bytes > D1_LIMITS.maxSqlBytes) {
    throw new D1ConfigError(
      `${label}失败：单条 SQL 有 ${bytes} 字节，超过 D1 上限 ${D1_LIMITS.maxSqlBytes} 字节，请拆分成多批。`
    );
  }
}

/**
 * 把 JS 值转成 D1 绑定参数。
 * 官方把 params 标注为 array of string，因此统一转字符串；NULL 无法通过 params 表达，
 * 需要在 SQL 里内联 NULL（"参数绑定"与"SQL 字面量"两种写法在调用方选择）。
 */
export function toD1Params(params = []) {
  if (!Array.isArray(params)) throw new D1ConfigError('D1 参数必须是数组。');
  return params.map((value) => {
    if (value === null || value === undefined) {
      throw new D1ConfigError(
        'D1 的 params 官方标注为 array of string，无法表达 SQL NULL；请在 SQL 里内联 NULL 字面量。'
      );
    }
    if (typeof value === 'string') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new D1ConfigError(`D1 参数不能是 ${String(value)}。`);
      return String(value);
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'boolean') return value ? '1' : '0';
    throw new D1ConfigError(`不支持的 D1 参数类型：${typeof value}（只支持 string / number / bigint / boolean）。`);
  });
}

function maskIdentifier(value) {
  const text = String(value ?? '');
  if (text.length <= 10) return '****';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * 创建 D1 REST 客户端。
 * @param {object} options
 * @param {string} options.accountId   Cloudflare 账号 ID
 * @param {string} options.databaseId  D1 数据库 UUID
 * @param {string} options.token       API Token（只用于 Authorization 头）
 * @param {Function} [options.fetchImpl] 可注入的 fetch（mock 测试用）
 * @param {string} [options.baseUrl]   API 根地址
 * @param {number} [options.timeoutMs] 单次请求超时
 */
export function createD1Client({
  accountId,
  databaseId,
  token,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!accountId) throw new D1ConfigError(`${D1_ENV.accountId} 未设置。`);
  if (!databaseId) throw new D1ConfigError(`${D1_ENV.databaseId} 未设置。`);
  if (!token) throw new D1ConfigError(`${D1_ENV.token} 未设置。`);
  if (typeof fetchImpl !== 'function') throw new D1ConfigError('fetch 不可用：请使用 Node 18+ 或在 options.fetchImpl 传入实现。');

  const root = String(baseUrl).replace(/\/+$/, '');
  const databasePath = `${root}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}`;
  const queryUrl = `${databasePath}/query`;
  const exportUrl = `${databasePath}/export`;
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  const scrub = (text) => scrubSecret(text, token);

  /** 统一构造带打码 secret 的 D1ApiError，避免每个调用点都手写 secret: token。 */
  const apiError = (message, options = {}) => new D1ApiError(message, { ...options, secret: token });

  const formatErrors = (errors) => {
    if (!Array.isArray(errors) || errors.length === 0) return '';
    return errors
      .map((error) => `${scrub(String(error?.code ?? '?'))}: ${scrub(String(error?.message ?? ''))}`)
      .join('；');
  };

  /**
   * 发一个 POST JSON 请求并完成「HTTP + D1 信封」两层校验。
   * 失败信息包含：哪个请求、HTTP 状态码、D1 返回的 errors、SQL 预览；永不包含 token。
   */
  async function postJson(url, body, { label, sql = '' }) {
    const controller = new AbortController();
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          apiError(`${label}失败：请求超时（超过 ${effectiveTimeout} ms）。POST ${url}`, {
            label,
            sql,
          })
        );
      }, effectiveTimeout);
      if (typeof timer.unref === 'function') timer.unref();
    });

    let response;
    let text;
    try {
      // ⚠ 超时必须同时覆盖「等响应头」与「读响应体」：
      //    只 race fetch() 的话，服务端回了响应头、body 却迟迟不结束时，请求会一直挂着。
      //    AbortSignal 通常也能中断 body 读取，但注入的 fetch / 代理实现未必，所以这里用
      //    Promise.race 兜底；超时后 controller.abort() 仍会尝试中止底层请求。
      ({ response, text } = await Promise.race([
        (async () => {
          const res = await fetchImpl(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          return { response: res, text: await res.text() };
        })(),
        timeoutPromise,
      ]));
    } catch (error) {
      if (error instanceof D1ApiError) throw error;
      const reason =
        error?.name === 'AbortError'
          ? `请求被中止（可能超过 ${effectiveTimeout} ms）`
          : `网络错误：${scrub(error?.message ?? String(error))}`;
      throw apiError(`${label}失败：${reason}。POST ${url}`, { label, sql });
    } finally {
      if (timer) clearTimeout(timer);
    }

    let payload = null;
    try {
      payload = text.trim() ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail = payload ? formatErrors(payload.errors) : `响应不是 JSON：${scrub(text).slice(0, 200)}`;
      throw apiError(`${label}失败：HTTP ${response.status}${detail ? `，D1 返回：${detail}` : ''}。POST ${url}`, {
        status: response.status,
        errors: Array.isArray(payload?.errors) ? payload.errors : [],
        label,
        sql,
      });
    }

    if (!payload) {
      throw apiError(`${label}失败：HTTP ${response.status} 但响应体不是 JSON：${scrub(text).slice(0, 200)}`, {
        status: response.status,
        label,
        sql,
      });
    }

    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (payload.success !== true || errors.length > 0) {
      throw apiError(
        `${label}失败：D1 返回 success=${String(payload.success)}${errors.length > 0 ? `，错误：${formatErrors(errors)}` : ''}。POST ${url}`,
        { status: response.status, errors, label, sql }
      );
    }

    return payload;
  }

  function readResults(payload, { label, sql, expectedCount = null }) {
    const results = Array.isArray(payload?.result) ? payload.result : [];
    if (results.length === 0) {
      throw apiError(`${label}失败：响应里没有 result 数组（SQL：${sqlPreview(sql)}）。`, { label, sql });
    }
    if (expectedCount !== null && results.length !== expectedCount) {
      throw apiError(
        `${label}失败：请求 ${expectedCount} 条语句，D1 返回 ${results.length} 个结果集（SQL 预览：${sqlPreview(sql)}）。`,
        { label, sql }
      );
    }
    return results;
  }

  function normalizeResult(result, index, { label, sql }) {
    if (result?.success === false) {
      const errors = Array.isArray(result?.errors) ? result.errors : [];
      const detail = formatErrors(errors);
      throw apiError(
        `${label}失败：第 ${index + 1} 条语句未成功${detail ? `，错误：${detail}` : ''}（SQL 预览：${sqlPreview(sql)}）。`,
        { errors, label, sql }
      );
    }
    return {
      rows: Array.isArray(result?.results) ? result.results : [],
      meta: result?.meta && typeof result.meta === 'object' ? result.meta : {},
    };
  }

  /** 执行单条 SQL；多语句请用 execute()。返回第一组结果。 */
  async function query(sql, params = []) {
    assertSqlSize(sql, '查询 D1');
    const boundParams = toD1Params(params);
    if (boundParams.length > D1_LIMITS.maxBoundParamsPerQuery) {
      throw new D1ConfigError(
        `查询 D1 失败：绑定参数 ${boundParams.length} 个，超过 D1 上限 ${D1_LIMITS.maxBoundParamsPerQuery} 个。`
      );
    }
    const payload = await postJson(queryUrl, { sql, params: boundParams }, { label: '查询 D1', sql });
    const results = readResults(payload, { label: '查询 D1', sql });
    return normalizeResult(results[0], 0, { label: '查询 D1', sql });
  }

  /** 执行可能包含多条语句的 SQL（schema 建表等）；返回每组结果。 */
  async function execute(sql) {
    assertSqlSize(sql, '执行 D1 SQL');
    const payload = await postJson(queryUrl, { sql }, { label: '执行 D1 SQL', sql });
    const results = readResults(payload, { label: '执行 D1 SQL', sql });
    return results.map((result, index) => normalizeResult(result, index, { label: '执行 D1 SQL', sql }));
  }

  /**
   * 批量执行多条独立语句（单个 HTTP 请求带 batch，D1 会按批执行）。
   * 每批语句数默认 20：既减少往返，又避免单请求过大；每条语句仍受 SQL 100 KB / 参数 100 个限制。
   */
  async function batch(statements, { perRequest = DEFAULT_BATCH_STATEMENTS_PER_REQUEST } = {}) {
    if (!Array.isArray(statements)) throw new D1ConfigError('batch() 需要语句数组。');
    if (statements.length === 0) return [];

    const chunkSize = Number.isFinite(perRequest) && perRequest > 0 ? Math.floor(perRequest) : DEFAULT_BATCH_STATEMENTS_PER_REQUEST;
    const results = [];

    for (let start = 0; start < statements.length; start += chunkSize) {
      const chunk = statements.slice(start, start + chunkSize);
      const payloadStatements = chunk.map((statement) => {
        if (typeof statement === 'string') {
          assertSqlSize(statement, '批量执行 D1');
          return { sql: statement, params: [] };
        }
        assertSqlSize(statement?.sql, '批量执行 D1');
        const params = toD1Params(statement?.params ?? []);
        if (params.length > D1_LIMITS.maxBoundParamsPerQuery) {
          throw new D1ConfigError(
            `批量执行 D1 失败：某条语句绑定参数 ${params.length} 个，超过 D1 上限 ${D1_LIMITS.maxBoundParamsPerQuery} 个。`
          );
        }
        return { sql: statement?.sql, params };
      });

      const label = `批量执行 D1（本请求 ${chunk.length} 条语句）`;
      const payload = await postJson(queryUrl, { batch: payloadStatements }, { label });
      const chunkResults = readResults(payload, { label, sql: payloadStatements[0]?.sql ?? '', expectedCount: chunk.length });
      chunkResults.forEach((result, index) => {
        results.push(
          normalizeResult(result, start + index, { label, sql: payloadStatements[index]?.sql ?? '' })
        );
      });
    }

    return results;
  }

  /**
   * 分批读全表：D1 的 HTTP 接口没有游标，这里用 LIMIT/OFFSET 逐页读取。
   *
   * ⚠️ 一致性说明：
   *   · OFFSET 分页在「两次查询之间数据被写入/删除」时可能漏行或重复；
   *   · 构建期同步是只读且写入只来自本工具（不会并发），因此足够；
   *   · 若数据可能并发变化，请改用 selectAllKeyset()（键集分页）避免漏行/重复。
   *
   * @param {string} sql 不含 LIMIT/OFFSET 的 SELECT，建议带确定性 ORDER BY（如 ORDER BY id）
   */
  async function selectAll(sql, params = [], { pageSize = DEFAULT_PAGE_SIZE, maxPages = 10_000 } = {}) {
    const baseSql = String(sql ?? '').trim().replace(/;\s*$/, '');
    if (!baseSql) throw new D1ConfigError('selectAll() 需要一条 SELECT 语句。');
    if (/\b(limit|offset)\b/i.test(baseSql)) {
      throw new D1ConfigError('selectAll() 的 SQL 不能自带 LIMIT/OFFSET，分页由本方法追加。');
    }
    const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE;
    const rows = [];
    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * size;
      const { rows: pageRows } = await query(`${baseSql} LIMIT ${size} OFFSET ${offset}`, params);
      rows.push(...pageRows);
      if (pageRows.length < size) return rows;
    }
    throw new D1ConfigError(`selectAll() 读取超过 ${maxPages} 页仍未结束：${sqlPreview(baseSql)}`);
  }

  /**
   * 键集分页（keyset pagination）：按单调递增的 key 逐页读取，数据并发变化时不会漏行/重复。
   *
   * ⚠ 第一页没有「上一页」，不能沿用带 cursor 条件的 SQL：否则占位符会比绑定参数多一个，
   *   D1 会直接拒绝（旧实现正是这个缺陷）。因此调用方必须给两条 SQL：
   *     · firstPageSql：第一页用，不含 cursor 条件；
   *     · sql：后续页用，最后一个 ? 绑定「上一页最后一个 key」。
   *   两者的其余 params 相同，都只传「除 cursor 以外」的参数。
   *
   * 例：sql          = 'SELECT * FROM items WHERE group_id = ? AND id > ? ORDER BY id'
   *     firstPageSql = 'SELECT * FROM items WHERE group_id = ? ORDER BY id'
   *     params       = [group_id]
   *     → 第一页发 firstPageSql + [group_id]；
   *       之后把上一页最后一个 key 追加为最后一个绑定参数，发 sql + [group_id, lastKey]。
   *
   * 从中间续读时可只给 sql + lastKey（不传 firstPageSql）。
   */
  async function selectAllKeyset({
    sql,
    firstPageSql = '',
    keyParam,
    lastKey = null,
    params = [],
    pageSize = DEFAULT_PAGE_SIZE,
    maxPages = 10_000,
  } = {}) {
    const baseSql = String(sql ?? '').trim().replace(/;\s*$/, '');
    if (!baseSql) throw new D1ConfigError('selectAllKeyset() 需要一条 SELECT 语句。');
    if (typeof keyParam !== 'string' || keyParam.length === 0) {
      throw new D1ConfigError('selectAllKeyset() 需要 keyParam：即 SQL 里用于比较的 key 字段名（如 id）。');
    }
    const firstSql = String(firstPageSql ?? '').trim().replace(/;\s*$/, '');
    let cursor = lastKey;
    if ((cursor === null || cursor === undefined) && !firstSql) {
      throw new D1ConfigError(
        'selectAllKeyset() 第一页必须提供 firstPageSql（不含 cursor 占位符的 SQL）：' +
          '第一页没有上一页，若沿用带 cursor 条件的 sql，占位符会比绑定参数多一个，D1 会拒绝执行。' +
          `例：firstPageSql = "SELECT * FROM items WHERE group_id = ? ORDER BY id"；sql 预览：${sqlPreview(baseSql)}`
      );
    }
    const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE;
    const rows = [];
    for (let page = 0; page < maxPages; page += 1) {
      const isFirst = cursor === null || cursor === undefined;
      const pageSql = `${isFirst ? firstSql : baseSql} LIMIT ${size}`;
      const bound = isFirst ? [...params] : [...params, cursor];
      const { rows: pageRows } = await query(pageSql, bound);
      rows.push(...pageRows);
      if (pageRows.length < size) return rows;
      cursor = pageRows[pageRows.length - 1]?.[keyParam];
      if (cursor === undefined || cursor === null) {
        throw new D1ConfigError(`selectAllKeyset() 无法从行里取到 key 字段「${keyParam}」，请检查 SQL 的 SELECT 列。`);
      }
    }
    throw new D1ConfigError(`selectAllKeyset() 读取超过 ${maxPages} 页仍未结束：${sqlPreview(baseSql)}`);
  }

  /**
   * 用官方 Export API 导出整库 SQL（polling 模式）。
   * @returns {Promise<{ sql: string, filename: string }>}
   */
  async function exportSql({
    tables = null,
    noData = false,
    noSchema = false,
    pollIntervalMs = 1000,
    maxPollAttempts = 120,
    downloadFetch = fetchImpl,
  } = {}) {
    const body = { output_format: 'polling' };
    if (Array.isArray(tables) && tables.length > 0) body.dump_options = { tables };
    if (noData || noSchema) {
      body.dump_options = {
        ...(body.dump_options ?? {}),
        ...(noData ? { no_data: true } : {}),
        ...(noSchema ? { no_schema: true } : {}),
      };
    }

    let payload = await postJson(exportUrl, body, { label: 'D1 导出（发起）' });

    // 轮询边界：
    //   · 发起响应本身可能就是 complete，所以循环每次都先检查「当前手里的响应」；
    //   · 最多再发 maxPollAttempts 次轮询，标签是「轮询 n/maxPollAttempts」；
    //   · 第 maxPollAttempts 次轮询的响应仍会被检查（complete 必须被采用），
    //     只有它仍未完成才退出循环报超时 —— 旧实现多跑一轮，会多发一次请求并把最后一轮响应丢掉。
    for (let poll = 0; poll <= maxPollAttempts; poll += 1) {
      const task = payload?.result ?? {};
      if (task.status === 'complete') {
        const file = task.result ?? {};
        if (!file.signed_url) {
          throw apiError(`D1 导出失败：状态 complete 但缺少下载地址（filename：${file.filename ?? '未知'}）。`, {
            label: 'D1 导出',
          });
        }
        // signed_url 是一次性下载凭据，不打印、不写日志。
        const response = await downloadFetch(file.signed_url, { method: 'GET' });
        const text = await response.text();
        if (!response.ok) {
          throw apiError(
            `D1 导出下载失败：HTTP ${response.status}（filename：${file.filename ?? '未知'}）。`,
            { status: response.status, label: 'D1 导出' }
          );
        }
        return { sql: text, filename: typeof file.filename === 'string' ? file.filename : 'd1-export.sql' };
      }
      if (task.status === 'error' || task.error) {
        throw apiError(`D1 导出失败：${scrub(String(task.error ?? '状态 error 但未提供原因'))}`, {
          label: 'D1 导出',
        });
      }
      if (poll === maxPollAttempts) break;
      await sleep(pollIntervalMs);
      const pollBody = { ...body };
      if (task.at_bookmark) pollBody.current_bookmark = task.at_bookmark;
      payload = await postJson(exportUrl, pollBody, { label: `D1 导出（轮询 ${poll + 1}/${maxPollAttempts}）` });
    }

    throw apiError(`D1 导出超时：轮询 ${maxPollAttempts} 次仍未完成。`, { label: 'D1 导出' });
  }

  return {
    accountId,
    databaseId,
    timeoutMs: effectiveTimeout,
    query,
    execute,
    batch,
    selectAll,
    selectAllKeyset,
    exportSql,
    /** 安全摘要：只显示打码后的数据库 ID，绝不包含 token。 */
    describe: () => `Cloudflare D1（database ${maskIdentifier(databaseId)}）`,
  };
}

/**
 * 从环境变量创建客户端。
 * 只读场景需要 Token 具备 D1 Read 权限；推送（写入）需要 D1 Edit 权限。
 */
export function createD1ClientFromEnv({ env = process.env, fetchImpl, timeoutMs, baseUrl } = {}) {
  const accountId = String(env?.[D1_ENV.accountId] ?? '').trim();
  const databaseId = String(env?.[D1_ENV.databaseId] ?? '').trim();
  const token = String(env?.[D1_ENV.token] ?? '').trim();

  const missing = [];
  if (!accountId) missing.push(D1_ENV.accountId);
  if (!databaseId) missing.push(D1_ENV.databaseId);
  if (!token) missing.push(D1_ENV.token);

  if (missing.length > 0) {
    throw new D1ConfigError(
      [
        `缺少 D1 凭据环境变量：${missing.join('、')}`,
        '这些值只从环境变量读取，不要写进仓库、不要提交 .env：',
        `  ${D1_ENV.accountId}=<Cloudflare 账号 ID>`,
        `  ${D1_ENV.databaseId}=<D1 数据库 UUID>`,
        `  ${D1_ENV.token}=<API Token；只读取数用 D1 Read，推送需要 D1 Edit>`,
        'PowerShell 示例：$env:CLOUDFLARE_API_TOKEN="..."（当前会话有效）',
      ].join('\n')
    );
  }

  const envTimeout = Number(env?.[D1_ENV.timeoutMs] ?? '');
  const effectiveTimeout = timeoutMs
    ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);

  return createD1Client({
    accountId,
    databaseId,
    token,
    fetchImpl,
    baseUrl: baseUrl ?? (env?.[D1_ENV.baseUrl] || DEFAULT_BASE_URL),
    timeoutMs: effectiveTimeout,
  });
}
