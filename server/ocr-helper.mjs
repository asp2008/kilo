/**
 * OCR 辅助模块 — 多候选预处理 + Tesseract 识别
 * 移植自参考 Python 脚本的 build_candidates + ocr_with_candidates
 *
 * Jimp v1.x 使用具名导出（无 default export）
 */

import { Jimp, JimpMime, ResizeStrategy } from 'jimp'
import { createWorker } from 'tesseract.js'

const CAPTCHA_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

// ─── 单次 Tesseract OCR ───────────────────────────────────────────────────────
async function tessOcr(imgBuffer) {
  const worker = await createWorker('eng')
  try {
    await worker.setParameters({
      tessedit_char_whitelist: CAPTCHA_WHITELIST,
      tessedit_pageseg_mode: '8',
    })
    const { data: { text } } = await worker.recognize(imgBuffer)
    return text.replace(/[^A-Z0-9]/gi, '').toUpperCase()
  } finally {
    await worker.terminate()
  }
}

// ─── 多候选预处理（对应 Python build_candidates）────────────────────────────
async function buildCandidates(inputBuffer) {
  const candidates = []

  const base = await Jimp.read(inputBuffer)
  const w = base.bitmap.width
  const h = base.bitmap.height

  // 放大 6 倍 + 灰度
  const enlarged = base.clone()
    .resize({ w: w * 6, h: h * 6 })
    .greyscale()

  const thresholds = [120, 140, 160, 180, 200]

  for (const thr of thresholds) {
    // 正向二值化
    const bw = enlarged.clone()
    bw.scan((x, y, idx) => {
      const v = bw.bitmap.data[idx]
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

  // 软化候选（高斯模糊 + 二值化）
  const soft = enlarged.clone().blur(1)
  soft.scan((x, y, idx) => {
    const v = soft.bitmap.data[idx]
    const out = v > 150 ? 255 : 0
    soft.bitmap.data[idx] = out
    soft.bitmap.data[idx + 1] = out
    soft.bitmap.data[idx + 2] = out
  })
  candidates.push({ label: 'soft', img: soft })

  return candidates
}

// ─── 多候选 OCR（对应 Python ocr_with_candidates）───────────────────────────
/**
 * @param {Buffer} imageBuffer  原始验证码图片 Buffer
 * @param {number} expectedLen  期望验证码长度，达到即提前返回
 * @returns {{ text: string, logs: {label:string, text:string}[] }}
 */
export async function multiCandidateOcr(imageBuffer, expectedLen = 4) {
  const logs = []
  let bestText = ''

  const candidates = await buildCandidates(imageBuffer)

  for (const { label, img } of candidates) {
    const buf = await img.getBuffer(JimpMime.png)
    const text = await tessOcr(buf).catch(() => '')
    logs.push({ label, text })

    if (text.length >= expectedLen) {
      return { text, logs }
    }
    if (text.length > bestText.length) bestText = text
  }

  return { text: bestText, logs }
}

/** 简单单次 OCR */
export async function simpleOcr(imageBuffer) {
  return tessOcr(imageBuffer)
}
