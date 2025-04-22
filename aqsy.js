/*
 * Surge 脚本: WAI-AOVE (爱情商业) 签到
 * 功能: 每日签到、周三会员日抽奖、查询用户信息及优惠券
 *
 * 如何配置:
 * 1. 运行一次性的 "账号信息设置脚本" (见上方说明) 将你的账号信息存入 Surge 持久化存储。
 *    - 账号 Key: WEAIOVE_ACCOUNTS
 *    - 格式: token1|备注1@token2|备注2@...
 * 2. (可选) 在持久化存储中设置通知分块大小 Key: NOTIFY_CHUNK_SIZE (默认为 10)
 *
 * Surge 定时任务建议: 每天运行一次，例如 0 8 * * *
 */
const $ = new Env(); // 使用 Env 类简化 $httpClient, $persistentStore, $notification 的调用
// --- 全局配置与常量 ---
const BASE_URL = "https://vip.weaiove.com/api/minpro-api";
const APPKEY = "wx360959f2f6ecfb97";
const TENANT_ID = "1585937717626433537";
const PLAZA_ID = "1719238954936242177";
const ACCOUNTS_KEY = "WEAIOVE_ACCOUNTS";
const NOTIFY_CHUNK_SIZE_KEY = "NOTIFY_CHUNK_SIZE";
const DEFAULT_NOTIFY_CHUNK_SIZE = 10;
// --- 主逻辑 ---
async function main() {
    const accountsStr = $.read(ACCOUNTS_KEY);
    if (!accountsStr) {
        $.error(`错误：未在 Surge 持久化存储中找到账号信息 (Key: ${ACCOUNTS_KEY})`);
        $.notify("❌ 爱情商业配置错误", "未找到账号配置", `请先运行一次性的 "账号信息设置脚本" 来存储账号信息 (Key: ${ACCOUNTS_KEY})`);
        return;
    }
    const accounts = accountsStr.split('@')
        .map(acc => acc.trim())
        .filter(acc => acc)
        .map((acc, index) => {
            const parts = acc.split('|');
            if (parts.length !== 2 || !parts[0] || !parts[1]) {
                $.log(`账号 ${index + 1} 配置格式错误，已跳过: '${acc}'`);
                return null; // 标记为无效
            }
            return { token: parts[0].trim(), name: parts[1].trim(), raw: acc };
        })
        .filter(acc => acc !== null); // 过滤掉格式错误的账号
    if (accounts.length === 0) {
        $.error("错误：未找到任何有效格式的账号配置。");
        $.notify("❌ 爱情商业配置错误", "未找到有效账号", `请检查持久化存储中 ${ACCOUNTS_KEY} 的格式是否为 token1|备注1@token2|备注2`);
        return;
    }
    let notifyChunkSize = parseInt($.read(NOTIFY_CHUNK_SIZE_KEY) || DEFAULT_NOTIFY_CHUNK_SIZE, 10);
    if (isNaN(notifyChunkSize) || notifyChunkSize <= 0) {
        $.log(`警告：持久化存储中的 ${NOTIFY_CHUNK_SIZE_KEY} 值无效，已使用默认值 ${DEFAULT_NOTIFY_CHUNK_SIZE}`);
        notifyChunkSize = DEFAULT_NOTIFY_CHUNK_SIZE;
    }
    const totalAccounts = accounts.length;
    $.log(`共找到 ${totalAccounts} 个有效账号配置。`);
    $.log(`通知将每 ${notifyChunkSize} 个账号分段发送。`);
    let chunkMessages = []; // 用于存储当前分段的账号消息
    let overallSummary = []; // 存储所有账号的最终消息
    let startAccountIndexForChunk = 1; // 当前分段的起始账号序号
    for (let i = 0; i < totalAccounts; i++) {
        const account = accounts[i];
        const index = i + 1;
        const accountInfo = `账号 ${index} (${account.name})`;
        $.log(`\n--- 开始处理 ${accountInfo} ---`);
        const headers = {
            "Host": "vip.weaiove.com",
            "tenant-Id": TENANT_ID,
            "plaza-Id": PLAZA_ID,
            "appkey": APPKEY,
            "member-token": account.token,
            "content-type": "application/json;charset=utf-8",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.56(0x1800383b) NetType/WIFI Language/zh_CN",
            "Referer": `https://servicewechat.com/${APPKEY}/72/page-frame.html`
        };
        let accountSummary = [`👤 ${accountInfo}`]; // 使用列表存储单个账号的消息行
        const currentTimeStr = new Date().toLocaleString('zh-CN', { hour12: false });
        accountSummary.push(`🕕 处理时间: ${currentTimeStr}`);
        // 1. 获取用户基本信息
        const { memberId, phoneOrError } = await getUserDetails(headers, accountInfo);
        if (!memberId) {
            $.error(`${accountInfo}: 获取 Member ID 失败: ${phoneOrError}，无法继续处理此账号。`);
            accountSummary.push(`❌ 错误: 获取用户信息失败 (${phoneOrError})`);
            // Token 失效的特定处理
            if (phoneOrError && (phoneOrError.includes('Token') || phoneOrError.includes('401'))) {
                 $.notify(`⚠️ ${accountInfo} Token 可能已失效`, `错误: ${phoneOrError}`, `请检查账号配置或重新获取 Token: ${account.raw}`);
            }
        } else {
            accountSummary[0] = `👤 ${accountInfo} (手机号: ${phoneOrError})`; // 更新包含手机号的标题行
            // 只有获取到 memberId 才继续后续操作
            // 2. 执行签到
            const { signMessage } = await performCheckin(headers, memberId, accountInfo);
            accountSummary.push(`📌 签到状态: ${signMessage}`);
            // 3. 获取签到天数
            const checkinCountMsg = await getCheckinCount(headers, memberId, accountInfo);
            accountSummary.push(`📅 ${checkinCountMsg}`);
            // 4. 获取用户详细信息
            const userInfo = await getUserInfo(headers, memberId, accountInfo);
            let currentPoints = 0;
            if (userInfo) {
                currentPoints = userInfo.points;
                accountSummary.push(`⭐ 等级: ${userInfo.level}`);
                accountSummary.push(`💰 积分: ${userInfo.points}`);
                accountSummary.push(`📈 成长值: ${userInfo.total_growth} (距下级差 ${userInfo.growth_diff})`);
            } else {
                accountSummary.push("⚠️ 获取用户详细信息失败");
            }
            // 5. 周三会员日处理
            const todayWeekday = new Date().getDay(); // 0=周日, 1=周一, ..., 6=周六
            if (todayWeekday === 3) { // 周三
                const drawSummary = await handleWednesdayDraws(headers, memberId, accountInfo, currentPoints);
                accountSummary.push("\n--- 周三会员日抽奖结果 ---");
                accountSummary.push(...drawSummary); // 使用 spread 操作符合并数组
                accountSummary.push("--------------------------");
            }
            // 6. 查询未使用优惠券
            const unusedCoupons = await checkUnusedCoupons(headers, memberId, accountInfo, account.token);
            if (unusedCoupons && unusedCoupons.length > 0) {
                accountSummary.push("\n--- 🎟️ 未使用优惠券 ---");
                accountSummary.push(...unusedCoupons.map(c => `- ${c}`)); // 格式化输出
                accountSummary.push("-----------------------");
            } else {
                accountSummary.push("🎟️ 未发现未使用优惠券");
            }
        }
        // 7. 将当前账号的完整结果添加到分段消息列表和总列表
        const accountResultStr = accountSummary.join("\n");
        overallSummary.push(accountResultStr);
        chunkMessages.push(accountResultStr);
        $.log(`--- ${accountInfo} 处理完毕 ---`);
        // 8. 检查是否需要发送当前分段的通知
        if (chunkMessages.length >= notifyChunkSize || index === totalAccounts) {
            const chunkTitle = `💖 爱情商业报告 (账号 ${startAccountIndexForChunk}-${index})`;
            const chunkContent = chunkMessages.join("\n\n====================\n\n");
            $.notify(chunkTitle, "", chunkContent); // subtitle 留空
            chunkMessages = []; // 清空，为下一段准备
            startAccountIndexForChunk = index + 1; // 更新下一段的起始序号
        }
        // 每个账号处理后等待一小段时间，防止请求过于频繁
        await $.sleep(5); // 等待 500 毫秒
    }
    $.log("\n=== 所有账号处理完毕 ===");
    if (overallSummary.length === 0 && accounts.length > 0) {
         $.log("所有账号处理失败或未产生有效结果。");
    }
}
// --- API 请求封装 ---
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
        // GET 请求通常不带 body，参数在 URL 中
    } else {
        $.error(`[${accountInfo}][${actionDesc}] 不支持的请求方法: ${method}`);
        return null;
    }
    $.log(`[${accountInfo}][${actionDesc}] 发起 ${options.method} 请求到 ${url}`);
    return new Promise(resolve => {
        $[options.method.toLowerCase()](options, (error, response, data) => {
            try {
                if (error) {
                    // 网络层错误或超时
                    $.error(`[${accountInfo}][${actionDesc}] 请求失败: ${error}`);
                    // 区分超时和其他网络错误
                    if (error.includes('timeout')) {
                        $.notify(`⚠️ ${accountInfo} 请求超时`, `操作: ${actionDesc}`, `URL: ${url}`);
                    } else {
                        $.notify(`⚠️ ${accountInfo} 网络错误`, `操作: ${actionDesc}`, `错误: ${error}`);
                    }
                    resolve(null); // 返回 null 表示失败
                    return;
                }
                // 检查 HTTP 状态码
                if (response.statusCode >= 400) {
                    $.error(`[${accountInfo}][${actionDesc}] HTTP 错误: 状态码 ${response.statusCode}`);
                    // 特别处理 401 未授权
                    if (response.statusCode === 401) {
                        $.error(`[${accountInfo}][${actionDesc}] 认证失败 (401)，Token 可能已失效。`);
                        // 在主流程中已根据返回值处理通知，这里只记录错误
                        resolve({ code: 401, msg: 'Token 可能已失效' }); // 返回特定结构让调用者判断
                    } else {
                        // 其他 HTTP 错误
                        $.notify(`⚠️ ${accountInfo} HTTP 错误`, `操作: ${actionDesc}`, `状态码: ${response.statusCode}\nURL: ${url}`);
                        resolve(null);
                    }
                    return;
                }
                // 尝试解析 JSON 响应
                if (!data) {
                    $.log(`[${accountInfo}][${actionDesc}] 请求成功，但响应体为空。`);
                    resolve({}); // 返回空对象表示成功但无数据
                    return;
                }
                let result;
                try {
                    result = JSON.parse(data);
                    // $.log(`[${accountInfo}][${actionDesc}] 原始响应: ${JSON.stringify(result)}`); // 调试时取消注释
                } catch (jsonError) {
                    $.error(`[${accountInfo}][${actionDesc}] 解析 JSON 响应失败。URL: ${url}`);
                    $.error(`响应内容 (前500字符): ${data.substring(0, 500)}...`);
                    resolve(null); // 解析失败返回 null
                    return;
                }
                // 检查业务逻辑错误码 (例如 code != 0)
                // 注意：有些接口成功时 code 可能不是 0，需要根据实际情况调整判断逻辑
                // 401 错误在 status code 层面已处理，但如果 API 在 200 OK 里返回 code 401，这里也处理下
                if (result.code === 401) {
                     $.error(`[${accountInfo}][${actionDesc}] 请求失败 (业务码 ${result.code}): ${result.msg || 'Token 可能已失效'}`);
                     resolve(result); // 将包含错误信息的 result 返回给调用者
                } else if (result.code !== 0 && result.code !== 200 && !result.successful) { // 假设 code 0 或 successful=true 表示成功
                     // 排除签到重复等不算严重错误的情况
                     if (!(actionDesc === "执行签到" && result.msg && result.msg.includes("重复签到"))) {
                         $.error(`[${accountInfo}][${actionDesc}] API 返回业务错误: Code=${result.code}, Msg=${result.msg || '无消息'}`);
                     } else {
                         $.log(`[${accountInfo}][${actionDesc}] 操作已完成或无需执行: ${result.msg}`);
                     }
                     resolve(result); // 将包含错误信息的 result 返回给调用者
                } else {
                    // 请求成功且业务码正确
                    resolve(result);
                }
            } catch (e) {
                $.error(`[${accountInfo}][${actionDesc}] 处理响应时发生内部错误: ${e}`);
                $.log(`错误发生在处理 URL: ${url}`);
                resolve(null); // 内部错误返回 null
            }
        });
    });
}
// --- 核心功能函数 (JS 版本) ---
async function getUserDetails(headers, accountInfo) {
    const url = `${BASE_URL}/member/getAppById`;
    const result = await makeRequest('GET', url, headers, null, accountInfo, "获取用户基本信息");
    if (result && result.code === 0 && result.successful) {
        const data = result.data || {};
        const memberId = data.memberId;
        const phone = data.memberMobile || "未获取到手机号";
        if (memberId) {
            $.log(`[${accountInfo}] 获取到 Member ID: ${memberId}, 手机号: ${phone}`);
            return { memberId, phoneOrError: phone };
        } else {
            $.error(`[${accountInfo}] 获取 Member ID 失败，响应数据: ${JSON.stringify(data)}`);
            return { memberId: null, phoneOrError: "未能从 API 获取到有效的 Member ID" };
        }
    } else {
        const errorMsg = result ? (result.msg || `业务码 ${result.code}`) : "请求失败或响应格式错误";
        $.error(`[${accountInfo}] 获取用户基本信息 API 请求失败: ${errorMsg}`);
        return { memberId: null, phoneOrError: errorMsg }; // 返回错误信息
    }
}
async function getUserInfo(headers, memberId, accountInfo) {
    const url = `${BASE_URL}/member/getByMemberLevelDetailApp/${memberId}`;
    const result = await makeRequest('GET', url, headers, null, accountInfo, "获取用户详细信息");
    if (result && result.code === 0 && result.successful) {
        const data = result.data || {};
        const info = {
            level: data.memberLevelName || "未知等级",
            next_level_growth: data.DGrowupValue || 0,
            growth_diff: data.accDifference || 0.0,
            total_growth: data.accGrowupAmt || 0.0,
            points: data.acctRewardpointsAmt || 0.0
        };
        $.log(`[${accountInfo}] 获取到用户详细信息: 等级=${info.level}, 积分=${info.points}`);
        return info;
    } else {
        $.error(`[${accountInfo}] 获取用户详细信息 API 请求失败或响应格式错误。`);
        return null;
    }
}
async function performCheckin(headers, memberId, accountInfo) {
    const url = `${BASE_URL}/sign/clientSignIn`;
    const payload = {
        channel: 2,
        memberId: memberId,
        plazaId: PLAZA_ID
    };
    const result = await makeRequest('POST', url, headers, payload, accountInfo, "执行签到");
    let signMessage = "签到请求失败";
    let success = false;
    if (result) {
        const msg = result.msg || "";
        if (result.code === 0 || msg.includes("success") || msg.includes("重复签到")) {
            signMessage = msg.includes("重复签到") ? "今日已签到" : "签到成功";
            success = true;
            $.log(`[${accountInfo}] ${signMessage}`);
        } else {
            signMessage = `签到失败: ${msg || '未知错误'}`;
            $.error(`[${accountInfo}] ${signMessage}`);
        }
    } else {
        $.error(`[${accountInfo}] 签到请求失败。`);
    }
    return { signMessage, success };
}
async function getCheckinCount(headers, memberId, accountInfo) {
    const url = `${BASE_URL}/sign/appSignCount`;
    const payload = {
        channel: 2,
        memberId: memberId,
        plazaId: PLAZA_ID
    };
    const result = await makeRequest('POST', url, headers, payload, accountInfo, "获取签到天数");
    if (result && result.code === 0 && result.successful) {
        const count = result.data || 0;
        $.log(`[${accountInfo}] 累计签到: ${count} 天`);
        return `累计签到 ${count} 天`;
    } else {
        $.log(`[${accountInfo}] 获取签到天数失败或响应格式错误。`);
        return "获取签到天数失败";
    }
}
async function getDynamicGameId(headers, accountInfo) {
    const url = `${BASE_URL}/advertising/getUpList/HOP01`;
    const result = await makeRequest('GET', url, headers, null, accountInfo, "获取活动广告信息 (含 Game ID)");
    if (result && result.code === 0 && result.successful) {
        const adList = result.data;
        if (Array.isArray(adList) && adList.length > 0) {
            const firstAd = adList[0];
            const jumpUrlStr = firstAd.jumpUrl;
            if (jumpUrlStr) {
                try {
                    // 简单解析 URL 查询参数
                    const urlParams = new URLSearchParams(jumpUrlStr.split('?')[1] || '');
                    const gameId = urlParams.get("gameId");
                    if (gameId) {
                        $.log(`[${accountInfo}] 动态获取到周三活动 Game ID: ${gameId}`);
                        return gameId;
                    } else {
                        $.error(`[${accountInfo}] 在 jumpUrl 中未找到 gameId 参数: ${jumpUrlStr}`);
                    }
                } catch (e) {
                    $.error(`[${accountInfo}] 解析 jumpUrl 时出错: ${jumpUrlStr}, 错误: ${e}`);
                }
            } else {
                $.error(`[${accountInfo}] 广告信息中缺少 jumpUrl 字段。`);
            }
        } else {
            $.error(`[${accountInfo}] 广告信息列表为空或格式错误。`);
        }
    } else {
        $.error(`[${accountInfo}] 获取活动广告信息失败。`);
    }
    return null; // 获取失败返回 null
}
async function shareForDrawChance(headers, memberId, gameId, accountInfo) {
    if (!gameId) {
        $.log(`[${accountInfo}] 没有有效的 Game ID，无法执行分享操作。`);
        return false;
    }
    const url = `${BASE_URL}/shareRecords/save`;
    const payload = {
        appPageCode: "GAD03",
        memberId: memberId,
        sharedById: "",
        sharedType: 2,
        gameId: gameId,
        plazaId: PLAZA_ID
    };
    const result = await makeRequest('POST', url, headers, payload, accountInfo, "分享获取抽奖次数");
    if (result && result.code === 0 && result.successful) {
        $.log(`[${accountInfo}] 分享操作成功。`);
        return true;
    } else {
        const errorMsg = result ? (result.msg || '未知错误') : '请求失败';
        $.error(`[${accountInfo}] 分享操作失败: ${errorMsg}`);
        return false;
    }
}
async function getDrawChances(headers, gameId, accountInfo) {
    if (!gameId) {
        $.log(`[${accountInfo}] 没有有效的 Game ID，无法查询抽奖次数。`);
        return 0;
    }
    const url = `${BASE_URL}/game/residue/${gameId}`;
    const result = await makeRequest('GET', url, headers, null, accountInfo, "查询剩余抽奖次数");
    if (result && result.code === 0 && result.successful) {
        const chances = result.data || 0;
        $.log(`[${accountInfo}] 当前剩余抽奖次数: ${chances}`);
        return chances;
    } else {
        $.log(`[${accountInfo}] 查询剩余抽奖次数失败，假设为 0。`);
        return 0;
    }
}
async function performDraw(headers, gameId, drawType, accountInfo) {
    if (!gameId) {
        $.log(`[${accountInfo}] 没有有效的 Game ID，无法执行抽奖。`);
        return { prize: null, status: "无有效 Game ID" };
    }
    let url = "";
    let action = "";
    let reqMethod = 'GET'; // 默认为 GET
    let payload = null;
    if (drawType === 0) { // 普通抽奖
        url = `${BASE_URL}/game/getById/${gameId}/0`;
        action = "执行普通抽奖";
        reqMethod = 'GET';
    } else if (drawType === 1) { // 积分兑换并抽奖
        // 1. 尝试积分兑换 (API 行为可能不同，这里模拟检查)
        const exchangeUrl = `${BASE_URL}/game/getIntegralGame/${gameId}`;
        const exchangeResult = await makeRequest('GET', exchangeUrl, headers, null, accountInfo, "尝试积分兑换抽奖次数");
        if (!exchangeResult || exchangeResult.code !== 0) {
            const msg = exchangeResult ? (exchangeResult.msg || `业务码 ${exchangeResult.code}`) : '请求失败';
            if (msg.includes("机会已用完") || msg.includes("积分不足")) {
                $.log(`[${accountInfo}] 积分兑换抽奖失败: ${msg}`);
                return { prize: null, status: msg }; // 返回特定消息
            } else {
                $.error(`[${accountInfo}] 积分兑换抽奖请求失败或API返回错误: ${msg}`);
                return { prize: null, status: `积分兑换失败: ${msg}` };
            }
        }
        // 2. 如果积分兑换检查通过，执行抽奖
        $.log(`[${accountInfo}] 积分兑换检查通过，尝试执行抽奖...`);
        url = `${BASE_URL}/game/getById/${gameId}/0`; // 实际抽奖 URL 仍是这个？
        action = "执行积分兑换后的抽奖";
        reqMethod = 'GET';
    } else {
        $.error(`[${accountInfo}] 未知的抽奖类型: ${drawType}`);
        return { prize: null, status: "未知的抽奖类型" };
    }
    // 执行抽奖请求
    const result = await makeRequest(reqMethod, url, headers, payload, accountInfo, action);
    if (result && result.code === 0 && result.successful) {
        const data = result.data || {};
        const prizeMessage = data.message || "抽奖成功但未获取到奖品信息";
        $.log(`[${accountInfo}] ${action} 成功: ${prizeMessage}`);
        return { prize: prizeMessage, status: "成功" };
    } else {
        const errorMsg = result ? (result.msg || `业务码 ${result.code}`) : '请求失败';
        $.error(`[${accountInfo}] ${action} 失败: ${errorMsg}`);
        // 特别处理次数用完的消息，以便上层循环能正确退出
        if (errorMsg.includes("机会已用完")) {
            return { prize: null, status: "机会已用完" };
        }
        return { prize: null, status: errorMsg };
    }
}
async function handleWednesdayDraws(headers, memberId, accountInfo, currentPoints) {
    $.log(`[${accountInfo}] 今天是周三会员日，开始处理抽奖...`);
    let summary = [];
    // 1. 动态获取 Game ID
    const gameId = await getDynamicGameId(headers, accountInfo);
    if (!gameId) {
        $.error(`[${accountInfo}] 无法获取周三活动 Game ID，跳过抽奖。`);
        summary.push("未能获取活动 ID，跳过抽奖");
        return summary;
    }
    // 2. 尝试分享获取次数
    await shareForDrawChance(headers, memberId, gameId, accountInfo);
    await $.sleep(1000); // 分享后稍等片刻
    // 3. 获取免费/分享抽奖次数
    let freeChances = await getDrawChances(headers, gameId, accountInfo);
    $.log(`[${accountInfo}] 获取到 ${freeChances} 次免费/分享抽奖机会。`);
    // 4. 执行免费/分享抽奖
    const maxFreeDraws = 3; // 最多尝试 3 次免费抽奖
    for (let drawCount = 0; drawCount < maxFreeDraws && freeChances > 0; drawCount++) {
        $.log(`[${accountInfo}] 尝试第 ${drawCount + 1} 次普通抽奖...`);
        const { prize, status } = await performDraw(headers, gameId, 0, accountInfo);
        if (status === "成功") {
            const drawResult = `普通抽奖: ${prize}`;
            summary.push(drawResult);
            if (prize && !prize.includes("积分") && !prize.includes("谢谢")) {
                 $.notify(`🎉 ${accountInfo} 周三中奖提醒`, `抽中: ${prize}`, "");
            }
        } else if (status.includes("机会已用完")) {
            $.log(`[${accountInfo}] 普通抽奖机会已用完。`);
            summary.push(`普通抽奖: ${status}`);
            break;
        } else {
            summary.push(`普通抽奖失败: ${status}`);
            // 可考虑是否 break
        }
        freeChances--; // 假设每次调用都消耗机会
        await $.sleep(500); // 抽奖间隔
    }
     if (summary.length === 0 || summary[summary.length - 1].startsWith("未能")) { // 如果还没抽过或获取ID失败
         summary.push("未执行普通抽奖或无剩余次数");
     }
    // 5. 尝试积分兑换抽奖
    $.log(`[${accountInfo}] 开始尝试积分兑换抽奖... (当前积分: ${currentPoints})`);
    const maxIntegralDraws = 5; // 最多尝试 5 次积分抽奖
    let integralDrawSummary = [];
    // if (currentPoints < 100) { // 假设每次积分抽奖至少需要 100 积分，如果不够直接跳过（需要确认实际消耗）
    //    $.log(`[${accountInfo}] 积分不足 ${100}，跳过积分抽奖。`);
    //    integralDrawSummary.push("积分抽奖: 积分不足");
    // } else {
        for (let integralDrawCount = 0; integralDrawCount < maxIntegralDraws; integralDrawCount++) {
             $.log(`[${accountInfo}] 尝试第 ${integralDrawCount + 1} 次积分抽奖...`);
             const { prize, status } = await performDraw(headers, gameId, 1, accountInfo); // 使用类型 1
             if (status === "成功") {
                 const drawResult = `积分抽奖: ${prize}`;
                 integralDrawSummary.push(drawResult);
                  if (prize && !prize.includes("积分") && !prize.includes("谢谢")) {
                       $.notify(`🎉 ${accountInfo} 周三中奖提醒 (积分)`, `抽中: ${prize}`, "");
                  }
                  // 积分抽奖成功后，积分理论上已扣除，但脚本内积分变量未更新
             } else if (status.includes("机会已用完") || status.includes("积分不足")) {
                 $.log(`[${accountInfo}] 积分抽奖失败或无法兑换: ${status}`);
                 integralDrawSummary.push(`积分抽奖: ${status}`);
                 break; // 无法继续兑换，跳出循环
             } else {
                 integralDrawSummary.push(`积分抽奖失败: ${status}`);
                 break; // 其他错误也跳出，避免意外消耗
             }
             await $.sleep(500); // 抽奖间隔
        }
   // }
    if (integralDrawSummary.length === 0) {
        integralDrawSummary.push("未执行积分抽奖或不满足条件");
    }
    summary.push(...integralDrawSummary);
    return summary;
}
async function checkUnusedCoupons(headers, memberId, accountInfo, token) {
    const url = `${BASE_URL}/member/getCopuonsPageList`;
    const payload = {
        pageSize: 20,
        pageNumber: 1,
        totalPages: "",
        memberId: memberId,
        businessType: "",
        status: 1 // 1 表示查询 "未使用" 的券
    };
    const result = await makeRequest('POST', url, headers, payload, accountInfo, "查询未使用优惠券");
    let coupons = [];
    if (result && result.code === 0 && result.successful) {
        const data = result.data || {};
        const items = data.items;
        if (Array.isArray(items) && items.length > 0) {
            $.log(`[${accountInfo}] 查询到 ${items.length} 张未使用优惠券:`);
            items.forEach(item => {
                const couponName = item.couponsName;
                if (couponName) {
                    coupons.push(couponName);
                    $.log(`  - ${couponName}`);
                    // $.notify(`✅ 爱情商业：存在优惠券`, `[${accountInfo}] ${token}`, `未兑换优惠券: ${couponName}`); // 这个通知太频繁，移到总结里
                }
            });
             if (coupons.length === 0) {
                  $.log(`[${accountInfo}] 响应中有券列表，但未能提取到有效名称。`);
             }
        } else if (Array.isArray(items) && items.length === 0) {
            $.log(`[${accountInfo}] 未查询到未使用的优惠券。`);
        } else {
            $.log(`[${accountInfo}] 优惠券响应格式错误 (items 非列表或不存在)。`);
        }
    } else {
        $.log(`[${accountInfo}] 查询优惠券请求失败或 API 返回错误。`);
    }
    return coupons;
}
// --- Env 类，简化 Surge API 调用 ---
function Env() {
  const isSurge = typeof $httpClient !== 'undefined';
  const name = 'WAI-AOVE';
  const log = (message) => console.log(`[${name}] ${message}`);
  const error = (message) => console.error(`[${name}] ${message}`);
  const read = (key) => {
    if (isSurge) return $persistentStore.read(key);
    return undefined; // 其他环境不支持
  };
  const write = (value, key) => {
    if (isSurge) return $persistentStore.write(value, key);
    return false; // 其他环境不支持
  };
  const notify = (title, subtitle = '', body = '') => {
    if (isSurge) {
      $notification.post(title, subtitle, body);
    } else {
      log(`\n【通知】\n标题: ${title}\n子标题: ${subtitle}\n内容:\n${body}\n`);
    }
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
      $done(value);
  };
  return { name, log, error, read, write, notify, get, post, sleep, done };
}
// --- 脚本入口 ---
main()
    .catch((e) => {
        $.error(`脚本执行异常: ${e}`);
        $.notify("❌ 爱情商业脚本错误", "执行过程中出现未捕获异常", `${e}`);
    })
    .finally(() => {
        $.done(); // 确保无论成功或失败，$done 都会被调用
    });
