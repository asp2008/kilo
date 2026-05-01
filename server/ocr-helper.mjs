/**
 * OCR 辅助模块 — 移植自 Python 参考脚本
 * 图片预处理：放大 6x + 多阈值二值化 + 中值平滑 → 多候选 → 取最长/最佳结果
 */
import { createRequire } from 'module'
import { createWorker } from 'tesseract.js'
import Jimp from 'jimp'

const CAPTCHA_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/**
 * 生成多个预处理候选图片（Buffer[]）
 * 对应 Python 的 build_candidates()
 */
async function buildCandidates(inputBuffer) {
  const candidates = []

  // 加载原图
  const base = await Jimp.read(inputBuffer)
  const w = base.bitmap.width
  const h = base.bitmap.height

  // 放大 6 倍
  const enlarged = base.clone().resize(w * 6, h * 6, Jimp.RESIZE_LANCZOS3)

  // 转灰度 + 增强对比度
  enlarged.grayscale()

  // 多阈值二值化
  const thresholds = [120, 140, 160, 180, 200]
  for (const thr of thresholds) {
    // 正向二值化
    const bw = enlarged.clone()
    bw.scan(0, 0, bw.bitmap.width, bw.bitmap.height, (x, y, idx) => {
      const v = bw.bitmap.data[idx] // R channel (grayscale)
      const out = v > thr ? 255 : 0
      bw.bitmap.data[idx] = out
      bw.bitmap.data[idx + 1] = out
      bw.bitmap.data[idx + 2] = out
    })
    candidates.push({ label: `bw-${thr}`, img: bw })

    // 反向
    const inv = bw.clone().invert()
    candidates.push({ label: `inv-${thr}`, img: inv })
  }

  return candidates
}

/**
 * 使用 Tesseract.js 识别单张图片 Buffer
 */
async function tessOcr(imgBuffer) {
  const worker = await createWorker('eng')
  try {
    await worker.setParameters({
      tessedit_char_whitelist: CAPTCHA_WHITELIST,
      tessedit_pageseg_mode: '8', // single word
    })
    const { data: { text } } = await worker.recognize(imgBuffer)
    return text.replace(/[^A-Z0-9]/gi, '').toUpperCase()
  } finally {
    await worker.terminate()
  }
}

/**
 * 多候选 OCR，返回最佳结果
 * 对应 Python 的 ocr_with_candidates()
 *
 * @param {Buffer} imageBuffer - 原始图片 Buffer
 * @param {number} expectedLen - 期望验证码长度（默认 4）
 * @returns {{ text: string, logs: {label:string, text:string}[] }}
 */
export async function multiCandidateOcr(imageBuffer, expectedLen = 4) {
  const logs = []
  let bestText = ''

  const candidates = await buildCandidates(imageBuffer)

  for (const { label, img } of candidates) {
    const buf = await img.getBufferAsync(Jimp.MIME_PNG)
    const text = await tessOcr(buf).catch(() => '')
    logs.push({ label, text })

    if (text.length >= expectedLen) {
      return { text, logs }
    }
    if (text.length > bestText.length) bestText = text
  }

  return { text: bestText, logs }
}

/**
 * 简单的单次 OCR（无多候选）
 */
export async function simpleOcr(imageBuffer) {
  return tessOcr(imageBuffer)
}
