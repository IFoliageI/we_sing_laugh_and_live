// ============================================================
//  d1-client.mjs 单元测试（只用 mock fetch，绝不发真实网络请求）
//  覆盖：环境变量校验、官方 URL/请求头/请求体形状、两层响应解析、
//        密钥打码（message + errors[]）、SQL 预览、超时中止（含 response.text()）、
//        批量分块与上限校验、键集分页、导出轮询边界。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  D1ApiError,
  D1ConfigError,
  D1_ENV,
  D1_LIMITS,
  createD1Client,
  createD1ClientFromEnv,
  scrubSecret,
  sqlPreview,
  toD1Params,
} from '../scripts/lib/d1-client.mjs';

const ACCOUNT_ID = 'acct-test';
const DATABASE_ID = 'db-test';
const TOKEN = 'env-token-should-never-leak';
const BASE_URL = 'https://d1.example.test/client/v4';
const QUERY_URL = `${BASE_URL}/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

// ---------- mock fetch 与官方响应外壳 ----------

/** 官方 D1 响应：行数据在 result[i].results（两层嵌套）。 */
function envelope(results, { success = true, errors = [] } = {}) {
  return { success, errors, messages: [], result: results };
}

function resultSet(rows = [], meta = {}) {
  return { success: true, results: rows, meta };
}

/** 只实现客户端实际用到的 Response 接口：ok / status / text()。 */
function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(payload) };
}

/**
 * 记录请求的 mock fetch。
 * handler(call, index) 返回假 Response，抛出异常可模拟网络失败。
 * call.body 已解析为对象，便于断言请求体形状。
 */
function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function makeClient(fetchImpl, overrides = {}) {
  return createD1Client({
    accountId: ACCOUNT_ID,
    databaseId: DATABASE_ID,
    token: TOKEN,
    fetchImpl,
    baseUrl: BASE_URL,
    ...overrides,
  });
}

/**
 * Export API 的 mock fetch：
 *  · POST .../export 依次返回 responses 里的下一项，超出后复用最后一项；
 *  · GET signed_url（下载）返回一份假 SQL。
 * responses 每项：{ result: {...} } 或 { httpStatus: 500, errors: [...] }。
 */
function exportFetch(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'GET') {
      return { ok: true, status: 200, text: async () => '-- 假 D1 导出 SQL' };
    }
    const step = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (step.httpStatus) {
      return {
        ok: false,
        status: step.httpStatus,
        text: async () =>
          JSON.stringify({ success: false, errors: step.errors ?? [], messages: [], result: [] }),
      };
    }
    return {
      ok: true,
      status: 200,
      // 官方 Export 接口的 result 是对象（不是 query 接口那样的数组）。
      text: async () =>
        JSON.stringify({ success: true, errors: [], messages: [], result: step.result }),
    };
  };
  return { fetchImpl, calls };
}

function postsOf(calls) {
  return calls.filter((call) => call.init.method === 'POST');
}

// ---------- 配置 ----------

test('createD1ClientFromEnv 缺少凭据时抛 D1ConfigError 并列出变量名', () => {
  assert.throws(
    () => createD1ClientFromEnv({ env: {} }),
    (error) => {
      assert.ok(error instanceof D1ConfigError);
      assert.equal(error.name, 'D1ConfigError');
      assert.equal(
        error.message.split('\n')[0],
        `缺少 D1 凭据环境变量：${D1_ENV.accountId}、${D1_ENV.databaseId}、${D1_ENV.token}`
      );
      return true;
    }
  );

  // 空白值视同未设置；其余已设置的变量不重复列入缺失清单。
  assert.throws(
    () =>
      createD1ClientFromEnv({
        env: {
          [D1_ENV.accountId]: ACCOUNT_ID,
          [D1_ENV.databaseId]: '   ',
          [D1_ENV.token]: TOKEN,
        },
      }),
    (error) => {
      assert.ok(error instanceof D1ConfigError);
      assert.equal(error.message.split('\n')[0], `缺少 D1 凭据环境变量：${D1_ENV.databaseId}`);
      return true;
    }
  );
});

test('createD1ClientFromEnv 读取凭据/基地址/超时，请求 URL、方法与头符合官方规格', async () => {
  const { fetchImpl, calls } = recordingFetch(() =>
    jsonResponse(envelope([resultSet([{ n: 1 }], { rows_read: 1 })]))
  );
  const client = createD1ClientFromEnv({
    env: {
      [D1_ENV.accountId]: ACCOUNT_ID,
      [D1_ENV.databaseId]: DATABASE_ID,
      [D1_ENV.token]: TOKEN,
      // 末尾多个斜杠必须被去掉，避免出现 //accounts。
      [D1_ENV.baseUrl]: `${BASE_URL}///`,
      [D1_ENV.timeoutMs]: '1500',
    },
    fetchImpl,
  });

  assert.equal(client.accountId, ACCOUNT_ID);
  assert.equal(client.databaseId, DATABASE_ID);
  assert.equal(client.timeoutMs, 1500);

  const { rows, meta } = await client.query('SELECT 1 AS n');
  assert.deepEqual(rows, [{ n: 1 }]);
  assert.deepEqual(meta, { rows_read: 1 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, QUERY_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  // 单条查询体只有 { sql, params }。
  assert.deepEqual(calls[0].body, { sql: 'SELECT 1 AS n', params: [] });
  assert.ok(calls[0].init.signal instanceof AbortSignal, '应传入 AbortSignal 以便超时中止');
  assert.equal(calls[0].init.signal.aborted, false);

  // describe() 只暴露打码后的数据库 ID，不含 token。
  assert.match(client.describe(), /^Cloudflare D1（database \*{4}）$/);
  assert.equal(client.describe().includes(TOKEN), false);
});

test('账号 ID 与数据库 ID 在 URL 中按路径段编码', async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(envelope([resultSet([])])));
  const client = createD1Client({
    accountId: 'acct/with space',
    databaseId: 'db/with space',
    token: TOKEN,
    fetchImpl,
    baseUrl: `${BASE_URL}/`,
  });

  await client.query('SELECT 1');
  assert.equal(
    calls[0].url,
    `${BASE_URL}/accounts/acct%2Fwith%20space/d1/database/db%2Fwith%20space/query`
  );
});

// ---------- 绑定参数 ----------

test('toD1Params 把数字/布尔/大整数统一转成字符串', () => {
  assert.deepEqual(
    toD1Params(['文本', 12.5, 0, -3, true, false, 42n]),
    ['文本', '12.5', '0', '-3', '1', '0', '42']
  );
  assert.deepEqual(toD1Params(), [], '缺省参数为空数组');
});

test('toD1Params 拒绝无法用字符串参数表达的值', () => {
  for (const value of [null, undefined]) {
    assert.throws(
      () => toD1Params([value]),
      (error) => {
        assert.ok(error instanceof D1ConfigError);
        assert.match(error.message, /array of string|NULL/);
        return true;
      }
    );
  }
  for (const value of [NaN, Infinity, -Infinity, {}, [], Symbol('x')]) {
    assert.throws(() => toD1Params([value]), D1ConfigError);
  }
  assert.throws(() => toD1Params('不是数组'), /必须是数组/);
});

// ---------- 请求体形状 ----------

test('batch 的请求体是 { batch: [...] }，按 perRequest 分块且语句顺序不变', async () => {
  const { fetchImpl, calls } = recordingFetch((call) =>
    jsonResponse(
      envelope(
        call.body.batch.map((statement) => resultSet([{ sql: statement.sql }]))
      )
    )
  );
  const client = makeClient(fetchImpl);

  const results = await client.batch(
    [
      { sql: 'INSERT INTO t (a, b) VALUES (?, ?)', params: [1, true] },
      'UPDATE t SET a = 2',
      { sql: 'DELETE FROM t WHERE a = ?', params: ['x'] },
    ],
    { perRequest: 2 }
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, {
    batch: [
      { sql: 'INSERT INTO t (a, b) VALUES (?, ?)', params: ['1', '1'] },
      { sql: 'UPDATE t SET a = 2', params: [] },
    ],
  });
  assert.deepEqual(calls[1].body, {
    batch: [{ sql: 'DELETE FROM t WHERE a = ?', params: ['x'] }],
  });
  assert.deepEqual(
    results.map((result) => result.rows),
    [
      [{ sql: 'INSERT INTO t (a, b) VALUES (?, ?)' }],
      [{ sql: 'UPDATE t SET a = 2' }],
      [{ sql: 'DELETE FROM t WHERE a = ?' }],
    ]
  );
});

test('batch 要求 D1 为每条语句各返回一个结果集', async () => {
  const { fetchImpl, calls } = recordingFetch(() =>
    jsonResponse(envelope([resultSet([])]))
  );
  const client = makeClient(fetchImpl);

  await assert.rejects(
    client.batch(['SELECT 1', 'SELECT 2']),
    (error) => {
      assert.ok(error instanceof D1ApiError);
      assert.match(error.message, /请求 2 条语句，D1 返回 1 个结果集/);
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test('execute 的请求体是 { sql }（多语句），并返回每组结果', async () => {
  const { fetchImpl, calls } = recordingFetch(() =>
    jsonResponse(
      envelope([resultSet([], { changes: 0 }), resultSet([{ id: 1 }], { last_row_id: 1 })])
    )
  );
  const client = makeClient(fetchImpl);
  const sql = 'CREATE TABLE t (id INTEGER); INSERT INTO t DEFAULT VALUES;';

  const results = await client.execute(sql);
  assert.deepEqual(calls[0].body, { sql }, 'execute 不发送 params 字段');
  assert.deepEqual(results.map((result) => result.rows), [[], [{ id: 1 }]]);
  assert.deepEqual(results[1].meta, { last_row_id: 1 });
});

// ---------- 响应解析与失败路径 ----------

test('顶层 success=false、errors[] 非空或 result[i].success=false 均抛 D1ApiError', async () => {
  const topLevel = makeClient(
    recordingFetch(() =>
      jsonResponse(
        envelope([], { success: false, errors: [{ code: 1001, message: 'SQL 错误' }] })
      )
    ).fetchImpl
  );
  await assert.rejects(topLevel.query('SELECT 1'), (error) => {
    assert.ok(error instanceof D1ApiError);
    assert.equal(error.status, 200);
    assert.equal(error.errors[0].code, 1001);
    assert.match(error.message, /success=false/);
    assert.match(error.message, /SQL 错误/);
    return true;
  });

  // success=true 但 errors[] 非空：按官方约定仍视为失败。
  const withErrors = makeClient(
    recordingFetch(() =>
      jsonResponse(envelope([resultSet([])], { errors: [{ code: 1002, message: '部分失败' }] }))
    ).fetchImpl
  );
  await assert.rejects(withErrors.query('SELECT 1'), (error) => {
    assert.ok(error instanceof D1ApiError);
    assert.match(error.message, /部分失败/);
    return true;
  });

  // 单条语句自己的 success=false 不能被外层 success=true 掩盖。
  const nested = makeClient(
    recordingFetch(() =>
      jsonResponse(
        envelope([{ success: false, errors: [{ code: 1003, message: '语句失败' }], results: [] }])
      )
    ).fetchImpl
  );
  await assert.rejects(nested.query('SELECT 1'), (error) => {
    assert.ok(error instanceof D1ApiError);
    assert.match(error.message, /第 1 条语句未成功/);
    return true;
  });
});

test('HTTP 错误、非 JSON 响应与缺失 result 数组都抛 D1ApiError', async () => {
  const unauthorized = makeClient(
    recordingFetch(() => ({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({ success: false, errors: [{ code: 401, message: '未授权' }], result: [] }),
    })).fetchImpl
  );
  await assert.rejects(unauthorized.query('SELECT 1'), (error) => {
    assert.ok(error instanceof D1ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.errors.length, 1);
    assert.match(error.message, /HTTP 401/);
    assert.match(error.message, /未授权/);
    return true;
  });

  const http500 = makeClient(
    recordingFetch(() => ({ ok: false, status: 500, text: async () => 'gateway down' })).fetchImpl
  );
  await assert.rejects(http500.query('SELECT 1'), (error) => {
    assert.ok(error instanceof D1ApiError);
    assert.equal(error.status, 500);
    assert.match(error.message, /HTTP 500/);
    assert.match(error.message, /响应不是 JSON/);
    return true;
  });

  const notJson = makeClient(
    recordingFetch(() => ({ ok: true, status: 200, text: async () => 'not json' })).fetchImpl
  );
  await assert.rejects(notJson.query('SELECT 1'), /HTTP 200 但响应体不是 JSON/);

  const noResult = makeClient(recordingFetch(() => jsonResponse(envelope([]))).fetchImpl);
  await assert.rejects(noResult.query('SELECT 1'), /没有 result 数组/);
});

// ---------- 安全相关 ----------

test('scrubSecret 把密钥全部替换成 [REDACTED]', () => {
  assert.equal(
    scrubSecret('token=SECRET; again SECRET', 'SECRET'),
    'token=[REDACTED]; again [REDACTED]'
  );
  // 密钥里的正则元字符不能影响替换逻辑。
  assert.equal(scrubSecret('x a+b.*c y', 'a+b.*c'), 'x [REDACTED] y');
  // 未提供密钥时原样返回；null 输入转成空字符串。
  assert.equal(scrubSecret('abc', ''), 'abc');
  assert.equal(scrubSecret(null, 'SECRET'), '');
});

test('D1 与网络错误信息都不含原始 token', async () => {
  const echoed = makeClient(
    recordingFetch(() =>
      jsonResponse(
        envelope([], {
          success: false,
          errors: [{ code: 1000, message: `invalid token ${TOKEN}` }],
        })
      )
    ).fetchImpl
  );
  await assert.rejects(echoed.query('SELECT 1'), (error) => {
    assert.ok(error instanceof D1ApiError);
    assert.match(error.message, /\[REDACTED\]/);
    assert.equal(error.message.includes(TOKEN), false, '错误信息不得回显 token');
    return true;
  });

  const network = makeClient(async () => {
    throw new Error(`connect failed: ${TOKEN}`);
  });
  await assert.rejects(network.query('SELECT 1'), (error) => {
    assert.ok(error instanceof D1ApiError);
    assert.match(error.message, /网络错误/);
    assert.match(error.message, /\[REDACTED\]/);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
});

test('D1ApiError.errors 保留结构但字符串已打码，JSON.stringify 不含 token', async () => {
  const echoed = makeClient(
    recordingFetch(() =>
      jsonResponse(
        envelope([], {
          success: false,
          errors: [
            {
              code: 1000,
              message: `invalid token ${TOKEN}`,
              documentation_url: `https://d1.example.test/docs/${TOKEN}`,
              source: { pointer: `/authorization/${TOKEN}` },
            },
          ],
        })
      )
    ).fetchImpl
  );

  await assert.rejects(echoed.query('SELECT 1'), (error) => {
    assert.ok(error instanceof D1ApiError);
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].code, 1000, '非字符串字段保持原样');
    assert.equal(error.errors[0].message, 'invalid token [REDACTED]');
    assert.equal(error.errors[0].documentation_url, 'https://d1.example.test/docs/[REDACTED]');
    assert.deepEqual(error.errors[0].source, { pointer: '/authorization/[REDACTED]' });
    const serialized = JSON.stringify(error.errors);
    assert.equal(serialized.includes(TOKEN), false, '调用方打印 error.errors 也不能泄露 token');
    assert.match(serialized, /\[REDACTED\]/);
    return true;
  });
});

test('第 N 条语句未成功时，message 与 errors 都带已打码的子错误', async () => {
  const nested = makeClient(
    recordingFetch(() =>
      jsonResponse(
        envelope([
          {
            success: false,
            errors: [{ code: 1003, message: `statement failed for ${TOKEN}` }],
            results: [],
          },
        ])
      )
    ).fetchImpl
  );

  await assert.rejects(nested.query('SELECT 1'), (error) => {
    assert.ok(error instanceof D1ApiError);
    assert.match(error.message, /第 1 条语句未成功/);
    assert.match(error.message, /1003/, '错误信息要带出子错误 code');
    assert.match(error.message, /\[REDACTED\]/);
    assert.equal(error.message.includes(TOKEN), false);
    assert.equal(JSON.stringify(error.errors).includes(TOKEN), false);
    return true;
  });
});

test('sqlPreview 折叠空白并在超长时追加省略号', () => {
  assert.equal(sqlPreview('  SELECT\n\t*\nFROM   t  '), 'SELECT * FROM t');
  assert.equal(sqlPreview('x'.repeat(160)), 'x'.repeat(160), '恰好 160 字符不截断');
  assert.equal(sqlPreview('x'.repeat(161)), `${'x'.repeat(160)}…`);
  assert.equal(sqlPreview('abcdef', 3), 'abc…');
  assert.equal(sqlPreview(null), '');
});

// ---------- 超时与限制 ----------

test('超时会中止请求并抛 D1ApiError', async () => {
  let signal = null;
  const fetchImpl = (url, init) => {
    signal = init.signal;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };
  const client = makeClient(fetchImpl, { timeoutMs: 20 });

  await assert.rejects(client.query('SELECT 1'), (error) => {
    assert.ok(error instanceof D1ApiError);
    // 先收到中止还是先收到超时取决于事件顺序，两种说法都接受。
    assert.match(error.message, /请求超时|请求被中止/);
    return true;
  });
  assert.equal(signal.aborted, true, '超时必须通过 AbortSignal 中止底层请求');
});

test('超时同时覆盖 response.text()：body 一直不返回也会中止', async () => {
  let signal = null;
  const fetchImpl = (url, init) => {
    signal = init.signal;
    return Promise.resolve({
      ok: true,
      status: 200,
      // 永远不 resolve，模拟「响应头已到、body 卡住」；只 race fetch() 的旧实现会一直挂住。
      text: () => new Promise(() => {}),
    });
  };
  const client = makeClient(fetchImpl, { timeoutMs: 20 });

  await assert.rejects(client.query('SELECT 1'), (error) => {
    assert.ok(error instanceof D1ApiError);
    assert.match(error.message, /请求超时|请求被中止/);
    return true;
  });
  assert.equal(signal.aborted, true);
});

test('SQL 超过 100 KB 或绑定参数超过 100 个时在发请求前抛 D1ConfigError', async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(envelope([resultSet([])])));
  const client = makeClient(fetchImpl);

  const tooManyParams = Array.from({ length: D1_LIMITS.maxBoundParamsPerQuery + 1 }, (_, index) => index);
  await assert.rejects(client.query('SELECT 1', tooManyParams), D1ConfigError);

  const tooLongSql = `SELECT 1;${' '.repeat(D1_LIMITS.maxSqlBytes)}`;
  await assert.rejects(client.query(tooLongSql), D1ConfigError);

  assert.equal(calls.length, 0, '校验失败不应发起请求');
});

test('selectAll 自动追加 LIMIT/OFFSET 并拒绝自带分页的 SQL', async () => {
  const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }]];
  const { fetchImpl, calls } = recordingFetch((call, index) =>
    jsonResponse(envelope([resultSet(pages[index])]))
  );
  const client = makeClient(fetchImpl);

  const rows = await client.selectAll('SELECT * FROM t ORDER BY id', [], { pageSize: 2 });
  assert.deepEqual(rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.match(calls[0].body.sql, /LIMIT 2 OFFSET 0$/);
  assert.match(calls[1].body.sql, /LIMIT 2 OFFSET 2$/);

  await assert.rejects(
    client.selectAll('SELECT * FROM t LIMIT 5'),
    /不能自带 LIMIT\/OFFSET/
  );
});

// ---------- 键集分页 ----------

test('selectAllKeyset 第一页用 firstPageSql，后续页才绑定 cursor（回归：旧实现第一页参数数不匹配）', async () => {
  const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }]];
  const { fetchImpl, calls } = recordingFetch((call, index) =>
    jsonResponse(envelope([resultSet(pages[index])]))
  );
  const client = makeClient(fetchImpl);
  const sql = 'SELECT * FROM items WHERE group_id = ? AND id > ? ORDER BY id';
  const firstPageSql = 'SELECT * FROM items WHERE group_id = ? ORDER BY id';

  const rows = await client.selectAllKeyset({
    sql,
    firstPageSql,
    keyParam: 'id',
    params: ['voice'],
    pageSize: 2,
  });

  assert.deepEqual(rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(calls.length, 2);
  // 第一页只有 1 个占位符，就只绑 1 个参数；旧实现会拿 2 个占位符只绑 [voice]，D1 直接报错。
  assert.equal(calls[0].body.sql, `${firstPageSql} LIMIT 2`);
  assert.deepEqual(calls[0].body.params, ['voice']);
  // 后续页才用带 cursor 条件的 SQL，并把上一页最后一个 key 追加为最后一个参数。
  assert.equal(calls[1].body.sql, `${sql} LIMIT 2`);
  assert.deepEqual(calls[1].body.params, ['voice', '2'], 'cursor 按 D1 要求转成字符串');
});

test('selectAllKeyset 第一页未给 firstPageSql 时在发请求前抛 D1ConfigError', async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(envelope([resultSet([])])));
  const client = makeClient(fetchImpl);

  await assert.rejects(
    client.selectAllKeyset({
      sql: 'SELECT * FROM items WHERE group_id = ? AND id > ? ORDER BY id',
      keyParam: 'id',
      params: ['voice'],
    }),
    (error) => {
      assert.ok(error instanceof D1ConfigError);
      assert.match(error.message, /firstPageSql/);
      assert.match(error.message, /占位符/);
      return true;
    }
  );
  // 修复前会带着「2 个占位符 / 1 个参数」的 SQL 发请求，由 D1 报错；现在本地就拦截。
  assert.equal(calls.length, 0);
});

test('selectAllKeyset 从 lastKey 续读时直接用带 cursor 的 SQL', async () => {
  const { fetchImpl, calls } = recordingFetch(() =>
    jsonResponse(envelope([resultSet([{ id: 11 }])]))
  );
  const client = makeClient(fetchImpl);

  const rows = await client.selectAllKeyset({
    sql: 'SELECT * FROM items WHERE group_id = ? AND id > ? ORDER BY id',
    keyParam: 'id',
    lastKey: 10,
    params: ['voice'],
    pageSize: 2,
  });

  assert.deepEqual(rows, [{ id: 11 }]);
  assert.equal(
    calls[0].body.sql,
    'SELECT * FROM items WHERE group_id = ? AND id > ? ORDER BY id LIMIT 2'
  );
  assert.deepEqual(calls[0].body.params, ['voice', '10']);
});

// ---------- 导出轮询 ----------

test('exportSql 最后一次轮询返回 complete 时也会采用结果（修复 off-by-one）', async () => {
  const { fetchImpl, calls } = exportFetch([
    { result: { at_bookmark: 'b1', status: 'running' } },
    { result: { at_bookmark: 'b2', status: 'running' } },
    {
      result: {
        at_bookmark: 'b3',
        status: 'complete',
        result: { filename: 'd1-export.sql', signed_url: 'https://download.example.test/one-time' },
      },
    },
  ]);
  const client = makeClient(fetchImpl);

  const snapshot = await client.exportSql({ maxPollAttempts: 2, pollIntervalMs: 0 });
  assert.deepEqual(snapshot, { sql: '-- 假 D1 导出 SQL', filename: 'd1-export.sql' });

  const posts = postsOf(calls);
  assert.equal(posts.length, 3, '发起 1 次 + 最多 2 次轮询；修复前会发 4 次');
  assert.equal(posts[1].body.current_bookmark, 'b1');
  assert.equal(posts[2].body.current_bookmark, 'b2');
  assert.equal(calls.filter((call) => call.init.method === 'GET').length, 1, 'complete 后要下载一次');
});

test('exportSql 轮询标签不超过 maxPollAttempts，且不多发请求', async () => {
  const { fetchImpl, calls } = exportFetch([
    { result: { at_bookmark: 'b1', status: 'running' } },
    { result: { at_bookmark: 'b2', status: 'running' } },
    { httpStatus: 500, errors: [{ code: 500, message: '轮询失败' }] },
  ]);
  const client = makeClient(fetchImpl);

  await assert.rejects(client.exportSql({ maxPollAttempts: 2, pollIntervalMs: 0 }), (error) => {
    assert.ok(error instanceof D1ApiError);
    assert.match(error.message, /轮询 2\/2/);
    assert.equal(error.message.includes('3/2'), false, '标签不能出现「轮询 3/2」');
    return true;
  });
  // 修复前：发起 1 + 轮询 3（第三次标签是 3/2），本用例会看到 4 个 POST。
  assert.equal(postsOf(calls).length, 3);
});

test('exportSql 轮询到上限仍未完成时抛超时', async () => {
  const { fetchImpl, calls } = exportFetch([{ result: { at_bookmark: 'b1', status: 'running' } }]);
  const client = makeClient(fetchImpl);

  await assert.rejects(
    client.exportSql({ maxPollAttempts: 2, pollIntervalMs: 0 }),
    (error) => {
      assert.ok(error instanceof D1ApiError);
      assert.match(error.message, /D1 导出超时：轮询 2 次仍未完成/);
      return true;
    }
  );
  assert.equal(postsOf(calls).length, 3, '发起 1 次 + 2 次轮询，不会发第 3 次轮询');
});
