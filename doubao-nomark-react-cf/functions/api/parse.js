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
    let targetUrl = ''

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      targetUrl = body.url || body.text || ''
    } else {
      const url = new URL(request.url)
      targetUrl = url.searchParams.get('url') || ''
    }

    if (!targetUrl) {
      return json({ success: false, error: '缺少链接参数' }, 400)
    }

    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'referer': 'https://www.doubao.com/',
      },
    })

    const html = await response.text()

    if (!html || typeof html !== 'string') {
      return json({ success: false, error: '豆包页面返回为空' }, 500)
    }

    const matched =
      html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i) ||
      html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/i) ||
      html.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});/i)

    if (!matched?.[1]) {
      return json({
        success: false,
        error: '无法解析页面数据，请确认链接是否有效，或页面结构已变化',
        debug: html.slice(0, 500),
      }, 500)
    }

    let data
    try {
      data = JSON.parse(matched[1])
    } catch (e) {
      return json({
        success: false,
        error: '页面中的 JSON 数据解析失败',
        debug: matched[1].slice(0, 500),
      }, 500)
    }

    const images = []
    const seen = new Set()

    function walk(value) {
      if (!value) return

      if (Array.isArray(value)) {
        for (const item of value) walk(item)
        return
      }

      if (typeof value === 'object') {
        for (const [, v] of Object.entries(value)) {
          if (
            typeof v === 'string' &&
            /^https?:\/\//i.test(v) &&
            /\.(png|jpe?g|webp|gif)(\?|$)/i.test(v)
          ) {
            if (!seen.has(v)) {
              seen.add(v)
              images.push(v)
            }
          }
          walk(v)
        }
      }
    }

    walk(data)

    if (!images.length) {
      return json({
        success: false,
        error: '未找到图片资源',
        debug: data,
      }, 404)
    }

    return json({
      success: true,
      type: 'image',
      count: images.length,
      images,
    })
  } catch (error) {
    return json({
      success: false,
      error: error?.message || '图片解析失败',
    }, 500)
  }
}
