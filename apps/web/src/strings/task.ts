/** 任務：清單、看板、詳情、關聯用到的文字。寫法見 strings/index.ts */
export const task = {
  problem: {
    label: '目前遇到的問題',
    badge: '有問題',
    tooltip: (text: string) => `目前遇到的問題：${text}`,
  },
} as const
