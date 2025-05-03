#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 脚本名称: weaiove_sign_optimized.py
# 适配平台: 青龙面板 (Python 3 环境)
# 功能: WAI-AOVE (爱情商业) 每日签到、周三会员日抽奖、查询用户信息及优惠券
# 依赖: requests (请在青龙面板依赖管理中安装)
# 配置:
#   环境变量名称: WEAIOVE_ACCOUNTS
#   环境变量格式: token1|备注1@token2|备注2@...
#               例如: abcdefg12345|我的主号@hijklmn67890|我的小号
import os
import json
import requests
import time
from datetime import datetime
from urllib.parse import urlparse, parse_qs
import logging
# --- 全局配置与常量 ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
BASE_URL = "https://vip.weaiove.com/api/minpro-api"
APPKEY = "wx360959f2f6ecfb97"
TENANT_ID = "1585937717626433537"
PLAZA_ID = "1719238954936242177"
try:
    NOTIFY_CHUNK_SIZE = int(os.environ.get("NOTIFY_CHUNK_SIZE", "10"))
    if NOTIFY_CHUNK_SIZE <= 0:
        NOTIFY_CHUNK_SIZE = 10 # 防止设置为 0 或负数
        logging.warning("NOTIFY_CHUNK_SIZE 设置无效，已重置为默认值 10")
except ValueError:
    NOTIFY_CHUNK_SIZE = 10
    logging.warning("NOTIFY_CHUNK_SIZE 值无效，已使用默认值 10")
# 周三抽奖相关的固定 Game ID (如果这个ID是固定的)
# 如果周三的 gameId 是动态获取的，则不需要这个常量
# WEDNESDAY_GAME_ID_STATIC = "1899380877012918273" # 示例，根据实际情况调整或移除
# 环境变量读取
ACCOUNTS_STR = os.environ.get("WEAIOVE_ACCOUNTS", "")
ACCOUNTS = [acc for acc in ACCOUNTS_STR.split('@') if acc] # 过滤空字符串
# --- 通知功能 ---
def send_notify(title, content):
    """发送通知 (适配青龙 notify.py)"""
    try:
        from notify import send
        logging.info(f"准备发送通知: {title}")
        send(title, content)
    except ImportError:
        logging.warning("未找到青龙 'notify.py' 模块，通知将打印到日志。")
        print(f"\n【通知】\n标题: {title}\n内容:\n{content}\n")
    except Exception as e:
        logging.error(f"发送通知时出错: {e}")
# --- API 请求封装 ---
def make_request(method, url, headers, json_payload=None, params=None, account_info="", action_desc=""):
    """
    发起 API 请求的通用函数
    Args:
        method (str): 请求方法 ('GET', 'POST', etc.)
        url (str): 请求 URL
        headers (dict): 请求头
        json_payload (dict, optional): POST 请求的 JSON 数据. Defaults to None.
        params (dict, optional): GET 请求的 URL 参数. Defaults to None.
        account_info (str): 当前账号信息，用于日志记录.
        action_desc (str): 操作描述，用于日志记录.
    Returns:
        dict or None: 成功时返回解析后的 JSON 数据，失败时返回 None.
    """
    try:
        logging.debug(f"[{account_info}][{action_desc}] 发起 {method} 请求到 {url}")
        if method.upper() == 'POST':
            response = requests.post(url, headers=headers, json=json_payload, timeout=20)
        elif method.upper() == 'GET':
            response = requests.get(url, headers=headers, params=params, timeout=20)
        else:
            logging.error(f"[{account_info}][{action_desc}] 不支持的请求方法: {method}")
            return None
        response.raise_for_status() # 检查 HTTP 错误状态码 (4xx or 5xx)
        # 有些接口成功时不返回内容或返回非 JSON 内容
        if not response.content:
            logging.info(f"[{account_info}][{action_desc}] 请求成功，但响应体为空。")
            # 根据接口设计，有时空响应也算成功，返回一个标记成功的空字典或特定值
            # 但这里我们假设需要 JSON，所以返回 None 或 {} 可能更合适
            return {} # 或者 return None，取决于调用者如何处理
        result = response.json()
        logging.debug(f"[{account_info}][{action_desc}] 原始响应: {json.dumps(result, ensure_ascii=False)}")
        # 增加对通用错误码的处理，例如 token 失效
        if result.get('code') == 401:
            logging.error(f"[{account_info}][{action_desc}] 请求失败: {result.get('msg', 'Token 可能已失效')}")
            send_notify(f"⚠️ {account_info} 请求异常", f"操作: {action_desc}\n错误: {result.get('msg', 'Token 可能已失效')}\n请检查 Token 是否正确或已过期。")
            return None # 返回 None 表示失败
        return result
    except requests.exceptions.Timeout:
        logging.error(f"[{account_info}][{action_desc}] 请求超时: {url}")
        send_notify(f"⚠️ {account_info} 请求超时", f"操作: {action_desc}\nURL: {url}")
        return None
    except requests.exceptions.HTTPError as e:
        logging.error(f"[{account_info}][{action_desc}] HTTP 错误: {e} (状态码: {e.response.status_code})")
        # 可以选择性地发送通知
        # send_notify(f"⚠️ {account_info} HTTP 错误", f"操作: {action_desc}\n错误: {e}")
        return None
    except json.JSONDecodeError:
        logging.error(f"[{account_info}][{action_desc}] 解析 JSON 响应失败。URL: {url}")
        logging.error(f"响应内容: {response.text[:500]}...") # 打印部分响应内容帮助调试
        return None
    except requests.exceptions.RequestException as e:
        logging.error(f"[{account_info}][{action_desc}] 网络请求失败: {e}")
        send_notify(f"⚠️ {account_info} 网络错误", f"操作: {action_desc}\n错误: {e}")
        return None
    except Exception as e:
        logging.error(f"[{account_info}][{action_desc}] 执行请求时发生未知错误: {e}")
        send_notify(f"⚠️ {account_info} 未知错误", f"操作: {action_desc}\n错误: {e}")
        return None
# --- 核心功能函数 ---
def get_user_details(headers, account_info):
    """获取用户基本信息 (手机号, memberId)"""
    url = f"{BASE_URL}/member/getAppById"
    result = make_request('GET', url, headers, account_info=account_info, action_desc="获取用户基本信息")
    if result and result.get('code') == 0 and result.get('successful'):
        data = result.get("data", {})
        member_id = data.get("memberId")
        phone = data.get("memberMobile", "未获取到手机号")
        if member_id:
            logging.info(f"[{account_info}] 获取到 Member ID: {member_id}, 手机号: {phone}")
            return member_id, phone
        else:
            logging.error(f"[{account_info}] 获取 Member ID 失败，响应数据: {data}")
            send_notify(f"❌ {account_info} 获取用户信息失败", "未能从 API 获取到有效的 Member ID")
            return None, None
    else:
        logging.error(f"[{account_info}] 获取用户基本信息 API 请求失败或响应格式错误。")
        # make_request 内部已处理 401 和其他请求错误，这里无需重复发送通知
        return None, None
def get_user_info(headers, member_id, account_info):
    """获取用户详细信息 (等级, 积分, 成长值等)"""
    url = f"{BASE_URL}/member/getByMemberLevelDetailApp/{member_id}"
    # 注意：原脚本这里使用 GET 请求，但传递了 json=payload，这通常用于 POST。
    # 如果 API 确实是 GET 并且需要 payload，requests 不直接支持。
    # 假设这里应该是 GET，且不需要 payload，或者 payload 应该作为 URL 参数。
    # 如果确实需要 GET + Body，需要特殊处理或确认 API 设计。
    # 暂时按 GET 无 Body 处理。
    result = make_request('GET', url, headers, account_info=account_info, action_desc="获取用户详细信息")
    if result and result.get('code') == 0 and result.get('successful'):
        data = result.get("data", {})
        info = {
            "level": data.get("memberLevelName", "未知等级"),
            "next_level_growth": data.get("DGrowupValue", 0),
            "growth_diff": data.get("accDifference", 0.0),
            "total_growth": data.get("accGrowupAmt", 0.0),
            "points": data.get("acctRewardpointsAmt", 0.0)
        }
        logging.info(f"[{account_info}] 获取到用户详细信息: 等级={info['level']}, 积分={info['points']}")
        return info
    else:
        logging.error(f"[{account_info}] 获取用户详细信息 API 请求失败或响应格式错误。")
        return None
def perform_checkin(headers, member_id, account_info):
    """执行每日签到"""
    url = f"{BASE_URL}/sign/clientSignIn"
    payload = {
        "channel": 2,
        "memberId": member_id,
        "plazaId": PLAZA_ID
    }
    result = make_request('POST', url, headers, json_payload=payload, account_info=account_info, action_desc="执行签到")
    if result:
        if result.get("msg") == "success" or "重复签到" in result.get("msg", ""):
            # 接口对于已签到可能返回特定消息，也视为成功
            sign_msg = "签到成功" if result.get("msg") == "success" else "今日已签到"
            logging.info(f"[{account_info}] {sign_msg}")
            return sign_msg, True
        else:
            error_msg = result.get('msg', '未知错误')
            logging.error(f"[{account_info}] 签到失败: {error_msg}")
            return f"签到失败: {error_msg}", False
    else:
        logging.error(f"[{account_info}] 签到请求失败。")
        return "签到请求失败", False
def get_checkin_count(headers, member_id, account_info):
    """获取累计签到天数"""
    url = f"{BASE_URL}/sign/appSignCount"
    payload = { # 假设这个接口也需要和签到一样的 payload
        "channel": 2,
        "memberId": member_id,
        "plazaId": PLAZA_ID
    }
    result = make_request('POST', url, headers, json_payload=payload, account_info=account_info, action_desc="获取签到天数")
    if result and result.get('code') == 0 and result.get('successful'):
        count = result.get("data", 0)
        logging.info(f"[{account_info}] 累计签到: {count} 天")
        return f"累计签到 {count} 天"
    else:
        logging.warning(f"[{account_info}] 获取签到天数失败或响应格式错误。")
        return "获取签到天数失败"
def get_dynamic_game_id(headers, account_info):
    """动态获取周三活动的 Game ID"""
    url = f"{BASE_URL}/advertising/getUpList/HOP01"
    result = make_request('GET', url, headers, account_info=account_info, action_desc="获取活动广告信息 (含 Game ID)")
    if result and result.get("code") == 0 and result.get("successful"):
        ad_list = result.get("data")
        if isinstance(ad_list, list) and ad_list:
            first_ad = ad_list[0]
            jump_url_str = first_ad.get("jumpUrl")
            if jump_url_str:
                try:
                    parsed_url = urlparse(jump_url_str)
                    query_params = parse_qs(parsed_url.query)
                    game_id_list = query_params.get("gameId")
                    if game_id_list:
                        game_id = game_id_list[0]
                        logging.info(f"[{account_info}] 动态获取到周三活动 Game ID: {game_id}")
                        return game_id
                    else:
                        logging.error(f"[{account_info}] 在 jumpUrl 中未找到 gameId 参数: {jump_url_str}")
                except Exception as e:
                    logging.error(f"[{account_info}] 解析 jumpUrl 时出错: {jump_url_str}, 错误: {e}")
            else:
                logging.error(f"[{account_info}] 广告信息中缺少 jumpUrl 字段。")
        else:
            logging.error(f"[{account_info}] 广告信息列表为空或格式错误。")
    else:
        logging.error(f"[{account_info}] 获取活动广告信息失败。")
    return None # 获取失败返回 None
def share_for_draw_chance(headers, member_id, game_id, account_info):
    """通过分享增加抽奖次数 (周三)"""
    if not game_id:
        logging.warning(f"[{account_info}] 没有有效的 Game ID，无法执行分享操作。")
        return False
    url = f"{BASE_URL}/shareRecords/save"
    payload = {
        "appPageCode": "GAD03", # 这个 Code 可能需要确认是否固定
        "memberId": member_id,
        "sharedById": "",
        "sharedType": 2,
        "gameId": game_id,
        "plazaId": PLAZA_ID
    }
    result = make_request('POST', url, headers, json_payload=payload, account_info=account_info, action_desc="分享获取抽奖次数")
    # 检查分享是否成功，这里假设 code=0 表示成功，具体看 API 返回
    if result and result.get('code') == 0 and result.get('successful'):
        logging.info(f"[{account_info}] 分享操作成功。")
        return True
    else:
        logging.error(f"[{account_info}] 分享操作失败: {result.get('msg', '未知错误') if result else '请求失败'}")
        return False
def get_draw_chances(headers, game_id, account_info):
    """获取当前剩余抽奖次数"""
    if not game_id:
        logging.warning(f"[{account_info}] 没有有效的 Game ID，无法查询抽奖次数。")
        return 0
    url = f"{BASE_URL}/game/residue/{game_id}"
    result = make_request('GET', url, headers, account_info=account_info, action_desc="查询剩余抽奖次数")
    if result and result.get('code') == 0 and result.get('successful'):
        chances = result.get("data", 0)
        logging.info(f"[{account_info}] 当前剩余抽奖次数: {chances}")
        return chances
    else:
        logging.warning(f"[{account_info}] 查询剩余抽奖次数失败，假设为 0。")
        return 0
def perform_draw(headers, game_id, draw_type, account_info):
    """执行一次抽奖 (type 0: 普通抽奖, type 1: 积分兑换抽奖 - 待确认)"""
    if not game_id:
        logging.warning(f"[{account_info}] 没有有效的 Game ID，无法执行抽奖。")
        return None, "无有效 Game ID"
    # 根据原脚本逻辑区分普通抽奖和积分兑换抽奖的 URL
    # Type 0: 普通抽奖 (消耗免费或分享次数)
    # Type 1: 积分兑换抽奖 (消耗积分获取次数并抽奖 - 需要确认 API 行为)
    if draw_type == 0: # 普通抽奖
        url = f"{BASE_URL}/game/getById/{game_id}/0" # 这里的 /0 不确定含义，沿用原脚本
        action = "执行普通抽奖"
        req_method = 'GET' # 原脚本是 GET
        payload = None # 原脚本 GET 请求带了 payload，这不标准，假设不需要
    elif draw_type == 1: # 积分兑换并抽奖
        # 原脚本先调用 getIntegralGame，再调用 getById
        # 假设 getIntegralGame 是用来尝试用积分换次数的，并且如果成功会返回信息或直接扣积分
        # 然后 getById /0 是实际抽奖
        # 我们先尝试积分兑换
        exchange_url = f"{BASE_URL}/game/getIntegralGame/{game_id}"
        exchange_result = make_request('GET', exchange_url, headers, account_info=account_info, action_desc="尝试积分兑换抽奖次数")
        if not exchange_result or exchange_result.get('code') != 0:
            msg = exchange_result.get('msg', '请求失败') if exchange_result else '请求失败'
            # 特别处理次数用完的消息
            if "机会已用完" in msg or "积分不足" in msg: # 根据实际返回调整关键词
                logging.info(f"[{account_info}] 积分兑换抽奖失败: {msg}")
                return None, msg # 返回特定消息，让调用者知道原因
            else:
                logging.error(f"[{account_info}] 积分兑换抽奖请求失败或API返回错误: {msg}")
                return None, f"积分兑换失败: {msg}"
        # 如果积分兑换检查通过 (假设 API 设计如此)，再执行实际抽奖
        logging.info(f"[{account_info}] 积分兑换检查通过 (或 API 无明确拒绝)，尝试执行抽奖...")
        url = f"{BASE_URL}/game/getById/{game_id}/0"
        action = "执行积分兑换后的抽奖"
        req_method = 'GET'
        payload = None
    else:
        logging.error(f"[{account_info}] 未知的抽奖类型: {draw_type}")
        return None, "未知的抽奖类型"
    # 执行抽奖请求
    result = make_request(req_method, url, headers, json_payload=payload, account_info=account_info, action_desc=action)
    if result and result.get('code') == 0 and result.get('successful'):
        data = result.get("data", {})
        prize_message = data.get("message", "抽奖成功但未获取到奖品信息")
        logging.info(f"[{account_info}] {action} 成功: {prize_message}")
        return prize_message, "成功" # 返回奖品信息和成功状态
    else:
        error_msg = result.get('msg', '未知错误') if result else '请求失败'
        logging.error(f"[{account_info}] {action} 失败: {error_msg}")
        return None, error_msg # 返回 None 和错误消息
def handle_wednesday_draws(headers, member_id, account_info,points):
    """处理周三会员日抽奖逻辑"""
    logging.info(f"[{account_info}] 今天是周三会员日，开始处理抽奖...")
    summary = []
    # 1. 动态获取 Game ID
    # game_id = get_dynamic_game_id(headers, account_info)
    game_id = f"1899380877012918273"
    if not game_id:
        logging.error(f"[{account_info}] 无法获取周三活动 Game ID，跳过抽奖。")
        summary.append("未能获取活动 ID，跳过抽奖")
        return summary
    # 2. 尝试分享获取次数
    share_success = share_for_draw_chance(headers, member_id, game_id, account_info)
    # time.sleep(1) # 分享后稍等片刻，确保次数到账
    # 3. 获取免费/分享抽奖次数
    free_chances = get_draw_chances(headers, game_id, account_info)
    logging.info(f"[{account_info}] 获取到 {free_chances} 次免费/分享抽奖机会。")
    # 4. 执行免费/分享抽奖
    draw_count = 0
    max_free_draws = 7 # 原脚本逻辑，最多尝试 7 次免费抽奖
    while draw_count < max_free_draws and free_chances > 0:
        logging.info(f"[{account_info}] 尝试第 {draw_count + 1} 次普通抽奖...")
        prize, status = perform_draw(headers, game_id, 0, account_info)
        if status == "成功":
            summary.append(f"普通抽奖: {prize}")
            # 判断是否是实物奖品或重要奖品，发送即时通知（可选）
            if prize and "积分" not in prize and "谢谢" not in prize: # 简单判断非积分/谢谢参与
                 send_notify(f"🎉 {account_info} 周三中奖提醒", f"抽中: {prize}")
        elif "机会已用完" in status: # 根据实际返回调整
            logging.info(f"[{account_info}] 普通抽奖机会已用完。")
            break # 次数用完，跳出循环
        else:
            summary.append(f"普通抽奖失败: {status}")
            # 如果是可恢复的错误，可以考虑重试，但通常直接记录失败并继续
            # 如果是严重错误（如 token 失效），make_request 已处理
        draw_count += 1
        free_chances -= 1 # 假设每次调用消耗一次机会
        time.sleep(0) # 抽奖间隔
    # 5. 尝试积分兑换抽奖
    logging.info(f"[{account_info}] 开始尝试积分兑换抽奖...")
    integral_draw_count = 0
    max_integral_draws = 5 # 原脚本逻辑，最多尝试 5 次积分抽奖
    while integral_draw_count < max_integral_draws:
        # if points > 100:
        #     break # 积分太多了，准备积攒积分
        logging.info(f"[{account_info}] 尝试第 {integral_draw_count + 1} 次积分抽奖...")
        prize, status = perform_draw(headers, game_id, 1, account_info) # 使用类型 1
        if status == "成功":
            summary.append(f"积分抽奖: {prize}")
            if prize and "积分" not in prize and "谢谢" not in prize:
                 logging.info(f"🎉 {account_info} 周三中奖提醒 (积分)", f"抽中: {prize}")
        elif "机会已用完" in status or "积分不足" in status: # 根据实际返回调整
            logging.info(f"[{account_info}] 积分抽奖失败或无法兑换: {status}")
            summary.append(f"积分抽奖: {status}")
            break # 无法继续兑换，跳出循环
        else:
            summary.append(f"积分抽奖失败: {status}")
            # 如果失败不是因为次数或积分问题，可能需要记录并跳出
            break # 避免无限循环或消耗过多积分
        integral_draw_count += 1
        # time.sleep(0) # 抽奖间隔
    if not summary:
        summary.append("未执行任何抽奖或无结果")
    return summary
def check_unused_coupons(headers, member_id, account_info,token):
    """查询未使用的优惠券"""
    url = f"{BASE_URL}/member/getCopuonsPageList"
    payload = {
        "pageSize": 20, # 查询更多，以防万一
        "pageNumber": 1,
        "totalPages": "",
        "memberId": member_id,
        "businessType": "",
        "status": 1 # 1 表示查询 "未使用" 的券
    }
    result = make_request('POST', url, headers, json_payload=payload, account_info=account_info, action_desc="查询未使用优惠券")
    coupons = []
    if result and result.get('code') == 0 and result.get('successful'):
        data = result.get("data", {})
        items = data.get("items")
        if isinstance(items, list) and items:
            logging.info(f"[{account_info}] 查询到 {len(items)} 张未使用优惠券:")
            for item in items:
                coupon_name = item.get("couponsName")
                if coupon_name:
                    coupons.append(coupon_name)
                    logging.info(f"  - {coupon_name}")
                    # send_notify(f"✅ 爱情商业：存在优惠券", f" [{account_info}] \n{token}\n未兑换优惠券{coupon_name}")
            if not coupons:
                 logging.info(f"[{account_info}] 响应中有券，但未能提取到名称。")
        elif isinstance(items, list) and not items:
            logging.info(f"[{account_info}] 未查询到未使用的优惠券。")
        else:
            logging.warning(f"[{account_info}] 优惠券响应格式错误 (items 非列表或不存在)。")
    else:
        logging.warning(f"[{account_info}] 查询优惠券请求失败或 API 返回错误。")
    return coupons
# --- 主函数 ---
def main():
    if not ACCOUNTS:
        logging.error("环境变量 'WEAIOVE_ACCOUNTS' 未设置或格式错误。")
        send_notify("❌ 爱情商业配置错误", "未找到有效的账号配置，请检查环境变量 WEAIOVE_ACCOUNTS")
        return
    total_accounts = len(ACCOUNTS)
    logging.info(f"共找到 {total_accounts} 个账号配置。")
    logging.info(f"通知将每 {NOTIFY_CHUNK_SIZE} 个账号分段发送。")
    chunk_messages = [] # 用于存储当前分段的账号消息
    overall_summary = []
    start_account_index_for_chunk = 1 # 当前分段的起始账号序号
    for index, account_str in enumerate(ACCOUNTS, 1):
        parts = account_str.split('|')
        if len(parts) != 2 or not parts[0] or not parts[1]:
            logging.error(f"账号 {index} 配置格式错误，已跳过: '{account_str}'")
            account_summary_str = f"账号 {index}: 配置格式错误，跳过"
            chunk_messages.append(account_summary_str) # 错误信息也加入当前段落
            # 检查是否需要发送当前分段
            if len(chunk_messages) >= NOTIFY_CHUNK_SIZE or index == total_accounts:
                chunk_title = f"💖 爱情商业报告 (账号 {start_account_index_for_chunk}-{index})"
                chunk_content = "\n\n====================\n\n".join(chunk_messages)
                send_notify(chunk_title, chunk_content)
                chunk_messages = [] # 清空列表，为下一段准备
                start_account_index_for_chunk = index + 1 # 更新下一段的起始序号
            continue # 处理下一个账号
        token, name = parts[0].strip(), parts[1].strip()
        account_info = f"账号 {index} ({name})"
        logging.info(f"\n--- 开始处理 {account_info} ---")
        headers = {
            "Host": "vip.weaiove.com",
            "tenant-Id": TENANT_ID,
            "plaza-Id": PLAZA_ID,
            "appkey": APPKEY,
            "member-token": token,
            "content-type": "application/json;charset=utf-8",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.56(0x1800383b) NetType/WIFI Language/zh_CN",
            "Referer": f"https://servicewechat.com/{APPKEY}/72/page-frame.html"
        }
        account_summary = [f"👤 {account_info}"] # 使用列表存储单个账号的消息行
        current_time_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        account_summary.append(f"🕕 处理时间: {current_time_str}")
        # 1. 获取用户基本信息
        member_id, phone_or_error = get_user_details(headers, account_info)
        if not member_id:
            logging.error(f"{account_info}: 获取 Member ID 失败: {phone_or_error}，无法继续处理此账号。")
            account_summary.append(f"❌ 错误: 获取用户信息失败 ({phone_or_error})")
            # 将当前账号的错误汇总信息加入分段列表
            chunk_messages.append("\n".join(account_summary))
            # 检查是否需要发送当前分段
            if len(chunk_messages) >= NOTIFY_CHUNK_SIZE or index == total_accounts:
                chunk_title = f"💖 爱情商业报告 (账号 {start_account_index_for_chunk}-{index})"
                chunk_content = "\n\n====================\n\n".join(chunk_messages)
                send_notify(chunk_title, chunk_content)
                chunk_messages = [] # 清空列表
                start_account_index_for_chunk = index + 1
            continue # 跳过此账号的后续操作
        account_summary[0] = f"👤 {account_info} (手机号: {phone_or_error})" # 更新包含手机号的标题行
        # 2. 执行签到
        sign_message, _ = perform_checkin(headers, member_id, account_info)
        account_summary.append(f"📌 签到状态: {sign_message}")
        # 3. 获取签到天数
        checkin_count_msg = get_checkin_count(headers, member_id, account_info)
        account_summary.append(f"📅 {checkin_count_msg}")
        # 4. 获取用户详细信息
        user_info = get_user_info(headers, member_id, account_info)
        if user_info:
            account_summary.append(f"⭐ 等级: {user_info['level']}")
            account_summary.append(f"💰 积分: {user_info['points']}")
            account_summary.append(f"📈 成长值: {user_info['total_growth']} (距下级差 {user_info['growth_diff']})") # 简化显示
        else:
            account_summary.append("⚠️ 获取用户详细信息失败")
        # 5. 周三会员日处理
        points = f"{user_info['points']}"
        today_weekday = datetime.now().isoweekday()
        if today_weekday == 3:
            draw_summary = handle_wednesday_draws(headers, member_id, account_info,points)
            account_summary.append("\n--- 周三会员日抽奖结果 ---")
            account_summary.extend(draw_summary)
            account_summary.append("--------------------------")
        # 6. 查询未使用优惠券
        unused_coupons = check_unused_coupons(headers, member_id, account_info,token)
        if unused_coupons:
            account_summary.append("\n--- 🎟️ 未使用优惠券 ---")
            account_summary.extend([f"- {c}" for c in unused_coupons]) # 列表推导式更简洁
            account_summary.append("-----------------------")
        else:
            account_summary.append("🎟️ 未发现未使用优惠券")
        # 7. 将当前账号的完整结果添加到分段消息列表
        overall_summary.append("\n".join(account_summary))
        chunk_messages.append("\n".join(account_summary))
        logging.info(f"--- {account_info} 处理完毕 ---")
        # 8. 检查是否需要发送当前分段的通知
        if len(chunk_messages) >= NOTIFY_CHUNK_SIZE or index == total_accounts:
            chunk_title = f"💖 爱情商业报告 (账号 {start_account_index_for_chunk}-{index})"
            chunk_content = "\n\n====================\n\n".join(chunk_messages)
            send_notify(chunk_title, chunk_content)
            chunk_messages = [] # 清空，为下一段准备
            start_account_index_for_chunk = index + 1 # 更新下一段的起始序号
        # 每个账号处理后等待，防止请求过于频繁
        # time.sleep(0)
    # --- 所有账号处理完毕 ---
    # 注意：不再有最终的汇总发送，因为消息已在循环中分段发送
    if overall_summary:
        final_title = f"💖 爱情商业任务报告 ({datetime.now().strftime('%Y-%m-%d')})"
        final_content = "\n\n====================\n\n".join(overall_summary)
        #send_notify(final_title, final_content)
        logging.info(f"{final_title}{final_content}")
        #logging.info("\n=== 所有账号处理完毕 ===")
    logging.info("\n=== 所有账号处理完毕 ===")
    if not ACCOUNTS: # 如果一开始就没有账号，也打印日志
        logging.info("\n=== 未处理任何账号 ===")
if __name__ == "__main__":
    main()
