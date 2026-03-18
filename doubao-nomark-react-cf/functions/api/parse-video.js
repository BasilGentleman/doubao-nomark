function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    },
  })
}

function extractVideoId(input) {
  if (!input) return null

  try {
    const url = new URL(input)
    const pathname = url.pathname || ''
    const match = pathname.match(/\/video\/(\d+)/) || pathname.match(/\/(\d+)/)
    if (match?.[1]) return match[1]

    const groupId = url.searchParams.get('group_id')
    if (groupId) return groupId
  } catch (_) {
    const match = String(input).match(/(\d{6,})/)
    if (match?.[1]) return match[1]
  }

  return null
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    },
  })
}

export async function onRequestGet(context) {
  return handleRequest(context.request)
}

export async function onRequestPost(context) {
  return handleRequest(context.request)
}

async function handleRequest(request) {
  try {
    let input = ''

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      input = body.url || body.text || ''
    } else {
      const url = new URL(request.url)
      input = url.searchParams.get('url') || ''
    }

    if (!input) {
      return json({ success: false, error: '缺少视频链接' }, 400)
    }

    const videoId = extractVideoId(input)
    if (!videoId) {
      return json({ success: false, error: '无法提取视频 ID，请检查链接是否正确' }, 400)
    }

    const apiUrl = `https://www.doubao.com/web/api/v2/playlet/get_video_share_info?video_id=${videoId}`

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'user-agent': 'Mozilla/5.0',
        'referer': 'https://www.doubao.com/',
      },
    })

    const rawText = await response.text()

    let result
    try {
      result = JSON.parse(rawText)
    } catch (e) {
      return json({
        success: false,
        error: '豆包视频接口返回的不是 JSON，可能是接口变更、被拦截，或返回了 HTML 错误页',
        debug: rawText.slice(0, 500),
      }, 500)
    }

    const playInfo = result?.data?.play_info || result?.data?.video_info || null
    const videoUrl =
      playInfo?.url ||
      playInfo?.play_url ||
      playInfo?.video_url ||
      result?.data?.url ||
      null

    if (!videoUrl) {
      return json({
        success: false,
        error: '无法获取视频播放信息，请检查链接是否有效',
        debug: result,
      }, 500)
    }

    return json({
      success: true,
      type: 'video',
      video_id: videoId,
      video_url: videoUrl,
      raw: result,
    })
  } catch (error) {
    return json({
      success: false,
      error: error?.message || '视频解析失败',
    }, 500)
  }
}
