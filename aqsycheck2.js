/*
 * Surge 脚本: WAI-AOVE (爱情商业) 积分查询 (Bark 批量通知版)
 * 功能: 查询账号积分，每 30 个账号的结果合并为一条 Bark 通知发送。
 *
 * 如何配置:
 * 1. 运行一次性的 "账号信息设置脚本" 将你的账号信息存入 Surge 持久化存储。
 *    - 账号 Key: WEAIOVE_ACCOUNTS
 *    - 格式: token1|备注1@token2|备注2@...
 * 2. 在 Surge 持久化存储中设置你的 Bark 推送 Key。
 *    - Key: BARK_KEY
 *    - Value: 你的 Bark Key (例如: https://api.day.app/your_key/) 或仅 Key 部分 (your_key)
 *
 * Surge 定时任务建议: 根据需要设置，例如每天检查一次 0 8 * * *
 */
const $ = new Env(); // 使用 Env 类简化 $httpClient, $persistentStore, $notification 的调用
// --- 全局配置与常量 ---
const BASE_URL = "https://vip.weaiove.com/api/minpro-api";
const APPKEY = "wx360959f2f6ecfb97";
const TENANT_ID = "1585937717626433537";
const PLAZA_ID = "1719238954936242177"; // 可能需要，保留
const ACCOUNTS_KEY = "WEAIOVE_ACCOUNTS";
const BARK_KEY_KEY = "BARK_KEY"; // Key for Bark push key in persistent store
const BARK_BATCH_SIZE = 30; // 每多少个账号发送一次通知
// --- API 封装 ---
async function makeRequest(options) {
    return new Promise((resolve, reject) => {
        $.httpClient.post(options, (err, resp, data) => {
            if (err) {
                $.logErr(`❌ 请求失败: ${options.url}\n${err}`);
                reject(err);
            } else {
                try {
                    const result = JSON.parse(data);
                    if (result.code === 200 && result.success) {
                        resolve(result.data);
                    } else {
                        $.logErr(`❌ API 错误: ${options.url}\n响应: ${data}`);
                        // 返回原始响应，以便上层可以检查特定错误码
                        resolve(result); // 改为 resolve 以便处理非 200 但有意义的响应
                    }
                } catch (e) {
                    $.logErr(`❌ 解析响应失败: ${options.url}\n错误: ${e}\n响应: ${data}`);
                    reject(e);
                }
            }
        });
    });
}
function buildHeaders(token) {
    return {
        'Host': 'vip.weaiove.com',
        'tenant-id': TENANT_ID,
        'appkey': APPKEY,
        'Authorization': token,
        'content-type': 'application/json;charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003137) NetType/WIFI Language/zh_CN',
        'Referer': `https://servicewechat.com/${APPKEY}/10/page-frame.html`
    };
}
// 获取用户 Member ID (某些接口可能需要)
async function getUserDetails(token) {
    const options = {
        url: `${BASE_URL}/member/queryMemberDetail`,
        headers: buildHeaders(token),
        body: JSON.stringify({}) // 空 body
    };
    try {
        const data = await makeRequest(options);
         // 检查 data 是否是期望的结构且包含 memberId
        if (data && data.memberId) {
            return data; // 返回整个用户信息对象，包含 memberId
        } else {
            $.logErr(`❌ 获取 Member ID 失败，Token: ${token.substring(0, 10)}... 响应: ${JSON.stringify(data)}`);
            return null; // 或者可以抛出错误
        }
    } catch (error) {
        $.logErr(`❌ 获取 Member ID 异常，Token: ${token.substring(0, 10)}... Error: ${error}`);
        return null;
    }
}
// 查询用户积分
async function getUserInfo(token) {
    const options = {
        url: `${BASE_URL}/member/queryMemberInfo`,
        headers: buildHeaders(token),
        body: JSON.stringify({}) // 空 body
    };
    try {
        const data = await makeRequest(options);
        // 直接返回获取到的数据，让调用者处理
        return data;
    } catch (error) {
        $.logErr(`❌ 查询用户信息异常，Token: ${token.substring(0, 10)}... Error: ${error}`);
        return null; // 返回 null 表示查询失败
    }
}
// --- 主逻辑 ---
async function main() {
    const accountsStr = $.read(ACCOUNTS_KEY);
    const barkKey = $.read(BARK_KEY_KEY);
    if (!accountsStr) {
        $.logErr("⚠️ 未找到账号信息，请先配置 WEAIOVE_ACCOUNTS");
        $.notify("WAI-AOVE 积分查询", "错误", "未找到账号信息，请检查 Surge 持久化存储");
        return;
    }
    if (!barkKey) {
        $.logWarn("⚠️ 未找到 Bark Key，将无法发送 Bark 通知。请配置 BARK_KEY");
        // 可以选择是否在这里 return，或者继续执行但不发通知
        // return;
    }
    const accounts = accountsStr.split('@').filter(Boolean);
    $.log(` M=main; T=start; total_accounts=${accounts.length}`);
    let batchResults = []; // 存储当前批次的结果字符串
    let totalSuccess = 0;
    let totalFail = 0;
    let batchCounter = 0; // 当前批次的账号计数器
    for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        const [token, remark = `账号${i + 1}`] = account.split('|');
        const shortToken = token.substring(0, 10) + "..."; // 用于日志，避免暴露完整 token
        if (!token) {
            $.logErr(` M=main; T=skip_account; index=${i}; remark=${remark}; reason=no_token`);
            batchResults.push(`【${remark}】配置错误: 缺少 Token`);
            totalFail++;
            batchCounter++; // 即使失败也计入批次计数，以保证按总账号数分批
            continue;
        }
        $.log(` M=main; T=process_account; index=${i}; remark=${remark}; token=${shortToken}`);
        try {
            // 1. 获取 Member ID (虽然查积分本身可能不需要，但保留以防万一或未来扩展)
            const userDetails = await getUserDetails(token);
            if (!userDetails || !userDetails.memberId) {
                 $.logErr(` M=main; T=get_memberid_fail; index=${i}; remark=${remark}; token=${shortToken}`);
                 // 即使获取 memberId 失败，也尝试获取积分，因为积分接口可能不依赖它
                 // 如果积分接口确认依赖 memberId，则应在此处 continue
            }
            // 2. 获取积分
            const userInfo = await getUserInfo(token);
            if (userInfo && typeof userInfo.integral !== 'undefined') {
                // 检查 userInfo 是否有效以及 integral 字段是否存在
                const points = userInfo.integral;
                $.log(` M=main; T=get_points_success; index=${i}; remark=${remark}; token=${shortToken}; points=${points}`);
                batchResults.push(`【${remark}】✅ Token: ${token} | 积分: ${points}`);
                totalSuccess++;
            } else if (userInfo && userInfo.code && userInfo.code !== 200) {
                // 处理 API 返回的特定错误，例如 token 失效
                $.logErr(` M=main; T=get_points_api_error; index=${i}; remark=${remark}; token=${shortToken}; code=${userInfo.code}; msg=${userInfo.msg || 'N/A'}`);
                batchResults.push(`【${remark}】❌ Token: ${token} | 查询失败: ${userInfo.msg || `错误码 ${userInfo.code}`}`);
                totalFail++;
            }
             else {
                // 其他未知错误或 userInfo 为 null
                $.logErr(` M=main; T=get_points_fail; index=${i}; remark=${remark}; token=${shortToken}; response=${JSON.stringify(userInfo)}`);
                batchResults.push(`【${remark}】❌ Token: ${token} | 查询失败: 未知错误`);
                totalFail++;
            }
        } catch (error) {
            $.logErr(` M=main; T=process_account_exception; index=${i}; remark=${remark}; token=${shortToken}; error=${error}`);
            batchResults.push(`【${remark}】❌ Token: ${token} | 查询异常`);
            totalFail++;
        }
        batchCounter++; // 处理完一个账号，批次计数器加 1
        // 检查是否需要发送通知
        // 条件：达到批次大小 或者 是最后一个账号
        if ((batchCounter >= BARK_BATCH_SIZE || i === accounts.length - 1) && batchResults.length > 0) {
            const currentBatchNumber = Math.ceil((i + 1) / BARK_BATCH_SIZE);
            const totalBatches = Math.ceil(accounts.length / BARK_BATCH_SIZE);
            const notifyTitle = `WAI-AOVE 积分查询 (${currentBatchNumber}/${totalBatches})`;
            const notifyBody = batchResults.join('\n');
            $.log(` M=main; T=send_batch_notify; batch_number=${currentBatchNumber}; accounts_in_batch=${batchResults.length}`);
            if (barkKey) {
                 await $.barkNotify(notifyTitle, notifyBody, barkKey); // 传入 barkKey
            } else {
                $.logWarn(` M=main; T=skip_bark_notify; reason=no_bark_key; title=${notifyTitle}`);
                // 如果没有 Bark Key，可以选择用 Surge 系统通知作为备选
                $.notify(notifyTitle, `批次 ${currentBatchNumber} 结果`, notifyBody);
            }
            // 重置批次数据
            batchResults = [];
            batchCounter = 0;
        }
        // 添加短暂延迟，避免请求过于频繁 (可选)
        // await $.wait(500); // 延迟 500 毫秒
    }
    $.log(` M=main; T=finish; total_success=${totalSuccess}; total_fail=${totalFail}`);
    // $.done() 会在 Env 类中自动调用，无需显式调用
}
// --- Env 类 ---
function Env() {
    const isSurge = typeof $httpClient !== 'undefined';
    const isQuanX = typeof $task !== 'undefined';
    const read = (key) => {
        if (isSurge) return $persistentStore.read(key);
        if (isQuanX) return $prefs.valueForKey(key);
        return undefined; // 其他环境可能需要适配
    };
    const write = (key, value) => {
        if (isSurge) return $persistentStore.write(key, value);
        if (isQuanX) return $prefs.setValueForKey(key, value);
        // 其他环境可能需要适配
        return false;
    };
    const notify = (title, subtitle = '', body = '', options = {}) => {
        // Surge / QuanX 通知
        if (isSurge) $notification.post(title, subtitle, body, options);
        if (isQuanX) $notify(title, subtitle, body, options);
        // 可以添加其他推送方式，如 Bark, Telegram Bot 等
        log(`🔔 ${title} ${subtitle} ${body}`);
    };
    // 新增 Bark 推送方法
    const barkNotify = async (title, body, barkKeyOverride = null) => {
        const barkKeyToUse = barkKeyOverride || read(BARK_KEY_KEY); // 优先使用传入的 key
        if (!barkKeyToUse) {
            logErr(' M=barkNotify; T=error; reason=no_bark_key');
            return;
        }
        // 兼容完整 URL 和只有 key 的情况
        let barkServer = barkKeyToUse;
        if (!barkKeyToUse.startsWith('http')) {
            barkServer = `https://api.day.app/${barkKeyToUse}`;
        } else if (!barkKeyToUse.endsWith('/')) {
            // 如果是 URL 但末尾没有 /，补上
             barkServer += '/';
        }
        const url = `${barkServer}${encodeURIComponent(title)}/${encodeURIComponent(body)}?isArchive=1`; // isArchive=1 保存历史记录
        const options = { url: url, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' } };
        return new Promise((resolve) => {
            httpClient.get(options, (err, resp, data) => {
                if (err || resp.status !== 200) {
                    logErr(` M=barkNotify; T=send_fail; error=${err || `status ${resp.status}`}; data=${data}`);
                } else {
                    log(` M=barkNotify; T=send_success; title=${title}`);
                    // Bark 成功响应通常是 JSON: {"code":200,"message":"success",...}
                    // 可以简单检查一下 data
                    try {
                         const barkResp = JSON.parse(data);
                         if (barkResp.code !== 200) {
                              logWarn(` M=barkNotify; T=send_success_but_api_error; response=${data}`);
                         }
                    } catch(e) {
                         logWarn(` M=barkNotify; T=send_success_but_parse_fail; response=${data}`);
                    }
                }
                resolve(); // 无论成功失败都 resolve，不中断主流程
            });
        });
    };
    const log = (msg) => console.log(msg);
    const logErr = (msg) => console.error(msg);
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    // 适配 $httpClient
    const httpClient = {
        post: (options, callback) => {
            if (isSurge) $httpClient.post(options, callback);
            if (isQuanX) {
                options.method = 'POST';
                $task.fetch(options).then(
                    response => callback(null, response, response.body),
                    reason => callback(reason.error, null, null)
                );
            }
        },
        get: (options, callback) => {
             if (isSurge) $httpClient.get(options, callback);
             if (isQuanX) {
                 options.method = 'GET';
                 $task.fetch(options).then(
                     response => callback(null, response, response.body),
                     reason => callback(reason.error, null, null)
                 );
             }
        }
    };
    const done = (value = {}) => {
        // Surge/QuanX 脚本结束
        if (isSurge || isQuanX) $done(value);
    };
    return { read, write, notify, barkNotify, log, logErr, wait, httpClient, done };
}
// --- 执行入口 ---
main().catch((e) => {
    $.logErr(` M=main; T=uncaught_exception; error=${e}`);
}).finally(() => {
    $.log(" M=main; T=script_end");
    $.done();
});
