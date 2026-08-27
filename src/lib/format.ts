/** "1:02:03" / "12:34" / "90" -> seconden, null bij onzin. Spiegelt de parser in main. */
export function parseTime(raw: string): number | null {
  const s = (raw ?? '').trim().replace(',', '.')
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const parts = s.split(':')
  if (parts.length < 2 || parts.length > 3) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => Number.isNaN(n) || n < 0)) return null
  return parts.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2]
}

export function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return ''
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return '—'
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatDate(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return ''
  return `${yyyymmdd.slice(6, 8)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(0, 4)}`
}

export function isProbablyUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim())
}
