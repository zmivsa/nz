/*
 * Surge 脚本: WAI-AOVE (爱情商业) 优惠券查询 (Bark 推送版)
 * 功能: 查询账号下未使用的优惠券，并在发现时通过 Bark 发送通知（包含 Token）。
 *
 * 如何配置:
 * 1. 确保持久化存储中有账号信息:
 *    - Key: WEAIOVE_ACCOUNTS
 *    - 格式: token1|备注1@token2|备注2@...
 * 2. 在持久化存储中设置你的 Bark Key:
 *    - Key: BARK_KEY
 *    - Value: 你的 Bark 推送 Key (例如 https://api.day.app/YOUR_BARK_KEY/ 中的 YOUR_BARK_KEY)
 *
 * Surge 定时任务建议: 根据需要设置，例如每天检查一次 0 8 * * *
 */
const $ = new Env(); // 使用 Env 类简化 $httpClient, $persistentStore, $notification 的调用
// --- 全局配置与常量 ---
const BASE_URL = "https://vip.weaiove.com/api/minpro-api";
const APPKEY = "wx360959f2f6ecfb97";
const TENANT_ID = "1585937717626433537";
const PLAZA_ID = "1719238954936242177"; // 保留，因为 getUserDetails 可能需要
const ACCOUNTS_KEY = "WEAIOVE_ACCOUNTS";
const BARK_KEY_PERSIST_KEY = "BARK_KEY"; // 持久化存储中 Bark Key 的键名
// --- 主逻辑 ---
async function main() {
    const accountsStr = $.read(ACCOUNTS_KEY);
    const barkKey = $.read(BARK_KEY_PERSIST_KEY);
    if (!accountsStr) {
        $.error(`错误：未在 Surge 持久化存储中找到账号信息 (Key: ${ACCOUNTS_KEY})`);
        $.notify("❌ 爱情商业配置错误", "未找到账号配置", `请先确保存储了账号信息 (Key: ${ACCOUNTS_KEY})`);
        return;
    }
    if (!barkKey) {
        $.error(`错误：未在 Surge 持久化存储中找到 Bark Key (Key: ${BARK_KEY_PERSIST_KEY})`);
        $.notify("❌ 爱情商业配置错误", "未找到 Bark Key 配置", `请先确保存储了 Bark Key (Key: ${BARK_KEY_PERSIST_KEY})`);
        return;
    }
    const accounts = accountsStr.split('@')
        .map(acc => acc.trim())
        .filter(acc => acc)
        .map((acc, index) => {
            const parts = acc.split('|');
            if (parts.length !== 2 || !parts[0] || !parts[1]) {
                $.log(`账号 ${index + 1} 配置格式错误，已跳过: '${acc}'`);
                return null;
            }
            return { token: parts[0].trim(), name: parts[1].trim(), raw: acc };
        })
        .filter(acc => acc !== null);
    if (accounts.length === 0) {
        $.error("错误：未找到任何有效格式的账号配置。");
        $.notify("❌ 爱情商业配置错误", "未找到有效账号", `请检查持久化存储中 ${ACCOUNTS_KEY} 的格式是否为 token1|备注1@token2|备注2`);
        return;
    }
    const totalAccounts = accounts.length;
    $.log(`共找到 ${totalAccounts} 个有效账号配置。将为发现优惠券的账号发送 Bark 通知。`);
    for (let i = 0; i < totalAccounts; i++) {
        const account = accounts[i];
        const index = i + 1;
        const accountInfo = `账号 ${index} (${account.name})`;
        $.log(`\n--- 开始处理 ${accountInfo} ---`);
        const headers = {
            "Host": "vip.weaiove.com",
            "tenant-Id": TENANT_ID,
            "plaza-Id": PLAZA_ID, // 可能需要
            "appkey": APPKEY,
            "member-token": account.token,
            "content-type": "application/json;charset=utf-8",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.56(0x1800383b) NetType/WIFI Language/zh_CN",
            "Referer": `https://servicewechat.com/${APPKEY}/72/page-frame.html`
        };
        // 1. 获取 memberId (优惠券接口需要)
        const { memberId, errorMsg } = await getMemberIdOnly(headers, accountInfo);
        if (!memberId) {
            $.error(`${accountInfo}: 获取 Member ID 失败: ${errorMsg}，无法查询优惠券。`);
            if (errorMsg && (errorMsg.includes('Token') || errorMsg.includes('401'))) {
                 // 可以选择是否为 Token 失效单独发送 Bark 通知
                 // $.barkNotify(`⚠️ ${accountInfo} Token 可能失效`, `错误: ${errorMsg}\nToken: ${account.token}`, barkKey);
                 $.log(`[${accountInfo}] Token 可能失效，已跳过。`);
            }
        } else {
            // 2. 查询未使用优惠券，并在发现时发送 Bark 通知
            await checkUnusedCouponsAndNotify(headers, memberId, accountInfo, account.token, barkKey);
        }
        $.log(`--- ${accountInfo} 处理完毕 ---`);
        // 每个账号处理后等待一小段时间，防止请求过于频繁 (可选)
        await $.sleep(500); // 等待 500 毫秒
    }
    $.log("\n=== 所有账号处理完毕 ===");
}
// --- API 请求封装 (保持不变) ---
async function makeRequest(method, url, headers, body = null, accountInfo = "", actionDesc = "") {
    const options = {
        url: url,
        headers: headers,
        timeout: 20000 // 20 秒超时
    };
    if (method.toUpperCase() === 'POST') {
        options.method = 'POST';
        if (body) {
            options.body = JSON.stringify(body); // 确保 body 是字符串
        }
    } else if (method.toUpperCase() === 'GET') {
        options.method = 'GET';
    } else {
        $.error(`[${accountInfo}][${actionDesc}] 不支持的请求方法: ${method}`);
        return null;
    }
    // $.log(`[${accountInfo}][${actionDesc}] 发起 ${options.method} 请求到 ${url}`); // 请求日志可选开启
    return new Promise(resolve => {
        $[options.method.toLowerCase()](options, (error, response, data) => {
            try {
                if (error) {
                    $.error(`[${accountInfo}][${actionDesc}] 请求失败: ${error}`);
                     if (error.includes('timeout')) {
                        // 超时可以考虑 Bark 通知，但可能过多，先只 log
                        $.log(`[${accountInfo}] 操作 [${actionDesc}] 请求超时。`);
                    }
                    resolve(null);
                    return;
                }
                if (response.statusCode >= 400) {
                    $.error(`[${accountInfo}][${actionDesc}] HTTP 错误: 状态码 ${response.statusCode}`);
                    if (response.statusCode === 401) {
                        $.error(`[${accountInfo}][${actionDesc}] 认证失败 (401)，Token 可能已失效。`);
                        resolve({ code: 401, msg: 'Token 可能已失效' });
                    } else {
                        resolve(null);
                    }
                    return;
                }
                if (!data) {
                    // $.log(`[${accountInfo}][${actionDesc}] 请求成功，但响应体为空。`);
                    resolve({});
                    return;
                }
                let result;
                try {
                    result = JSON.parse(data);
                } catch (jsonError) {
                    $.error(`[${accountInfo}][${actionDesc}] 解析 JSON 响应失败。URL: ${url}`);
                    $.error(`响应内容 (前500字符): ${data.substring(0, 500)}...`);
                    resolve(null);
                    return;
                }
                 // $.log(`[${accountInfo}][${actionDesc}] 原始响应: ${JSON.stringify(result)}`); // 调试时取消注释
                if (result.code === 401) {
                     $.error(`[${accountInfo}][${actionDesc}] 请求失败 (业务码 ${result.code}): ${result.msg || 'Token 可能已失效'}`);
                     resolve(result);
                } else if (result.code !== 0 && result.code !== 200 && !result.successful) {
                     $.error(`[${accountInfo}][${actionDesc}] API 返回业务错误: Code=${result.code}, Msg=${result.msg || '无消息'}`);
                     resolve(result);
                } else {
                    resolve(result);
                }
            } catch (e) {
                $.error(`[${accountInfo}][${actionDesc}] 处理响应时发生内部错误: ${e}`);
                $.log(`错误发生在处理 URL: ${url}`);
                resolve(null);
            }
        });
    });
}
// --- 核心功能函数 (修改和简化) ---
// 仅获取 Member ID
async function getMemberIdOnly(headers, accountInfo) {
    const url = `${BASE_URL}/member/getAppById`;
    const result = await makeRequest('GET', url, headers, null, accountInfo, "获取用户 Member ID");
    if (result && result.code === 0 && result.successful) {
        const data = result.data || {};
        const memberId = data.memberId;
        if (memberId) {
            $.log(`[${accountInfo}] 获取到 Member ID: ${memberId}`);
            return { memberId, errorMsg: null };
        } else {
            $.error(`[${accountInfo}] 获取 Member ID 失败，响应数据中未找到 memberId。`);
            return { memberId: null, errorMsg: "未能从 API 获取到有效的 Member ID" };
        }
    } else {
        const errorMsg = result ? (result.msg || `业务码 ${result.code}`) : "请求失败或响应格式错误";
        $.error(`[${accountInfo}] 获取用户 Member ID API 请求失败: ${errorMsg}`);
        return { memberId: null, errorMsg: errorMsg }; // 返回错误信息
    }
}
// 查询未使用优惠券并在发现时发送 Bark 通知
async function checkUnusedCouponsAndNotify(headers, memberId, accountInfo, token, barkKey) {
    const url = `${BASE_URL}/member/getCopuonsPageList`;
    const payload = {
        pageSize: 50, // 查询数量适当增大
        pageNumber: 1,
        totalPages: "",
        memberId: memberId,
        businessType: "",
        status: 1 // 1 表示查询 "未使用" 的券
    };
    const result = await makeRequest('POST', url, headers, payload, accountInfo, "查询未使用优惠券");
    if (result && result.code === 0 && result.successful) {
        const data = result.data || {};
        const items = data.items;
        if (Array.isArray(items) && items.length > 0) {
            let couponNames = [];
            items.forEach(item => {
                if (item.couponsName) {
                    couponNames.push(`- ${item.couponsName}`); // 添加短横线和空格，便于阅读
                }
            });
            if (couponNames.length > 0) {
                $.log(`[${accountInfo}] 查询到 ${couponNames.length} 张未使用优惠券:`);
                couponNames.forEach(name => $.log(`  ${name}`)); // 日志记录
                // 发送 Bark 通知
                const barkTitle = `💖爱情商业: ${accountInfo} 有券!`;
                const barkBody = `发现 ${couponNames.length} 张未使用优惠券:\n${couponNames.join("\n")}\n\n账号Token:\n${token}`;
                await $.barkNotify(barkTitle, barkBody, barkKey);
            } else {
                 $.log(`[${accountInfo}] 响应数据中包含券列表，但未能提取到有效优惠券名称。`);
            }
        } else if (Array.isArray(items) && items.length === 0) {
            $.log(`[${accountInfo}] 未查询到未使用的优惠券。`);
        } else {
            $.log(`[${accountInfo}] 优惠券响应格式错误 (items 非列表或不存在)。`);
        }
    } else {
        const errorMsg = result ? (result.msg || `业务码 ${result.code}`) : '请求失败或响应格式错误';
        $.log(`[${accountInfo}] 查询优惠券请求失败: ${errorMsg}`);
        // 查询失败时一般不打扰用户
    }
}
// --- Env 类，简化 Surge API 调用 (增加 Bark 推送) ---
function Env() {
  const isSurge = typeof $httpClient !== 'undefined';
  const name = 'WAI-AOVE优惠券查询'; // 修改脚本名称
  const log = (message) => console.log(`[${name}] ${message}`);
  const error = (message) => console.error(`[${name}] ${message}`);
  const read = (key) => {
    if (isSurge) return $persistentStore.read(key);
    return undefined;
  };
  const write = (value, key) => {
    if (isSurge) return $persistentStore.write(value, key);
    return false;
  };
  // Surge 原生通知 (备用或调试)
  const notify = (title, subtitle = '', body = '') => {
    if (isSurge) {
      $notification.post(title, subtitle, body);
    } else {
      log(`\n【原生通知】\n标题: ${title}\n子标题: ${subtitle}\n内容:\n${body}\n`);
    }
  };
  // 新增：Bark 推送方法
  const barkNotify = async (title, body, barkKey, options = {}) => {
      if (!barkKey) {
          error("Bark Key 未配置，无法发送 Bark 通知。");
          return;
      }
      if (!isSurge) {
          log(`\n【Bark 通知模拟】\nKey: ${barkKey}\n标题: ${title}\n内容:\n${body}\n`);
          return;
      }
      // 基础 URL，用户只提供 Key
      let barkUrl = `https://api.day.app/${barkKey}`;
      // 尝试从持久化存储读取自定义 Bark 服务器地址
      const customBarkServer = read("BARK_SERVER");
      if (customBarkServer && customBarkServer.startsWith("http")) {
          barkUrl = customBarkServer.replace(/\/$/, '') + `/${barkKey}`; // 确保末尾没有斜杠再拼接
          log(`检测到自定义 Bark 服务器地址: ${customBarkServer}，将使用此地址。`);
      }
      // 对标题和内容进行 URL 编码
      const encodedTitle = encodeURIComponent(title);
      const encodedBody = encodeURIComponent(body);
      // 构建最终 URL
      let url = `${barkUrl}/${encodedTitle}/${encodedBody}`;
      // 处理可选参数 (例如 group, level, url, icon, sound 等)
      const queryParams = [];
      if (options.group) queryParams.push(`group=${encodeURIComponent(options.group)}`);
      if (options.level) queryParams.push(`level=${encodeURIComponent(options.level)}`); // active, timeSensitive, passive
      if (options.url) queryParams.push(`url=${encodeURIComponent(options.url)}`); // 点击通知跳转的URL
      if (options.icon) queryParams.push(`icon=${encodeURIComponent(options.icon)}`); // 自定义图标URL
      if (options.sound) queryParams.push(`sound=${encodeURIComponent(options.sound)}`); // 铃声名称
      if (options.isArchive === 1 || options.isArchive === '1') queryParams.push(`isArchive=1`); // 自动存档
      if (options.copy) queryParams.push(`copy=${encodeURIComponent(options.copy)}`); // 复制内容
      if (queryParams.length > 0) {
          url += `?${queryParams.join('&')}`;
      }
      const requestOptions = {
          url: url,
          timeout: 10000 // Bark 请求超时设为 10 秒
      };
      log(`[Bark] 准备发送通知: ${title}`);
      return new Promise(resolve => {
          $httpClient.get(requestOptions, (err, resp, data) => {
              if (err) {
                  error(`[Bark] 通知发送失败: ${err}`);
                  notify("❌ Bark 通知发送失败", `${title}`, `错误: ${err}`); // 使用原生通知报告 Bark 失败
              } else if (resp.statusCode !== 200) {
                  error(`[Bark] 通知发送失败: HTTP Status Code ${resp.statusCode}`);
                  error(`[Bark] 响应内容: ${data}`);
                  notify("❌ Bark 通知发送失败", `${title}`, `HTTP 状态码: ${resp.statusCode}`);
              } else {
                  log(`[Bark] 通知发送成功: ${title}`);
                  // Bark 成功一般不需要再通知用户
              }
              resolve(); // 无论成功失败都 resolve
          });
      });
  };
  const get = (options, callback) => {
    if (isSurge) $httpClient.get(options, callback);
  };
  const post = (options, callback) => {
    if (isSurge) $httpClient.post(options, callback);
  };
  const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
  };
  const done = (value = {}) => {
      log("脚本执行完毕。");
      if (isSurge) $done(value);
  };
  return { name, log, error, read, write, notify, barkNotify, get, post, sleep, done };
}
// --- 脚本入口 ---
main()
    .catch((e) => {
        $.error(`脚本执行异常: ${e}`);
        // 异常时也尝试发送 Bark 通知（如果 Bark Key 可用）
        const barkKeyForError = $.read(BARK_KEY_PERSIST_KEY);
        if (barkKeyForError) {
            $.barkNotify("❌ 爱情商业脚本错误", `执行过程中出现未捕获异常: ${e}`, barkKeyForError);
        } else {
            $.notify("❌ 爱情商业脚本错误", "执行过程中出现未捕获异常", `${e}`);
        }
    })
    .finally(() => {
        $.done(); // 确保无论成功或失败，$done 都会被调用
    });
