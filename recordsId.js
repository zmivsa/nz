/*
#!name=微爱社区获取RecordsId
#!desc=拦截微爱社区注册请求，获取请求体中的 recordsId 并存储。
#!url = https://vip.weaiove.com/api/minpro-api/user/registerNew
#!script-type = request
*/
const scriptName = "微爱社区获取RecordsId";
const targetUrl = "https://vip.weaiove.com/api/minpro-api/user/registerNew";
const storageKey = "weaiove_recordsId"; // 用于存储 recordsId 的键名
// --- 主逻辑 ---
// 检查是否是 $request 阶段并且 URL 匹配
if ($request && $request.url === targetUrl) {
    console.log(`[${scriptName}] 拦截到目标URL: ${$request.url}`);
    // 检查请求体是否存在
    if ($request.body) {
        try {
            // 尝试解析 JSON 请求体
            const bodyObj = JSON.parse($request.body);
            // 检查解析后的对象以及是否存在 recordsId 字段
            if (bodyObj && bodyObj.recordsId) {
                const recordsIdValue = bodyObj.recordsId;
                console.log(`[${scriptName}] 成功提取到 recordsId: ${recordsIdValue}`);
                // 尝试将 recordsId 写入持久化存储
                const success = $persistentStore.write(recordsIdValue, storageKey);
                if (success) {
                    console.log(`[${scriptName}] recordsId 已成功写入持久化存储 (Key: ${storageKey})`);
                    // 发送通知告知用户获取成功
                    $notification.post(
                        `${scriptName}`,
                        "获取成功 🎉",
                        `已将 recordsId "${recordsIdValue}" 存储到 Key "${storageKey}"`
                    );
                } else {
                    console.log(`[${scriptName}] 写入持久化存储失败`);
                    $notification.post(
                        `${scriptName}`,
                        "存储失败 ⚠️",
                        `无法将 recordsId "${recordsIdValue}" 写入 Key "${storageKey}"`
                    );
                }
            } else {
                console.log(`[${scriptName}] 请求体 JSON 中未找到 "recordsId" 字段`);
                // 可选：如果需要，可以通知未找到
                // $notification.post(`${scriptName}`, "未找到字段", `在请求体中未找到 "recordsId"`);
            }
        } catch (error) {
            console.log(`[${scriptName}] 解析请求体 JSON 失败: ${error}`);
            $notification.post(
                `${scriptName}`,
                "处理失败 ❌",
                `解析请求体 JSON 时出错: ${error}`
            );
        }
    } else {
        console.log(`[${scriptName}] 请求体为空`);
        // 可选：通知请求体为空
        // $notification.post(`${scriptName}`, "请求体为空", "拦截到的请求没有 Body");
    }
} else {
    // 如果脚本因为其他原因被调用（例如在 response 阶段），则不执行任何操作
    if ($request) {
        // console.log(`[${scriptName}] URL 不匹配: ${$request.url}`);
    }
}
// 必须调用 $done() 结束脚本执行
// 由于我们只是读取请求体，不需要修改，直接调用 $done() 即可
$done();
