import { useMemo, useState } from 'react'
import './styles.css'

export default function App() {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const isVideo = useMemo(() => /video|group_id|\d{6,}/i.test(input), [input])

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    setResult(null)

    try {
      const api = isVideo ? '/api/parse-video' : '/api/parse'

      const response = await fetch(api, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: input }),
      })

      const rawText = await response.text()

      let data
      try {
        data = JSON.parse(rawText)
      } catch (e) {
        throw new Error(`接口返回的不是 JSON：${rawText.slice(0, 200)}`)
      }

      if (!response.ok || !data.success) {
        throw new Error(data.error || '请求失败')
      }

      setResult(data)
    } catch (err) {
      setError(err?.message || '解析失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <div className="container">
        <h1>Doubao NoMark React</h1>
        <p className="desc">输入豆包图片或视频链接进行解析</p>

        <form onSubmit={handleSubmit} className="card">
          <textarea
            className="input"
            rows={6}
            placeholder="粘贴豆包链接"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button className="button" type="submit" disabled={loading || !input.trim()}>
            {loading ? '解析中...' : '开始解析'}
          </button>
        </form>

        {error ? (
          <div className="card error">
            <strong>错误：</strong>
            <div>{error}</div>
          </div>
        ) : null}

        {result?.type === 'image' ? (
          <div className="card">
            <h2>解析结果</h2>
            <p>共找到 {result.count} 张图片</p>
            <div className="grid">
              {result.images?.map((img, idx) => (
                <a key={idx} href={img} target="_blank" rel="noreferrer" className="imageItem">
                  <img src={img} alt={`image-${idx}`} />
                </a>
              ))}
            </div>
          </div>
        ) : null}

        {result?.type === 'video' ? (
          <div className="card">
            <h2>解析结果</h2>
            <p>视频 ID：{result.video_id}</p>
            <video className="video" src={result.video_url} controls playsInline />
            <a href={result.video_url} target="_blank" rel="noreferrer" className="link">
              打开视频直链
            </a>
          </div>
        ) : null}
      </div>
    </div>
  )
}
