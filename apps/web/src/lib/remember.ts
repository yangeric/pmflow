import { useCallback, useState } from 'react'

/**
 * 記得住的畫面開關。
 *
 * 行事曆的「任務／期望回覆日／請假」、關聯圖的「任務相關／卡住／並行」這些勾選，
 * 是**使用者對「我想看什麼」的長期偏好**，不是這一次瀏覽的暫時狀態。
 * 每次切走再回來就重設，等於逼他每天重勾一次。
 *
 * 存 localStorage 不存後端：跟深色模式同一個理由（見 lib/theme.tsx）——
 * 這是「這台裝置上我習慣怎麼看」，不是帳號屬性。辦公室的大螢幕想開著並行、
 * 筆電上嫌擠想關掉，是很正常的事，存進帳號反而會互相蓋掉。
 *
 * 讀不到或壞掉就退回預設值，不要讓一個壞掉的偏好把畫面弄到開不起來。
 */
const PREFIX = 'pmflow.pref.'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    // 隱私模式下 localStorage 會直接丟例外；存過的值也可能是舊版本留下的壞資料
    return fallback
  }
}

export function useRemembered<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback))

  const set = useCallback((v: T) => {
    setValue(v)
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(v))
    } catch {
      // 存不進去就只有這次有效，不值得為它中斷操作
    }
  }, [key])

  return [value, set]
}
